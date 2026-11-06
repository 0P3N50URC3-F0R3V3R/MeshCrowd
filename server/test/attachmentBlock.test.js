'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const express = require('express');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const { db } = require('../db');
const { PERMISSIONS } = require('../lib/permissions');

let n = 0;
const mkUser = (name) => Number(db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)').run(`${name}${++n}`, `${name}${n}@t.local`, 'h', name).lastInsertRowid);
const mkServer = (owner) => {
  const id = Number(db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)').run('Srv', owner, `i${Math.random().toString(36).slice(2, 10)}`).lastInsertRowid);
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(id, owner);
  db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 0, 1)').run(id, '@everyone', PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.SEND_MESSAGES | PERMISSIONS.ATTACH_FILES);
  return id;
};
const mkChannel = (sid) => Number(db.prepare('INSERT INTO channels (server_id, name, type) VALUES (?, ?, ?)').run(sid, 'general', 'public').lastInsertRowid);

let server; let base;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const uid = Number(req.headers['x-uid']);
    if (uid) { req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid); req.sitePermissions = 0; }
    next();
  });
  app.use('/api/servers/:id/channels/:channelId/messages', require('../routes/channelMessages'));
  app.use(require('../middleware/errorHandler').errorHandler);
  await new Promise((r) => { server = http.createServer(app).listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.close(); db.close();
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function world() {
  const owner = mkUser('owner');
  const sid = mkServer(owner);
  return { owner, sid, ch: mkChannel(sid) };
}
async function send(w, name) {
  const fd = new FormData();
  fd.append('content', 'hi');
  fd.append('files', new Blob([Buffer.alloc(100, 1)], { type: 'application/octet-stream' }), name);
  const res = await fetch(`${base}/api/servers/${w.sid}/channels/${w.ch}/messages`, { method: 'POST', headers: { 'x-uid': String(w.owner) }, body: fd });
  return { status: res.status, data: await res.json() };
}

test('executable attachments are rejected loudly, not silently dropped', async () => {
  const w = world();
  for (const name of ['setup.exe', 'run.bat', 'x.com', 'y.cmd']) {
    const r = await send(w, name);
    assert.equal(r.status, 400, name);
    assert.match(r.data.error, /not allowed/);
  }
  assert.equal(db.prepare('SELECT COUNT(*) c FROM messages WHERE scope_id = ?').get(w.ch).c, 0);
});

test('ordinary attachments still go through', async () => {
  const w = world();
  const r = await send(w, 'notes.txt');
  assert.equal(r.status, 201);
});

test('the upload limit is one live setting shared by config and the uploads', async () => {
  const cfg = require('../lib/config');
  const before = cfg.load().maxUploadMb;
  const w = world();
  const sendBytes = async (n) => {
    const fd = new FormData();
    fd.append('content', 'x');
    fd.append('files', new Blob([Buffer.alloc(n, 1)]), 'a.txt');
    const res = await fetch(`${base}/api/servers/${w.sid}/channels/${w.ch}/messages`, { method: 'POST', headers: { 'x-uid': String(w.owner) }, body: fd });
    return res.status;
  };
  try {
    cfg.save({ maxUploadMb: 0.001 });
    assert.equal(await sendBytes(5000), 400);
    cfg.save({ maxUploadMb: 1 });
    assert.equal(await sendBytes(5000), 201);
    assert.equal(require('../lib/uploads').effectiveMaxUploadMb(), 1);
  } finally { cfg.save({ maxUploadMb: before }); }
});

test('a legacy admin-panel cap is folded into the config value once', () => {
  const cfg = require('../lib/config');
  const siteSettings = require('../lib/siteSettings');
  const uploads = require('../lib/uploads');
  const before = cfg.load().maxUploadMb;
  try {
    cfg.save({ maxUploadMb: 25 });
    siteSettings.set('max_upload_mb', 10);
    uploads.migrateUploadLimit();
    assert.equal(cfg.load().maxUploadMb, 10);
    uploads.migrateUploadLimit();
    assert.equal(cfg.load().maxUploadMb, 10);
  } finally { cfg.save({ maxUploadMb: before }); }
});
