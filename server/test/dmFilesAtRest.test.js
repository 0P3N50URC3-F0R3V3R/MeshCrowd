'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const { db } = require('../db');
const { isSealed } = require('../lib/atRest');
const { isSealedFile } = require('../lib/fileSeal');

test.after(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

const mkUser = (n) => Number(db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)').run(n, `${n}@t.local`, 'h', n).lastInsertRowid);
const alice = mkUser('fa_alice');
const bob = mkUser('fa_bob');
const eve = mkUser('fa_eve');
const dm = Number(db.prepare('INSERT INTO dm_channels (is_group, created_by) VALUES (0, ?)').run(alice).lastInsertRowid);
for (const u of [alice, bob]) db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?)').run(dm, u);

let server; let base;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const uid = Number(req.headers['x-uid']);
    if (uid) req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
    next();
  });
  app.use('/uploads/attachments', require('../routes/dmFiles'));
  app.use('/api/dms', require('../routes/dms'));
  app.use(require('../middleware/errorHandler').errorHandler);
  await new Promise((r) => { server = http.createServer(app).listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test('DM attachments are sealed on disk under a random name, with the real name sealed in the database', async () => {
  const plain = crypto.randomBytes(150000);
  const fd = new FormData();
  fd.append('content', 'here');
  fd.append('files', new Blob([plain], { type: 'image/png' }), 'holiday photo.png');
  const res = await fetch(`${base}/api/dms/${dm}/messages`, { method: 'POST', headers: { 'x-uid': String(alice) }, body: fd });
  assert.equal(res.status, 201);
  const { message } = await res.json();
  const att = message.attachments[0];
  assert.equal(att.fileName, 'holiday_photo.png');
  assert.equal(att.sizeBytes, plain.length);
  assert.match(att.url, /^\/uploads\/attachments\/dm-\d+\/[0-9a-f]{24}\.bin$/);
  assert.ok(isSealed(db.prepare('SELECT file_name FROM attachments WHERE id = ?').get(att.id).file_name));

  const onDisk = path.join(tmpDir, att.url.replace('/uploads/', ''));
  assert.ok(isSealedFile(onDisk));
  assert.ok(!fs.readFileSync(onDisk).includes(plain.subarray(1000, 1032)));

  const member = await fetch(base + att.url, { headers: { 'x-uid': String(bob) } });
  assert.equal(member.status, 200);
  assert.equal(member.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await member.arrayBuffer()), plain);

  const range = await fetch(base + att.url, { headers: { 'x-uid': String(alice), range: 'bytes=70000-70999' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), `bytes 70000-70999/${plain.length}`);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), plain.subarray(70000, 71000));

  assert.equal((await fetch(base + att.url, { headers: { 'x-uid': String(eve) } })).status, 404);
  assert.equal((await fetch(base + att.url)).status, 401);
});

test('a forwarded DM attachment stays visible to people who can see the forward', async () => {
  const fd = new FormData();
  fd.append('content', '');
  fd.append('files', new Blob([Buffer.from('fwd')], { type: 'text/plain' }), 'note.txt');
  const sent = await (await fetch(`${base}/api/dms/${dm}/messages`, { method: 'POST', headers: { 'x-uid': String(alice) }, body: fd })).json();
  const att = sent.message.attachments[0];
  const other = Number(db.prepare('INSERT INTO dm_channels (is_group, created_by) VALUES (0, ?)').run(alice).lastInsertRowid);
  for (const u of [alice, eve]) db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?)').run(other, u);
  assert.equal((await fetch(base + att.url, { headers: { 'x-uid': String(eve) } })).status, 404);
  db.prepare("INSERT INTO messages (scope_type, scope_id, author_id, content, forwarded_from_message_id) VALUES ('dm', ?, ?, '', ?)").run(other, alice, sent.message.id);
  const seen = await fetch(base + att.url, { headers: { 'x-uid': String(eve) } });
  assert.equal(seen.status, 200);
  assert.equal(seen.headers.get('content-disposition').startsWith('attachment'), true);
});

test('startup migration seals legacy DM files, names and poll options', () => {
  const { execFileSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-legacy-'));
  const env = { ...process.env, DISMESH_DATA_DIR: dir };
  const dbModule = path.join(__dirname, '..', 'db').split(path.sep).join('/');
  execFileSync(process.execPath, ['-e', `
    const fs = require('node:fs'); const path = require('node:path');
    const { db } = require('${dbModule}');
    db.exec("INSERT INTO users (id, username, email, password_hash, display_name) VALUES (800, 'lg', 'lg@t', 'h', 'lg')");
    db.exec("INSERT INTO dm_channels (id, is_group, created_by) VALUES (800, 0, 800)");
    db.exec("INSERT INTO messages (id, scope_type, scope_id, author_id, content) VALUES (8001, 'dm', 800, 800, 'x')");
    fs.mkdirSync(path.join('${dir.split(path.sep).join('/')}', 'attachments', 'dm-800'), { recursive: true });
    fs.writeFileSync(path.join('${dir.split(path.sep).join('/')}', 'attachments', 'dm-800', 'abcdef-secret.txt'), 'legacy file body');
    db.exec("INSERT INTO attachments (message_id, file_path, file_name, mime_type, size_bytes) VALUES (8001, '/uploads/attachments/dm-800/abcdef-secret.txt', 'secret.txt', 'text/plain', 16)");
    db.exec("INSERT INTO polls (id, message_id, multi_select) VALUES (800, 8001, 0)");
    db.exec("INSERT INTO poll_options (poll_id, position, label) VALUES (800, 0, 'pizza')");
    db.exec("DELETE FROM meta WHERE key = 'dm_files_at_rest_v1'");
    db.close();
  `], { env });
  const out = execFileSync(process.execPath, ['-e', `
    const fs = require('node:fs'); const path = require('node:path');
    const { db } = require('${dbModule}');
    const { open } = require('${path.join(__dirname, '..', 'lib', 'atRest').split(path.sep).join('/')}');
    const { readAll } = require('${path.join(__dirname, '..', 'lib', 'fileSeal').split(path.sep).join('/')}');
    const a = db.prepare('SELECT * FROM attachments WHERE message_id = 8001').get();
    const disk = path.join('${dir.split(path.sep).join('/')}', a.file_path.replace('/uploads/', ''));
    console.log(JSON.stringify({ name: open(a.file_name), rawName: a.file_name.slice(0, 5), url: a.file_path, body: readAll(disk).toString(), old: fs.existsSync(path.join('${dir.split(path.sep).join('/')}', 'attachments', 'dm-800', 'abcdef-secret.txt')), label: db.prepare('SELECT label FROM poll_options WHERE poll_id = 800').get().label.slice(0, 5) }));
    db.close();
  `], { env }).toString().trim().split('\n').pop();
  const r = JSON.parse(out);
  assert.equal(r.name, 'secret.txt');
  assert.equal(r.rawName, 'enc1:');
  assert.match(r.url, /\.bin$/);
  assert.equal(r.body, 'legacy file body');
  assert.equal(r.old, false);
  assert.equal(r.label, 'enc1:');
  fs.rmSync(dir, { recursive: true, force: true });
});
