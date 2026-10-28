'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const { db } = require('../db');
const sf = require('../lib/siteFiles');

test.after(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

test('servers.kind defaults to chat and site_csp_origins to []', () => {
  const uid = db.prepare("INSERT INTO users (username, email, password_hash, display_name) VALUES ('sf_u', 'sf_u@t.local', 'h', 'sf')").run().lastInsertRowid;
  const sid = db.prepare("INSERT INTO servers (name, owner_id, invite_code) VALUES ('S', ?, 'sf-inv')").run(uid).lastInsertRowid;
  const row = db.prepare('SELECT kind, site_csp_origins FROM servers WHERE id = ?').get(sid);
  assert.equal(row.kind, 'chat');
  assert.equal(row.site_csp_origins, '[]');
});

test('write/read/list round trip with an accented, spaced file name', () => {
  sf.ensureSiteDir(1);
  const w = sf.writeFile(1, 'árak lista.html', Buffer.from('<p>x</p>'));
  assert.equal(typeof w.mtimeMs, 'number');
  const r = sf.readFile(1, 'árak lista.html');
  assert.equal(r.content, '<p>x</p>');
  assert.equal(r.binary, false);
  assert.ok(sf.listFiles(1).some((f) => f.path === 'árak lista.html' && f.type === 'file'));
});

test('hostile paths and names are rejected with 400', () => {
  for (const bad of ['../x.php', 'a/../../x.php', '..\\x.php', 'a\0.php', '.hidden.php', 'con.php', 'x.exe', 'x.php.', 'x.PHP ', 'noext']) {
    assert.throws(() => sf.writeFile(1, bad, Buffer.from('x')), (e) => e instanceof sf.SiteFileError && e.status === 400, bad);
  }
});

test('a symlink or junction inside the Site cannot be written through or served', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.php'), '<?php echo 1;');
  fs.symlinkSync(outside, path.join(sf.siteDir(1), 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => sf.writeFile(1, 'link/x.php', Buffer.from('x')), (e) => e.status === 400);
  assert.equal(sf.resolveServeTarget(1, 'link/secret.php'), null);
  assert.ok(!sf.listFiles(1).some((f) => f.path.startsWith('link')));
  fs.rmSync(outside, { recursive: true, force: true });
});

test('size, count and total limits answer 413', () => {
  assert.throws(() => sf.writeFile(1, 'big.txt', Buffer.alloc(sf.LIMITS.maxFileBytes + 1)), (e) => e.status === 413);
  const saved = { ...sf.LIMITS };
  try {
    sf.LIMITS.maxFiles = sf.listFiles(1).filter((f) => f.type === 'file').length;
    assert.throws(() => sf.writeFile(1, 'one-too-many.txt', Buffer.from('x')), (e) => e.status === 413);
    sf.LIMITS.maxFiles = saved.maxFiles;
    sf.LIMITS.maxTotalBytes = 10;
    assert.throws(() => sf.writeFile(1, 'total.txt', Buffer.alloc(100)), (e) => e.status === 413);
  } finally { Object.assign(sf.LIMITS, saved); }
});

test('a stale mtime answers 409 unless forced', () => {
  const w = sf.writeFile(1, 'c.txt', Buffer.from('a'));
  assert.throws(() => sf.writeFile(1, 'c.txt', Buffer.from('b'), { expectMtime: w.mtimeMs - 5000 }), (e) => e.status === 409);
  assert.doesNotThrow(() => sf.writeFile(1, 'c.txt', Buffer.from('b'), { expectMtime: w.mtimeMs - 5000, force: true }));
  assert.doesNotThrow(() => sf.writeFile(1, 'c.txt', Buffer.from('c'), { expectMtime: sf.readFile(1, 'c.txt').mtimeMs }));
});

test('rename, mkdir and delete work, and rename refuses to overwrite', () => {
  sf.writeFile(1, 'r1.txt', Buffer.from('1'));
  sf.writeFile(1, 'r2.txt', Buffer.from('2'));
  assert.throws(() => sf.renamePath(1, 'r1.txt', 'r2.txt'), (e) => e.status === 409);
  sf.makeDir(1, 'sub/dir');
  sf.renamePath(1, 'r1.txt', 'sub/dir/r1.txt');
  assert.equal(sf.readFile(1, 'sub/dir/r1.txt').content, '1');
  sf.deletePath(1, 'sub');
  assert.ok(!sf.listFiles(1).some((f) => f.path.startsWith('sub')));
});

test('resolveServeTarget picks index files, classifies php, and 404s the rest', () => {
  sf.makeDir(1, 'site');
  sf.writeFile(1, 'site/index.php', Buffer.from('<?php echo 1;'));
  sf.makeDir(1, 'plain');
  sf.writeFile(1, 'plain/index.html', Buffer.from('hi'));
  sf.makeDir(1, 'empty');
  assert.deepEqual(
    (({ kind, rel, viaDir }) => ({ kind, rel, viaDir }))(sf.resolveServeTarget(1, 'site')),
    { kind: 'php', rel: 'site/index.php', viaDir: true },
  );
  assert.equal(sf.resolveServeTarget(1, 'plain').kind, 'static');
  assert.equal(sf.resolveServeTarget(1, 'empty'), null);
  assert.equal(sf.resolveServeTarget(1, 'site/index.php').viaDir, false);
  assert.equal(sf.resolveServeTarget(1, 'nope.php'), null);
  fs.writeFileSync(path.join(sf.siteDir(1), 'raw.bin'), 'x');
  assert.equal(sf.resolveServeTarget(1, 'raw.bin'), null);
  assert.equal(sf.resolveServeTarget(1, '.git/config'), null);
});

test('a missing Site folder lists empty and serves nothing', () => {
  assert.deepEqual(sf.listFiles(999), []);
  assert.equal(sf.resolveServeTarget(999, ''), null);
  assert.equal(sf.resolveServeTarget(999, 'index.php'), null);
});

test('removeSiteDir deletes the folder', () => {
  sf.removeSiteDir(1);
  assert.equal(fs.existsSync(sf.siteDir(1)), false);
});
