'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-cfgload-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const config = require('../lib/config');

test.before(() => { console.error = () => {}; });
test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const read = () => fs.readFileSync(config.CONFIG_PATH, 'utf8');
const leftovers = () => fs.readdirSync(tmpDir).filter((f) => f.endsWith('.tmp'));

test('a missing file is created once with a generated secret, then not rewritten', () => {
  fs.rmSync(config.CONFIG_PATH, { force: true });
  const first = config.load();
  assert.ok(first.turn.secret.length >= 32);
  const stored = JSON.parse(read());
  assert.equal(stored.turn.secret, first.turn.secret);
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(config.CONFIG_PATH, past, past);
  const before = fs.statSync(config.CONFIG_PATH);
  for (let i = 0; i < 3; i++) assert.equal(config.load().turn.secret, first.turn.secret);
  const after = fs.statSync(config.CONFIG_PATH);
  assert.equal(after.mtimeMs, before.mtimeMs, 'an unchanged config is not rewritten');
  assert.equal(after.ino, before.ino);
});

test('a file missing new keys and the secret gets them persisted once', () => {
  fs.writeFileSync(config.CONFIG_PATH, JSON.stringify({ port: 9123, turn: { port: 4000 } }));
  const cfg = config.load();
  assert.equal(cfg.port, 9123);
  assert.equal(cfg.voice.mode, 'mesh');
  const stored = JSON.parse(read());
  assert.equal(stored.turn.port, 4000);
  assert.equal(stored.turn.secret, cfg.turn.secret);
  assert.equal(stored.voice.sfu.port, 40000);
  assert.equal(config.load().turn.secret, cfg.turn.secret);
});

test('an unparseable file is never overwritten by load()', () => {
  const broken = '{ "port": 9000, "turn": { "secret": "keepme"';
  fs.writeFileSync(config.CONFIG_PATH, broken);
  const a = config.load();
  const b = config.load();
  assert.equal(a.port, config.DEFAULTS.port);
  assert.equal(a.turn.secret, b.turn.secret, 'the fallback secret is stable between loads');
  assert.equal(read(), broken);
  assert.deepEqual(leftovers(), []);
});

test('save() on an unparseable file moves it aside instead of losing it', () => {
  const broken = '{ "port": 9001, ';
  fs.writeFileSync(config.CONFIG_PATH, broken);
  config.save({ maxUploadMb: 33 });
  const aside = fs.readdirSync(tmpDir).filter((f) => f.startsWith('config.json.corrupt-'));
  assert.equal(aside.length, 1);
  assert.equal(fs.readFileSync(path.join(tmpDir, aside[0]), 'utf8'), broken);
  assert.equal(JSON.parse(read()).maxUploadMb, 33);
});

test('save() writes through a temp file and rename, leaving no temp file behind', () => {
  const renames = [];
  const orig = fs.renameSync;
  fs.renameSync = (from, to) => { renames.push([path.basename(from), path.basename(to)]); return orig(from, to); };
  try {
    config.save({ turn: { realm: 'atomic' } });
  } finally {
    fs.renameSync = orig;
  }
  assert.equal(renames.length, 1);
  assert.match(renames[0][0], /^config\.json\..*\.tmp$/);
  assert.equal(renames[0][1], 'config.json');
  assert.equal(JSON.parse(read()).turn.realm, 'atomic');
  assert.deepEqual(leftovers(), []);
});

test('a read error is treated like an unreadable file: defaults, no throw, no write', () => {
  fs.writeFileSync(config.CONFIG_PATH, JSON.stringify({ port: 9200 }));
  const before = read();
  const orig = fs.readFileSync;
  fs.readFileSync = (file, ...rest) => {
    if (file === config.CONFIG_PATH) { const e = new Error('busy'); e.code = 'EBUSY'; throw e; }
    return orig(file, ...rest);
  };
  try {
    const cfg = config.load();
    assert.equal(cfg.port, config.DEFAULTS.port);
    assert.throws(() => config.save({ port: 9300 }), /busy/);
  } finally {
    fs.readFileSync = orig;
  }
  assert.equal(read(), before);
});

