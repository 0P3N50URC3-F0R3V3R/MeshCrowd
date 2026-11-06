'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { deriveKey } = require('./atRest');

// DM attachment files are stored sealed on disk: a 12 byte header (magic + random nonce base) followed
// by independent AES-256-GCM chunks of 64 KiB, each with its own nonce (base + chunk number) and a
// 16 byte tag. Independent chunks keep integrity checks and let audio/video seek (HTTP Range) without
// decrypting the whole file. Plain bytes never touch the disk when uploads come in through
// sealedDiskStorage below.
const MAGIC = Buffer.from('DMF1');
const HEADER = 12;
const CHUNK = 64 * 1024;
const TAG = 16;
const SEALED_CHUNK = CHUNK + TAG;

let key = null;
const fileKey = () => key || (key = deriveKey('dm-files'));

const nonceFor = (base, index) => {
  const n = Buffer.alloc(12);
  base.copy(n, 0, 0, 8);
  n.writeUInt32BE(index, 8);
  return n;
};

function sealChunk(base, index, plain) {
  const cipher = crypto.createCipheriv('aes-256-gcm', fileKey(), nonceFor(base, index));
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([ct, cipher.getAuthTag()]);
}

function openChunk(base, index, sealed) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', fileKey(), nonceFor(base, index));
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG));
  return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG)), decipher.final()]);
}

// Resolves with the number of plain bytes written.
function sealStreamTo(readable, destPath) {
  return new Promise((resolve, reject) => {
    const base = crypto.randomBytes(8);
    const out = fs.createWriteStream(destPath, { mode: 0o600 });
    let pending = Buffer.alloc(0);
    let index = 0;
    let total = 0;
    const sealer = new Transform({
      transform(data, _enc, cb) {
        total += data.length;
        pending = Buffer.concat([pending, data]);
        while (pending.length >= CHUNK) {
          this.push(sealChunk(base, index++, pending.subarray(0, CHUNK)));
          pending = pending.subarray(CHUNK);
        }
        cb();
      },
      flush(cb) {
        if (pending.length) this.push(sealChunk(base, index++, pending));
        cb();
      },
    });
    const fail = (err) => { out.destroy(); fs.rm(destPath, { force: true }, () => reject(err)); };
    out.write(Buffer.concat([MAGIC, base]));
    readable.on('error', fail);
    sealer.on('error', fail);
    out.on('error', fail);
    out.on('finish', () => resolve(total));
    readable.pipe(sealer).pipe(out);
  });
}

const sealBufferTo = (buf, destPath) => sealStreamTo(Readable.from([buf]), destPath);

// Same format, written synchronously (federation inbox handlers are synchronous).
function sealBufferSync(buf, destPath) {
  const base = crypto.randomBytes(8);
  const parts = [MAGIC, base];
  for (let i = 0, at = 0; at < buf.length; i++, at += CHUNK) parts.push(sealChunk(base, i, buf.subarray(at, at + CHUNK)));
  fs.writeFileSync(destPath, Buffer.concat(parts), { mode: 0o600 });
  return buf.length;
}

// Seals an existing plain file into `destPath` chunk by chunk (migration), without loading it whole.
function sealFileSync(srcPath, destPath) {
  const base = crypto.randomBytes(8);
  const inFd = fs.openSync(srcPath, 'r');
  const outFd = fs.openSync(destPath, 'w', 0o600);
  try {
    fs.writeSync(outFd, Buffer.concat([MAGIC, base]));
    const buf = Buffer.alloc(CHUNK);
    let total = 0;
    for (let i = 0; ; i++) {
      const n = fs.readSync(inFd, buf, 0, CHUNK, i * CHUNK);
      if (!n) break;
      fs.writeSync(outFd, sealChunk(base, i, buf.subarray(0, n)));
      total += n;
    }
    return total;
  } finally { fs.closeSync(inFd); fs.closeSync(outFd); }
}

function isSealedFile(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(4);
    return fs.readSync(fd, head, 0, 4, 0) === 4 && head.equals(MAGIC);
  } catch { return false; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function plainSize(file) {
  const total = fs.statSync(file).size - HEADER;
  const full = Math.floor(total / SEALED_CHUNK);
  const rest = total % SEALED_CHUNK;
  return full * CHUNK + (rest ? rest - TAG : 0);
}

// Plain bytes [start, end] (inclusive) of a sealed file, as a stream.
function readSealedRange(file, start, end) {
  const size = plainSize(file);
  const last = Math.min(end, size - 1);
  async function* gen() {
    const fd = await fs.promises.open(file, 'r');
    try {
      const head = Buffer.alloc(HEADER);
      await fd.read(head, 0, HEADER, 0);
      const base = head.subarray(4, 12);
      for (let i = Math.floor(start / CHUNK); i * CHUNK <= last; i++) {
        const buf = Buffer.alloc(SEALED_CHUNK);
        const { bytesRead } = await fd.read(buf, 0, SEALED_CHUNK, HEADER + i * SEALED_CHUNK);
        if (!bytesRead) break;
        const plain = openChunk(base, i, buf.subarray(0, bytesRead));
        const from = Math.max(0, start - i * CHUNK);
        const to = Math.min(plain.length, last - i * CHUNK + 1);
        yield plain.subarray(from, to);
      }
    } finally { await fd.close(); }
  }
  return Readable.from(gen());
}

function readAll(file) {
  if (!isSealedFile(file)) return fs.readFileSync(file);
  const size = plainSize(file);
  if (!size) return Buffer.alloc(0);
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(HEADER);
    fs.readSync(fd, head, 0, HEADER, 0);
    const base = head.subarray(4, 12);
    const parts = [];
    for (let i = 0; i * CHUNK < size; i++) {
      const buf = Buffer.alloc(SEALED_CHUNK);
      const n = fs.readSync(fd, buf, 0, SEALED_CHUNK, HEADER + i * SEALED_CHUNK);
      parts.push(openChunk(base, i, buf.subarray(0, n)));
    }
    return Buffer.concat(parts);
  } finally { fs.closeSync(fd); }
}

// multer storage engine: the upload is sealed while it streams to disk.
function sealedDiskStorage({ destination, filename }) {
  return {
    _handleFile(req, file, cb) {
      try {
        const dir = destination(req, file);
        fs.mkdirSync(dir, { recursive: true });
        const name = filename(req, file);
        const dest = path.join(dir, name);
        sealStreamTo(file.stream, dest).then((size) => cb(null, { destination: dir, filename: name, path: dest, size }), cb);
      } catch (err) { cb(err); }
    },
    _removeFile(req, file, cb) { fs.rm(file.path, { force: true }, cb); },
  };
}

module.exports = { sealStreamTo, sealBufferTo, sealBufferSync, sealFileSync, isSealedFile, plainSize, readSealedRange, readAll, sealedDiskStorage };
