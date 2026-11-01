'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { db, DATA_DIR } = require('../db');
const config = require('./config');
const schema = require('./configSchema');
const logger = require('./logger');

const log = logger.scoped('backup');

const REASONS = ['manual', 'scheduled', 'pre-restore'];
const NAME_RE = /^backup-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d{3})-(manual|scheduled|pre-restore)\.zip$/;
const MEDIA_DIRS = ['avatars', 'banners', 'cards', 'emoji', 'stickers', 'sounds', 'servericons', 'channelicons', 'foldericons', 'roleicons', 'threadicons', 'webhookicons'];
const DB_ENTRY = 'db/dismesh.db';
const REDACTED = '[redacted]';
const MAX_ENTRIES = 200000;
const MAX_ENTRY_BYTES = 0x7fffffff;

function backupsDirOf(opts) { return (opts && opts.backupsDir) || path.join(DATA_DIR, 'backups'); }
function dataDirOf(opts) { return (opts && opts.dataDir) || DATA_DIR; }
function isLive(dataDir) { return path.resolve(dataDir) === path.resolve(DATA_DIR); }

function checkName(name) {
  const m = typeof name === 'string' ? NAME_RE.exec(name) : null;
  if (!m) throw new Error('invalid backup name');
  return m;
}

function parseName(name) {
  const m = checkName(name);
  return { createdAt: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7])).toISOString(), reason: m[8] };
}