test('save() re-reads a file that looked corrupt and keeps it when the writer has finished', () => {
  const half = '{ "port": 9400, "turn": {';
  const whole = JSON.stringify({ port: 9400, turn: { realm: 'kept', secret: 's'.repeat(64) } });
  fs.writeFileSync(config.CONFIG_PATH, half);
  const orig = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = (file, ...rest) => {
    if (file === config.CONFIG_PATH && ++reads === 1) return half;
    return orig(file, ...rest);
  };
  fs.writeFileSync(config.CONFIG_PATH, whole);
  try {
    config.save({ maxUploadMb: 34 });
  } finally {
    fs.readFileSync = orig;
  }
  const stored = JSON.parse(read());
  assert.equal(stored.port, 9400);
  assert.equal(stored.turn.realm, 'kept');
  assert.equal(stored.maxUploadMb, 34);
  const asideBefore = fs.readdirSync(tmpDir).filter((f) => f.startsWith('config.json.corrupt-')).length;
  assert.equal(asideBefore, 1, 'only the earlier test moved a file aside');
});

test('writes keep the existing file mode and a new file is created 0600', { skip: process.platform === 'win32' && 'POSIX modes only' }, () => {
  fs.rmSync(config.CONFIG_PATH, { force: true });
  config.load();
  assert.equal(fs.statSync(config.CONFIG_PATH).mode & 0o777, 0o600);
  fs.chmodSync(config.CONFIG_PATH, 0o640);
  config.save({ maxUploadMb: 35 });
  assert.equal(fs.statSync(config.CONFIG_PATH).mode & 0o777, 0o640);
});

test('writes pass the existing file mode to the temp file', () => {
  const modes = [];
  const orig = fs.writeFileSync;
  fs.writeFileSync = (file, data, opts) => { if (String(file).endsWith('.tmp')) modes.push(opts && opts.mode); return orig(file, data, opts); };
  try {
    config.save({ maxUploadMb: 36 });
  } finally {
    fs.writeFileSync = orig;
  }
  assert.equal(modes.length, 1);
  assert.equal(modes[0], fs.statSync(config.CONFIG_PATH).mode & 0o777);
});

test('sweepTempFiles removes stale config temp files only', () => {
  const stale = path.join(tmpDir, 'config.json.1.1.tmp');
  const fresh = path.join(tmpDir, 'config.json.2.2.tmp');
  const other = path.join(tmpDir, 'config.json.backup.tmp');
  for (const f of [stale, fresh, other]) fs.writeFileSync(f, 'x');
  const old = new Date(Date.now() - 5 * 60_000);
  fs.utimesSync(stale, old, old);
  fs.utimesSync(other, old, old);
  assert.equal(config.sweepTempFiles(), 1);
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(fresh), true);
  assert.equal(fs.existsSync(other), true);
  for (const f of [fresh, other]) fs.rmSync(f);
});

test('a write failure keeps the parsed config instead of falling back to defaults', () => {
  fs.writeFileSync(config.CONFIG_PATH, JSON.stringify({ port: 9500 }));
  const orig = fs.renameSync;
  const origWrite = fs.writeFileSync;
  fs.renameSync = () => { const e = new Error('full'); e.code = 'ENOSPC'; throw e; };
  fs.writeFileSync = (file, ...rest) => {
    if (file === config.CONFIG_PATH || String(file).endsWith('.tmp')) { const e = new Error('full'); e.code = 'ENOSPC'; throw e; }
    return origWrite(file, ...rest);
  };
  try {
    const cfg = config.load();
    assert.equal(cfg.port, 9500);
    assert.ok(cfg.turn.secret);
  } finally {
    fs.renameSync = orig;
    fs.writeFileSync = origWrite;
  }
});

test('instance and swarm defaults exist, merge per key, and the swarm interval has a floor', () => {
  fs.writeFileSync(config.CONFIG_PATH, JSON.stringify({ instance: { name: 'Home' }, swarm: { advertise: true } }));
  const cfg = config.load();
  assert.equal(cfg.instance.name, 'Home');
  assert.equal(cfg.instance.description, '');
  assert.equal(cfg.swarm.advertise, true);
  assert.deepEqual(cfg.swarm.trackers, ['https://nexnet.hu:19898']);
  assert.equal(cfg.swarm.intervalSeconds, 300);
  fs.rmSync(config.CONFIG_PATH, { force: true });
  assert.equal(config.load().swarm.advertise, false);
  const schema = require('../lib/configSchema');
  assert.throws(() => schema.coerce('swarm.intervalSeconds', '30'), /at least 60/);
  assert.equal(schema.lookup('swarm.advertise').restart, false);
  assert.equal(schema.lookup('instance.name').restart, false);
});
