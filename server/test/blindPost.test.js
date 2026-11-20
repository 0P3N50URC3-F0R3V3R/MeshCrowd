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
const { DEFAULT_EVERYONE_PERMISSIONS } = require('../lib/permissions');

let n = 0;
const mkUser = (name) => Number(db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)').run(`${name}${++n}`, `${name}${n}@t.local`, 'h', name).lastInsertRowid);

let server; let base;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const uid = Number(req.headers['x-uid']);
    if (uid) { req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid); req.sitePermissions = 0; }
    next();
  });
  app.use('/api/servers', require('../routes/servers'));
  app.use('/api/servers/:id/channels/:channelId/messages', require('../routes/channelMessages'));
  app.use('/api/servers/:id/channels/:channelId/threads', require('../routes/threads'));
  await new Promise((r) => { server = http.createServer(app).listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); });

const post = async (uid, url, json) => (await fetch(base + url, { method: 'POST', headers: { 'x-uid': String(uid), 'content-type': 'application/json' }, body: JSON.stringify(json) })).status;

test('a member who cannot view a channel cannot post or reply into it', async () => {
  const owner = mkUser('owner'); const member = mkUser('member');
  const sid = Number(db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)').run('S', owner, 'inv').lastInsertRowid);
  db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 0, 1)').run(sid, '@everyone', DEFAULT_EVERYONE_PERMISSIONS);
  for (const u of [owner, member]) db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(sid, u);
  const priv = Number(db.prepare('INSERT INTO channels (server_id, name, type) VALUES (?, ?, ?)').run(sid, 'secret', 'private').lastInsertRowid);
  const pub = Number(db.prepare('INSERT INTO channels (server_id, name, type) VALUES (?, ?, ?)').run(sid, 'open', 'public').lastInsertRowid);
  const seed = Number(db.prepare("INSERT INTO messages (scope_type, scope_id, author_id, content) VALUES ('channel', ?, ?, 'secret')").run(priv, owner).lastInsertRowid);

  assert.equal(await post(member, `/api/servers/${sid}/channels/${priv}/messages`, { content: 'blind' }), 403);
  assert.equal(await post(member, `/api/servers/${sid}/channels/${priv}/messages`, { content: 'blind', replyToMessageId: seed }), 403);
  assert.equal(await post(member, `/api/servers/${sid}/channels/${priv}/threads`, { title: 't', content: 'blind' }), 403);
  assert.equal(await post(owner, `/api/servers/${sid}/channels/${priv}/messages`, { content: 'ok' }), 201);
  assert.equal(await post(member, `/api/servers/${sid}/channels/${pub}/messages`, { content: 'ok' }), 201);
});

test('timing a member out needs an explicit duration', async () => {
  const owner = mkUser('own'); const member = mkUser('mem');
  const sid = Number(db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)').run('S2', owner, 'inv2').lastInsertRowid);
  db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 0, 1)').run(sid, '@everyone', DEFAULT_EVERYONE_PERMISSIONS);
  for (const u of [owner, member]) db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(sid, u);
  const put = async (json) => (await fetch(`${base}/api/servers/${sid}/members/${member}/timeout`, { method: 'PUT', headers: { 'x-uid': String(owner), 'content-type': 'application/json' }, body: JSON.stringify(json) })).status;
  assert.equal(await put({}), 400);
  assert.equal(await put({ minutes: 'x' }), 400);
  assert.equal(await put({ minutes: -5 }), 400);
  assert.equal(await put({ minutes: 10 }), 200);
});
