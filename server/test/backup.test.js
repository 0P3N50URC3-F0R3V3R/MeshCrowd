'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const { db } = require('../db');
const config = require('../lib/config');
const backup = require('../lib/backup');
const { createRegistry } = require('../console/registry');
const registerBackup = require('../console/commands/backup');

const backupsDir = path.join(tmpDir, 'backups');

test.before(() => { for (const m of ['log', 'warn', 'error']) console[m] = () => {}; });
test.after(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

function sha(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

function readEntries(file) {
  const buf = fs.readFileSync(file);
  let eocd = buf.length - 22;
  while (buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    const dataStart = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(dataStart, dataStart + csize);
    out[name] = method === 8 ? zlib.inflateRawSync(raw) : raw;
    p += 46 + nlen + elen + clen;
  }
  return out;
}

function putFile(rel, size, fill = 'x') {
  const p = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(size, fill));
}

function crc32(buf) { return zlib.crc32(buf); }

function craftZip(file, entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(crc32(data), 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(crc32(data), 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  fs.writeFileSync(file, Buffer.concat([...locals, cd, end]));
}

function clearBackups() {
  fs.rmSync(backupsDir, { recursive: true, force: true });
}

test('archive holds db, redacted config, small media; excludes attachments, big files, certs, ssh key', async () => {
  clearBackups();
  config.save({ backup: { maxFileMb: 1 } });
  putFile('avatars/a.png', 100);
  putFile('emoji/big.png', 2 * 1024 * 1024);
  putFile('attachments/secret.bin', 50);
  putFile('notefiles/n.bin', 50);
  putFile('certs/server.key', 50);
  putFile('ssh_host_ed25519', 50);
  const secret = config.load().turn.secret;
  assert.ok(secret.length > 8);

  const res = await backup.createBackup({ reason: 'manual' });
  assert.match(res.name, /^backup-\d{8}-\d{6}-\d{3}-manual\.zip$/);
  assert.equal(res.path, path.join(backupsDir, res.name));
  assert.ok(res.sizeBytes > 0);

  const entries = readEntries(res.path);
  const names = Object.keys(entries);
  assert.ok(names.includes('manifest.json'));
  assert.ok(names.includes('db/dismesh.db'));
  assert.ok(names.includes('config.json'));
  assert.ok(names.includes('media/avatars/a.png'));
  assert.ok(!names.some((n) => /attachments|notefiles|certs|ssh_host|big\.png/.test(n)), names.join(','));

  const cfg = JSON.parse(entries['config.json'].toString());
  assert.notEqual(cfg.turn.secret, secret);
  assert.ok(!entries['config.json'].toString().includes(secret));

  const manifest = JSON.parse(entries['manifest.json'].toString());
  assert.equal(manifest.version, 1);
  assert.ok(manifest.createdAt);
  assert.equal(manifest.files.length, names.length - 1);
  for (const f of manifest.files) {
    assert.equal(f.sha256, crypto.createHash('sha256').update(entries[f.name]).digest('hex'));
  }

  const snap = path.join(tmpDir, 'snap.db');
  fs.writeFileSync(snap, entries['db/dismesh.db']);
  const snapDb = new DatabaseSync(snap);
  assert.equal(snapDb.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  snapDb.close();
  assert.equal(res.files, manifest.files.length + 1);
});

test('includeSecrets keeps the real turn.secret in the archive', async () => {
  clearBackups();
  config.save({ backup: { includeSecrets: true } });
  const secret = config.load().turn.secret;
  const res = await backup.createBackup({ reason: 'manual' });
  const cfg = JSON.parse(readEntries(res.path)['config.json'].toString());
  assert.equal(cfg.turn.secret, secret);
  config.save({ backup: { includeSecrets: false } });
});

test('pruneBackups keeps newest N normal and newest M pre-restore', () => {
  clearBackups();
  fs.mkdirSync(backupsDir, { recursive: true });
  const mk = (i, reason) => {
    const name = `backup-20260101-0000${String(i).padStart(2, '0')}-000-${reason}.zip`;
    fs.writeFileSync(path.join(backupsDir, name), 'x');
    return name;
  };
  const normal = [0, 1, 2, 3, 4].map((i) => mk(i, i % 2 ? 'scheduled' : 'manual'));
  const pre = [10, 11, 12, 13].map((i) => mk(i, 'pre-restore'));
  config.save({ backup: { keep: 3, preRestoreKeep: 3 } });
  assert.equal(backup.pruneBackups(), 3);
  const left = fs.readdirSync(backupsDir).sort();
  assert.deepEqual(left, [...normal.slice(2), ...pre.slice(1)].sort());
  const list = backup.listBackups();
  assert.equal(list.length, 6);
  assert.deepEqual(Object.keys(list[0]).sort(), ['createdAt', 'name', 'reason', 'sizeBytes']);
  assert.equal(list[0].name, pre[3]);
  assert.equal(list[0].reason, 'pre-restore');
  config.save({ backup: { keep: 7, preRestoreKeep: 3 } });
});

test('backup names are validated, traversal is rejected', async () => {
  for (const bad of ['..\\..\\x', '../x', 'backup-x.zip', 'C:\\x.zip', '', undefined, 'backup-20260101-000000-000-manual.zip/../x']) {
    assert.throws(() => backup.deleteBackup(bad), /invalid backup name/, String(bad));
    await assert.rejects(() => backup.verifyBackup(bad), /invalid backup name/);
    await assert.rejects(() => backup.restoreBackup(bad), /invalid backup name/);
  }
  assert.throws(() => backup.deleteBackup('backup-20260101-000000-000-manual.zip'), /no such backup/);
});

test('deleteBackup removes the file', async () => {
  clearBackups();
  const res = await backup.createBackup({ reason: 'manual' });
  backup.deleteBackup(res.name);
  assert.equal(fs.existsSync(res.path), false);
});

test('verifyBackup ok, and fails after a single flipped byte', async () => {
  clearBackups();
  const res = await backup.createBackup({ reason: 'manual' });
  assert.deepEqual(await backup.verifyBackup(res.name), { ok: true, problems: [] });
  const buf = fs.readFileSync(res.path);
  buf[Math.floor(buf.length / 3)] ^= 0xff;
  fs.writeFileSync(res.path, buf);
  const v = await backup.verifyBackup(res.name);
  assert.equal(v.ok, false);
  assert.ok(v.problems.length > 0);
});

test('verifyBackup rejects zip-slip entry names', async () => {
  clearBackups();
  fs.mkdirSync(backupsDir, { recursive: true });
  for (const evil of ['../evil.txt', '..\\evil.txt', '/abs.txt', 'C:/abs.txt', 'media/avatars/../../../evil', 'media//x']) {
    const name = 'backup-20260101-000000-000-manual.zip';
    const files = [{ name: evil, sha256: crypto.createHash('sha256').update('pwn').digest('hex'), size: 3 }];
    craftZip(path.join(backupsDir, name), [
      ['manifest.json', Buffer.from(JSON.stringify({ version: 1, createdAt: 'x', files }))],
      [evil, Buffer.from('pwn')],
    ]);
    const v = await backup.verifyBackup(name);
    assert.equal(v.ok, false, evil);
    assert.match(v.problems.join('\n'), /unsafe entry name/, evil);
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-slip-'));
    await assert.rejects(() => backup.restoreBackup(name, { dataDir: target }));
    assert.equal(fs.existsSync(path.join(target, 'dismesh.db')), false);
    assert.equal(fs.existsSync(path.join(target, '..', 'evil.txt')), false);
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('restore into another dir: replaces db, restores media, keeps live secrets, skips certs/ssh key', async () => {
  clearBackups();
  db.exec("CREATE TABLE IF NOT EXISTS backup_probe (v TEXT)");
  db.prepare('INSERT INTO backup_probe (v) VALUES (?)').run('from-backup');
  putFile('avatars/restored.png', 10, 'a');
  const res = await backup.createBackup({ reason: 'manual' });

  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-target-'));
  fs.mkdirSync(path.join(target, 'certs'));
  fs.writeFileSync(path.join(target, 'certs', 'server.key'), 'LIVEKEY');
  fs.writeFileSync(path.join(target, 'ssh_host_ed25519'), 'LIVEHOST');
  fs.writeFileSync(path.join(target, 'config.json'), JSON.stringify({ port: 1234, turn: { secret: 'LIVE-SECRET', port: 1 } }));
  const old = new DatabaseSync(path.join(target, 'dismesh.db'));
  old.exec('CREATE TABLE old_only (x)');
  old.close();
  fs.writeFileSync(path.join(target, 'dismesh.db-wal'), 'stale');
  fs.writeFileSync(path.join(target, 'dismesh.db-shm'), 'stale');

  await backup.restoreBackup(res.name, { dataDir: target });

  const restored = new DatabaseSync(path.join(target, 'dismesh.db'));
  assert.equal(restored.prepare('SELECT v FROM backup_probe').get().v, 'from-backup');
  assert.equal(restored.prepare("SELECT count(*) c FROM sqlite_master WHERE name='old_only'").get().c, 0);
  restored.close();
  assert.equal(fs.existsSync(path.join(target, 'dismesh.db-wal')), false);
  assert.equal(fs.existsSync(path.join(target, 'dismesh.db-shm')), false);
  assert.equal(fs.readFileSync(path.join(target, 'avatars', 'restored.png'), 'utf8'), 'aaaaaaaaaa');
  assert.equal(fs.readFileSync(path.join(target, 'certs', 'server.key'), 'utf8'), 'LIVEKEY');
  assert.equal(fs.readFileSync(path.join(target, 'ssh_host_ed25519'), 'utf8'), 'LIVEHOST');
  const cfg = JSON.parse(fs.readFileSync(path.join(target, 'config.json'), 'utf8'));
  assert.equal(cfg.turn.secret, 'LIVE-SECRET');
  assert.equal(cfg.port, config.load().port);
  assert.equal(backup.listBackups().filter((b) => b.reason === 'pre-restore').length, 1);
  fs.rmSync(target, { recursive: true, force: true });
});

test('tampered archive: restore refuses and leaves the target db untouched', async () => {
  clearBackups();
  const res = await backup.createBackup({ reason: 'manual' });
  const buf = fs.readFileSync(res.path);
  buf[Math.floor(buf.length / 2)] ^= 0x01;
  fs.writeFileSync(res.path, buf);

  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-target-'));
  const t = new DatabaseSync(path.join(target, 'dismesh.db'));
  t.exec('CREATE TABLE keepme (x)');
  t.close();
  const before = sha(path.join(target, 'dismesh.db'));
  await assert.rejects(() => backup.restoreBackup(res.name, { dataDir: target }), /verification failed/);
  assert.equal(sha(path.join(target, 'dismesh.db')), before);
  assert.equal(backup.listBackups().filter((b) => b.reason === 'pre-restore').length, 0);
  fs.rmSync(target, { recursive: true, force: true });
});

test('rows inserted while createBackup runs give a consistent snapshot', async () => {
  clearBackups();
  db.exec('CREATE TABLE IF NOT EXISTS backup_load (n INTEGER)');
  let stop = false;
  const writer = (async () => {
    let n = 0;
    while (!stop) {
      db.prepare('INSERT INTO backup_load (n) VALUES (?)').run(n++);
      await new Promise((r) => setImmediate(r));
    }
  })();
  const res = await backup.createBackup({ reason: 'manual' });
  stop = true;
  await writer;
  const snap = path.join(tmpDir, 'load.db');
  fs.writeFileSync(snap, readEntries(res.path)['db/dismesh.db']);
  const s = new DatabaseSync(snap);
  assert.equal(s.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.ok(s.prepare('SELECT count(*) c FROM backup_load').get().c >= 0);
  s.close();
});

test('live restore (child process) closes db, swaps the file and removes wal/shm', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-live-'));
  const script = `
    const { db } = require(${JSON.stringify(path.join(__dirname, '..', 'db'))});
    const backup = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'backup'))});
    (async () => {
      db.exec('CREATE TABLE t (v TEXT)');
      db.prepare('INSERT INTO t VALUES (?)').run('before');
      const b = await backup.createBackup({ reason: 'manual' });
      db.prepare('INSERT INTO t VALUES (?)').run('after');
      await backup.restoreBackup(b.name);
      const { DatabaseSync } = require('node:sqlite');
      const d = new DatabaseSync(require('node:path').join(process.env.DISMESH_DATA_DIR, 'dismesh.db'));
      console.log(JSON.stringify(d.prepare('SELECT v FROM t').all().map((r) => r.v)));
      d.close();
    })().catch((e) => { console.error(e); process.exit(1); });
  `;
  const r = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, DISMESH_DATA_DIR: dir }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('["before"]'), r.stdout);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('nextRunDelay and scheduler', () => {
  const at = (h, m) => new Date(2026, 0, 1, h, m, 0, 0);
  assert.equal(backup.nextRunDelay('03:30', at(3, 0)), 30 * 60000);
  assert.equal(backup.nextRunDelay('03:30', at(3, 30)), 24 * 3600000);
  assert.equal(backup.nextRunDelay('', at(3, 0)), null);
  assert.equal(backup.nextRunDelay('25:00', at(3, 0)), null);
  assert.equal(backup.nextRunDelay('3:5', at(3, 0)), null);
  config.save({ backup: { schedule: '' } });
  const stop = backup.startScheduler();
  assert.equal(typeof stop, 'function');
  stop();
  config.save({ backup: { schedule: '03:30' } });
  const stop2 = backup.startScheduler();
  stop2();
  config.save({ backup: { schedule: '' } });
});

function makeCtx(answer = true) {
  const asked = [];
  return { asked, session: { kind: 'local', username: 'root' }, confirm: async (q) => { asked.push(q); return answer; }, ask: async () => '', writeln() {}, write() {} };
}

test('backup commands', async () => {
  clearBackups();
  const registry = createRegistry();
  registerBackup(registry);
  const run = async (line, ctx = makeCtx()) => {
    const out = [];
    ctx.write = (t) => out.push(t);
    ctx.writeln = (t) => out.push(`${t}\n`);
    await registry.execute(line, ctx);
    return out.join('');
  };

  assert.match(await run('backup create'), /backup-\d{8}-\d{6}-\d{3}-manual\.zip/);
  const listed = await run('backup list');
  const name = listed.match(/backup-\S+?\.zip/)[0];
  assert.match(await run(`backup verify ${name}`), /ok/);
  assert.match(await run('backup keep 0'), /1-100|between/);
  assert.match(await run('backup keep 5'), /5/);
  assert.equal(config.load().backup.keep, 5);
  assert.match(await run('backup auto 04:15'), /04:15/);
  assert.equal(config.load().backup.schedule, '04:15');
  assert.match(await run('backup auto bogus'), /HH:MM/);
  assert.match(await run('backup auto off'), /off/i);
  assert.equal(config.load().backup.schedule, '');

  const cancel = makeCtx(false);
  assert.match(await run(`backup delete ${name}`, cancel), /cancelled/);
  assert.equal(cancel.asked.length, 1);
  assert.ok(fs.existsSync(path.join(backupsDir, name)));
  await run(`backup delete ${name} --yes`, cancel);
  assert.equal(fs.existsSync(path.join(backupsDir, name)), false);

  const sshCtx = makeCtx();
  sshCtx.session = { kind: 'ssh', userId: 1, username: 'root' };
  assert.match(await run('backup restore x', sshCtx), /unknown command/);
});
