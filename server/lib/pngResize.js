'use strict';

const zlib = require('node:zlib');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_SIDE = 4096;
const MAX_PIXELS = 16 * 1024 * 1024;
const SHRINK_STEPS = [96, 64, 48, 32];

class PngError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

function readChunks(buf) {
  if (buf.length < 8 + 12 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new PngError(400, 'icon must be a PNG image');
  const chunks = [];
  let off = 8;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    if (len > buf.length - off - 12) throw new PngError(400, 'icon is not a valid PNG (truncated)');
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if ((zlib.crc32(buf.subarray(off + 4, off + 8 + len)) >>> 0) !== buf.readUInt32BE(off + 8 + len)) throw new PngError(400, 'icon is not a valid PNG (bad checksum)');
    chunks.push({ type, data });
    off += 12 + len;
    if (type === 'IEND') break;
  }
  if (!chunks.length || chunks[0].type !== 'IHDR' || chunks[chunks.length - 1].type !== 'IEND') throw new PngError(400, 'icon is not a valid PNG');
  return chunks;
}

const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

// PNG -> RGBA8. Interlaced files are refused; metadata chunks are ignored.
function decode(buf) {
  const chunks = readChunks(buf);
  const ihdr = chunks[0].data;
  if (ihdr.length !== 13) throw new PngError(400, 'icon is not a valid PNG');
  const width = ihdr.readUInt32BE(0); const height = ihdr.readUInt32BE(4);
  const depth = ihdr[8]; const color = ihdr[9];
  if (!width || !height) throw new PngError(400, 'icon is not a valid PNG');
  if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) throw new PngError(413, `icon is larger than ${MAX_SIDE}x${MAX_SIDE} pixels`);
  if (!CHANNELS[color] || !DEPTHS[color].includes(depth) || ihdr[10] !== 0 || ihdr[11] !== 0) throw new PngError(400, 'unsupported PNG type');
  if (ihdr[12] !== 0) throw new PngError(400, 'interlaced PNG is not supported: save the image without interlacing');
  const plte = chunks.find((c) => c.type === 'PLTE');
  if (color === 3 && (!plte || plte.data.length % 3 !== 0 || !plte.data.length)) throw new PngError(400, 'icon is not a valid PNG (no palette)');
  const trns = chunks.find((c) => c.type === 'tRNS');

  const bits = CHANNELS[color] * depth;
  const bpp = Math.max(1, bits >> 3);
  const rowBytes = Math.ceil((width * bits) / 8);
  const expected = (rowBytes + 1) * height;
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)), { maxOutputLength: expected }); } catch { throw new PngError(400, 'icon is not a valid PNG (bad image data)'); }
  if (raw.length !== expected) throw new PngError(400, 'icon is not a valid PNG (bad image data)');

  const rows = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (rowBytes + 1)];
    const src = y * (rowBytes + 1) + 1;
    const dst = y * rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const cur = raw[src + x];
      const left = x >= bpp ? rows[dst + x - bpp] : 0;
      const up = y > 0 ? rows[dst - rowBytes + x] : 0;
      const upLeft = y > 0 && x >= bpp ? rows[dst - rowBytes + x - bpp] : 0;
      let v;
      if (filter === 0) v = cur;
      else if (filter === 1) v = cur + left;
      else if (filter === 2) v = cur + up;
      else if (filter === 3) v = cur + ((left + up) >> 1);
      else if (filter === 4) v = cur + paeth(left, up, upLeft);
      else throw new PngError(400, 'icon is not a valid PNG (bad filter)');
      rows[dst + x] = v & 0xff;
    }
  }

  const rgba = Buffer.alloc(width * height * 4);
  const sample = (row, index) => {
    if (depth === 8) return row[index];
    if (depth === 16) return row[index * 2];
    const perByte = 8 / depth;
    const byte = row[Math.floor(index / perByte)];
    const shift = 8 - depth * ((index % perByte) + 1);
    return (byte >> shift) & ((1 << depth) - 1);
  };
  const scale = depth < 8 ? 255 / ((1 << depth) - 1) : 1;
  for (let y = 0; y < height; y++) {
    const row = rows.subarray(y * rowBytes, (y + 1) * rowBytes);
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (color === 3) {
        const i = sample(row, x);
        if (i * 3 + 2 >= plte.data.length) throw new PngError(400, 'icon is not a valid PNG (bad palette index)');
        rgba[o] = plte.data[i * 3]; rgba[o + 1] = plte.data[i * 3 + 1]; rgba[o + 2] = plte.data[i * 3 + 2];
        rgba[o + 3] = trns && i < trns.data.length ? trns.data[i] : 255;
      } else if (color === 0) {
        const g = Math.round(sample(row, x) * scale);
        rgba[o] = g; rgba[o + 1] = g; rgba[o + 2] = g; rgba[o + 3] = 255;
      } else if (color === 4) {
        const g = sample(row, x * 2);
        rgba[o] = g; rgba[o + 1] = g; rgba[o + 2] = g; rgba[o + 3] = sample(row, x * 2 + 1);
      } else if (color === 2) {
        rgba[o] = sample(row, x * 3); rgba[o + 1] = sample(row, x * 3 + 1); rgba[o + 2] = sample(row, x * 3 + 2); rgba[o + 3] = 255;
      } else {
        rgba[o] = sample(row, x * 4); rgba[o + 1] = sample(row, x * 4 + 1); rgba[o + 2] = sample(row, x * 4 + 2); rgba[o + 3] = sample(row, x * 4 + 3);
      }
    }
  }
  return { width, height, rgba };
}