function makeName(reason, dir) {
  let t = Date.now();
  for (;;) {
    const d = new Date(t);
    const p = (n, w = 2) => String(n).padStart(w, '0');
    const name = `backup-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}-${p(d.getUTCMilliseconds(), 3)}-${reason}.zip`;
    if (!fs.existsSync(path.join(dir, name))) return name;
    t++;
  }
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function secretPaths() {
  return Object.entries(schema.describe()).filter(([, s]) => s.secret).map(([k]) => k.split('.'));
}

function getPath(obj, parts) {
  return parts.reduce((o, p) => (o && typeof o === 'object' ? o[p] : undefined), obj);
}

function setPath(obj, parts, value) {
  let o = obj;
  for (const p of parts.slice(0, -1)) {
    if (!o[p] || typeof o[p] !== 'object') o[p] = {};
    o = o[p];
  }
  o[parts[parts.length - 1]] = value;
}

function redactConfig(cfg) {
  const copy = JSON.parse(JSON.stringify(cfg));
  for (const parts of secretPaths()) {
    if (getPath(copy, parts) !== undefined) setPath(copy, parts, REDACTED);
  }
  if (Array.isArray(copy.iceServers)) {
    for (const s of copy.iceServers) if (s && s.credential !== undefined) s.credential = REDACTED;
  }
  return copy;
}

function mergeConfig(archived, live) {
  const merged = JSON.parse(JSON.stringify(archived));
  for (const parts of secretPaths()) {
    if (getPath(merged, parts) === REDACTED) setPath(merged, parts, getPath(live || {}, parts) || '');
  }
  if (Array.isArray(merged.iceServers)) {
    const liveServers = Array.isArray(live && live.iceServers) ? live.iceServers : [];
    for (const s of merged.iceServers) {
      if (!s || s.credential !== REDACTED) continue;
      const same = liveServers.find((l) => l && JSON.stringify(l.urls) === JSON.stringify(s.urls) && l.username === s.username);
      s.credential = (same && same.credential) || '';
    }
  }
  return merged;
}

function readJsonIfExists(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function dosDateTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: (Math.max(d.getFullYear() - 1980, 0) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function writeZip(file, entries, when) {
  const { time, date } = dosDateTime(when);
  const fd = fs.openSync(file, 'wx');
  const centrals = [];
  let offset = 0;
  const write = (buf) => { fs.writeSync(fd, buf); offset += buf.length; };
  try {
    for (const { name, data } of entries) {
      if (data.length > MAX_ENTRY_BYTES) throw new Error(`${name} is too large to archive`);
      const nameBuf = Buffer.from(name, 'utf8');
      const deflated = zlib.deflateRawSync(data);
      const store = deflated.length >= data.length;
      const body = store ? data : deflated;
      const method = store ? 0 : 8;
      const crc = zlib.crc32(data);
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(20, 4);
      lh.writeUInt16LE(0x0800, 6);
      lh.writeUInt16LE(method, 8);
      lh.writeUInt16LE(time, 10);
      lh.writeUInt16LE(date, 12);
      lh.writeUInt32LE(crc, 14);
      lh.writeUInt32LE(body.length, 18);
      lh.writeUInt32LE(data.length, 22);
      lh.writeUInt16LE(nameBuf.length, 26);
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0);
      ch.writeUInt16LE(20, 4);
      ch.writeUInt16LE(20, 6);
      ch.writeUInt16LE(0x0800, 8);
      ch.writeUInt16LE(method, 10);
      ch.writeUInt16LE(time, 12);
      ch.writeUInt16LE(date, 14);
      ch.writeUInt32LE(crc, 16);
      ch.writeUInt32LE(body.length, 20);
      ch.writeUInt32LE(data.length, 24);
      ch.writeUInt16LE(nameBuf.length, 28);
      ch.writeUInt32LE(offset, 42);
      centrals.push(ch, nameBuf);
      write(lh);
      write(nameBuf);
      write(body);
    }
    const cd = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cd.length, 12);
    end.writeUInt32LE(offset, 16);
    write(cd);
    write(end);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function safeEntryName(name) {
  if (typeof name !== 'string' || !name || name.length > 512) return false;
  if (/[\0\\:]/.test(name) || name.startsWith('/')) return false;
  return name.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function knownEntry(name) {
  if (name === 'manifest.json' || name === 'config.json' || name === DB_ENTRY) return true;
  const parts = name.split('/');
  return parts[0] === 'media' && parts.length >= 3 && MEDIA_DIRS.includes(parts[1]);
}

function readZipIndex(fd, size) {
  if (size < 22) throw new Error('not a zip archive');
  const tailLen = Math.min(size, 22 + 0xffff);
  const tail = Buffer.alloc(tailLen);
  fs.readSync(fd, tail, 0, tailLen, size - tailLen);
  let p = tailLen - 22;
  while (p >= 0 && tail.readUInt32LE(p) !== 0x06054b50) p--;
  if (p < 0) throw new Error('end of central directory not found');
  const count = tail.readUInt16LE(p + 10);
  const cdSize = tail.readUInt32LE(p + 12);
  const cdOffset = tail.readUInt32LE(p + 16);
  if (count > MAX_ENTRIES || cdOffset + cdSize > size) throw new Error('corrupt central directory');
  const cd = Buffer.alloc(cdSize);
  fs.readSync(fd, cd, 0, cdSize, cdOffset);
  const entries = [];
  let q = 0;
  for (let i = 0; i < count; i++) {
    if (q + 46 > cdSize || cd.readUInt32LE(q) !== 0x02014b50) throw new Error('corrupt central directory');
    const nlen = cd.readUInt16LE(q + 28);
    const elen = cd.readUInt16LE(q + 30);
    const clen = cd.readUInt16LE(q + 32);
    if (q + 46 + nlen > cdSize) throw new Error('corrupt central directory');
    entries.push({
      method: cd.readUInt16LE(q + 10),
      crc: cd.readUInt32LE(q + 16),
      csize: cd.readUInt32LE(q + 20),
      size: cd.readUInt32LE(q + 24),
      lho: cd.readUInt32LE(q + 42),
      name: cd.toString('utf8', q + 46, q + 46 + nlen),
    });
    q += 46 + nlen + elen + clen;
  }
  return entries;
}

function readEntry(fd, fileSize, e) {
  if (e.lho + 30 > fileSize) throw new Error('entry offset out of range');
  const lh = Buffer.alloc(30);
  fs.readSync(fd, lh, 0, 30, e.lho);
  if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('bad local header');
  const start = e.lho + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
  if (start + e.csize > fileSize) throw new Error('entry data out of range');
  const raw = Buffer.alloc(e.csize);
  fs.readSync(fd, raw, 0, e.csize, start);
  let data;
  if (e.method === 0) data = raw;
  else if (e.method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(e.size, 1) });
  else throw new Error(`unsupported compression method ${e.method}`);
  if (data.length !== e.size) throw new Error('size mismatch');
  if (zlib.crc32(data) !== e.crc) throw new Error('crc mismatch');
  return data;
}

// Checks every entry against the manifest. Returns the indexed entries so restore can extract
// without re-parsing; callers must not touch anything unless problems is empty.
function inspect(file, visit) {
  const problems = [];
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    let index;
    try { index = readZipIndex(fd, size); } catch (e) { return { problems: [e.message] }; }
    const seen = new Set();
    for (const e of index) {
      if (!safeEntryName(e.name)) { problems.push(`unsafe entry name: ${JSON.stringify(e.name).slice(0, 80)}`); continue; }
      if (!knownEntry(e.name)) problems.push(`unexpected entry: ${e.name}`);
      if (seen.has(e.name)) problems.push(`duplicate entry: ${e.name}`);
      seen.add(e.name);
    }
    if (problems.length) return { problems };
    const mEntry = index.find((e) => e.name === 'manifest.json');
    if (!mEntry) return { problems: ['manifest.json missing'] };
    let manifest;
    try { manifest = JSON.parse(readEntry(fd, size, mEntry).toString('utf8')); } catch (e) { return { problems: [`manifest unreadable: ${e.message}`] }; }
    if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.files)) return { problems: ['unsupported manifest'] };
    const listed = new Map();
    for (const f of manifest.files) {
      if (!f || !safeEntryName(f.name)) { problems.push(`unsafe entry name: ${JSON.stringify(f && f.name).slice(0, 80)}`); continue; }
      listed.set(f.name, f);
    }
    if (problems.length) return { problems };
    if (!seen.has(DB_ENTRY)) problems.push(`${DB_ENTRY} missing`);
    for (const e of index) {
      if (e.name === 'manifest.json') continue;
      const f = listed.get(e.name);
      if (!f) { problems.push(`not in manifest: ${e.name}`); continue; }
      try {
        const data = readEntry(fd, size, e);
        if (sha256(data) !== f.sha256) problems.push(`hash mismatch: ${e.name}`);
        else if (visit) visit(e.name, data);
      } catch (err) {
        problems.push(`${e.name}: ${err.message}`);
      }
    }
    for (const n of listed.keys()) if (!seen.has(n)) problems.push(`missing from archive: ${n}`);
    return { problems, manifest };
  } catch (e) {
    return { problems: [e.message] };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function collectMedia(dataDir, maxBytes) {
  const out = [];
  const walk = (abs, rel) => {
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      const a = path.join(abs, ent.name);
      const r = `${rel}/${ent.name}`;
      if (ent.isDirectory()) walk(a, r);
      else if (ent.isFile() && safeEntryName(r) && fs.statSync(a).size <= maxBytes) out.push({ name: r, file: a });
    }
  };
  for (const dir of MEDIA_DIRS) {
    const abs = path.join(dataDir, dir);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) walk(abs, `media/${dir}`);
  }
  return out;
}

function snapshotDb(dataDir, target) {
  if (isLive(dataDir)) {
    db.prepare('VACUUM INTO ?').run(target);
    return true;
  }
  const dbFile = path.join(dataDir, 'dismesh.db');
  if (!fs.existsSync(dbFile)) return false;
  const src = new DatabaseSync(dbFile);
  try { src.prepare('VACUUM INTO ?').run(target); } finally { src.close(); }
  return true;
}

async function createBackup({ reason = 'manual', dataDir, backupsDir } = {}) {
  if (!REASONS.includes(reason)) throw new Error(`invalid backup reason: ${reason}`);
  const opts = { dataDir, backupsDir };
  const src = dataDirOf(opts);
  const dir = backupsDirOf(opts);
  const settings = config.load().backup;
  fs.mkdirSync(dir, { recursive: true });
  const snap = path.join(dir, `.snapshot-${crypto.randomBytes(6).toString('hex')}.db`);
  let tmp;
  try {
    if (!snapshotDb(src, snap)) throw new Error('no database to back up');
    await new Promise((r) => setImmediate(r));
    const items = [{ name: DB_ENTRY, data: fs.readFileSync(snap) }];
    const cfg = readJsonIfExists(path.join(src, 'config.json'));
    if (cfg) {
      const out = settings.includeSecrets ? cfg : redactConfig(cfg);
      items.push({ name: 'config.json', data: Buffer.from(JSON.stringify(out, null, 2)) });
    }
    for (const m of collectMedia(src, settings.maxFileMb * 1024 * 1024)) {
      try { items.push({ name: m.name, data: fs.readFileSync(m.file) }); } catch { /* file vanished mid-backup */ }
    }
    const createdAt = new Date();
    const manifest = {
      version: 1,
      createdAt: createdAt.toISOString(),
      files: items.map((i) => ({ name: i.name, size: i.data.length, sha256: sha256(i.data) })),
    };
    const name = makeName(reason, dir);
    const finalPath = path.join(dir, name);
    tmp = `${finalPath}.tmp`;
    writeZip(tmp, [...items, { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) }], createdAt);
    fs.renameSync(tmp, finalPath);
    tmp = null;
    const sizeBytes = fs.statSync(finalPath).size;
    log.info(`created ${name} (${items.length + 1} files, ${sizeBytes} bytes, ${reason})`);
    return { name, path: finalPath, sizeBytes, files: items.length + 1 };
  } catch (e) {
    log.error(`backup failed: ${e.message}`);
    throw e;
  } finally {
    fs.rmSync(snap, { force: true });
    if (tmp) fs.rmSync(tmp, { force: true });
  }
}

function listBackups(opts) {
  const dir = backupsDirOf(opts);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((n) => NAME_RE.test(n))
    .sort()
    .reverse()
    .map((name) => ({ name, ...parseName(name), sizeBytes: fs.statSync(path.join(dir, name)).size }));
}

function fileOf(name, opts) {
  checkName(name);
  return path.join(backupsDirOf(opts), name);
}

function deleteBackup(name, opts) {
  const file = fileOf(name, opts);
  if (!fs.existsSync(file)) throw new Error(`no such backup: ${name}`);
  fs.rmSync(file);
  log.info(`deleted ${name}`);
}