// Area average with premultiplied alpha, so transparent edges do not bleed colour into the picture.
function shrink({ width, height, rgba }, maxSide) {
  const factor = Math.max(width, height) / maxSide;
  if (factor <= 1) return { width, height, rgba };
  const w = Math.max(1, Math.round(width / factor)); const h = Math.max(1, Math.round(height / factor));
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * height) / h); const y1 = Math.max(y0 + 1, Math.ceil(((y + 1) * height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * width) / w); const x1 = Math.max(x0 + 1, Math.ceil(((x + 1) * width) / w));
      let r = 0; let g = 0; let b = 0; let a = 0; let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * width + xx) * 4;
          const al = rgba[i + 3];
          r += rgba[i] * al; g += rgba[i + 1] * al; b += rgba[i + 2] * al; a += al; n += 1;
        }
      }
      const o = (y * w + x) * 4;
      if (a > 0) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); }
      out[o + 3] = Math.round(a / n);
    }
  }
  return { width: w, height: h, rgba: out };
}

const chunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0);
  return Buffer.concat([head, data, crc]);
};

function encode({ width, height, rgba }) {
  const stride = width * 4;
  const out = Buffer.alloc((stride + 1) * height);
  const filtered = [Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride)];
  for (let y = 0; y < height; y++) {
    let best = 0; let bestScore = Infinity;
    for (let f = 0; f < 4; f++) {
      const type = [0, 1, 2, 4][f];
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const cur = rgba[y * stride + x];
        const left = x >= 4 ? rgba[y * stride + x - 4] : 0;
        const up = y > 0 ? rgba[(y - 1) * stride + x] : 0;
        const upLeft = y > 0 && x >= 4 ? rgba[(y - 1) * stride + x - 4] : 0;
        const pred = type === 0 ? 0 : type === 1 ? left : type === 2 ? up : paeth(left, up, upLeft);
        const v = (cur - pred) & 0xff;
        filtered[f][x] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) { bestScore = score; best = f; }
    }
    out[y * (stride + 1)] = [0, 1, 2, 4][best];
    filtered[best].copy(out, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(out, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// Any non-interlaced PNG -> a clean RGBA PNG that fits in maxPx x maxPx and maxBytes (smaller sizes are tried
// until it fits). Ancillary chunks (text, colour profiles, ...) are dropped.
function makeIcon(buf, { maxPx = 128, maxBytes = 16384 } = {}) {
  const image = decode(buf);
  for (const side of [maxPx, ...SHRINK_STEPS.filter((s) => s < maxPx)]) {
    const png = encode(shrink(image, side));
    if (png.length <= maxBytes) return png;
  }
  throw new PngError(413, 'the icon cannot be made small enough: use a simpler image');
}

module.exports = { makeIcon, decode, encode, shrink, PngError, MAX_SIDE };