function pruneBackups(opts) {
  const { keep, preRestoreKeep } = config.load().backup;
  const all = listBackups(opts);
  const victims = [
    ...all.filter((b) => b.reason !== 'pre-restore').slice(keep),
    ...all.filter((b) => b.reason === 'pre-restore').slice(preRestoreKeep),
  ];
  for (const b of victims) fs.rmSync(path.join(backupsDirOf(opts), b.name), { force: true });
  if (victims.length) log.info(`pruned ${victims.length} old backup(s)`);
  return victims.length;
}

async function verifyBackup(name, opts) {
  const file = fileOf(name, opts);
  if (!fs.existsSync(file)) return { ok: false, problems: [`no such backup: ${name}`] };
  const { problems } = inspect(file);
  return { ok: problems.length === 0, problems };
}

// Replaces the data directory's database, media and config from the archive. When dataDir is the
// live DATA_DIR the shared db handle is closed (a Windows file lock would block the swap), so the
// process can no longer serve and MUST be restarted afterwards. Failures after that point carry
// err.liveDbClosed = true.
async function restoreBackup(name, opts = {}) {
  const file = fileOf(name, opts);
  const dataDir = dataDirOf(opts);
  const live = isLive(dataDir);
  let staging;
  let dbClosed = false;
  try {
    if (!fs.existsSync(file)) throw new Error(`no such backup: ${name}`);
    const staged = new Map();
    staging = path.join(dataDir, `.restore-${crypto.randomBytes(6).toString('hex')}`);
    fs.mkdirSync(staging, { recursive: true });
    const verdict = inspect(file, (entry, data) => {
      const out = path.join(staging, ...entry.split('/'));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, data);
      staged.set(entry, out);
    });
    if (verdict.problems.length) throw new Error(`verification failed: ${verdict.problems.join('; ')}`);

    if (fs.existsSync(path.join(dataDir, 'dismesh.db'))) {
      await createBackup({ reason: 'pre-restore', dataDir, backupsDir: opts.backupsDir });
      pruneBackups(opts);
    }

    if (live) { db.close(); dbClosed = true; }
    const dbFile = path.join(dataDir, 'dismesh.db');
    for (const sfx of ['-wal', '-shm']) fs.rmSync(dbFile + sfx, { force: true });
    fs.renameSync(staged.get(DB_ENTRY), dbFile);

    for (const [entry, from] of staged) {
      if (!entry.startsWith('media/')) continue;
      const to = path.join(dataDir, ...entry.slice('media/'.length).split('/'));
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
    }

    if (staged.has('config.json')) {
      const archived = JSON.parse(fs.readFileSync(staged.get('config.json'), 'utf8'));
      const merged = mergeConfig(archived, readJsonIfExists(path.join(dataDir, 'config.json')));
      const cfgFile = path.join(dataDir, 'config.json');
      fs.writeFileSync(`${cfgFile}.tmp`, JSON.stringify(merged, null, 2));
      fs.renameSync(`${cfgFile}.tmp`, cfgFile);
    }
    log.info(`restored ${name}${live ? ' (restart required)' : ''}`);
  } catch (e) {
    log.error(`restore of ${typeof name === 'string' ? name : '?'} failed: ${e.message}`);
    if (dbClosed) e.liveDbClosed = true;
    throw e;
  } finally {
    if (staging) fs.rmSync(staging, { recursive: true, force: true });
  }
}

function nextRunDelay(schedule, now = new Date()) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(schedule || ''));
  if (!m) return null;
  const next = new Date(now);
  next.setHours(+m[1], +m[2], 0, 0);
  let delay = next - now;
  if (delay <= 1000) delay += 24 * 3600000;
  return delay;
}

let timer = null;
// A scheduled run that is still in flight when stop() or a new startScheduler() happens must not re-arm.
let generation = 0;

function startScheduler(opts = {}) {
  const stop = () => { generation += 1; if (timer) clearTimeout(timer); timer = null; };
  stop();
  const gen = generation;
  const delayOf = opts.delay || (() => nextRunDelay(config.load().backup.schedule));
  const run = opts.run || (async () => {
    await createBackup({ reason: 'scheduled' });
    pruneBackups();
  });
  const arm = () => {
    if (gen !== generation) return;
    const delay = delayOf();
    if (delay === null) return;
    timer = setTimeout(async () => {
      try { await run(); } catch { /* already logged by createBackup */ }
      arm();
    }, delay);
    timer.unref();
  };
  arm();
  return stop;
}

function schedulerActive() { return timer !== null; }

module.exports = {
  createBackup, listBackups, deleteBackup, pruneBackups, verifyBackup, restoreBackup,
  startScheduler, schedulerActive, nextRunDelay, MEDIA_DIRS, _test: { redactConfig, mergeConfig },
};
