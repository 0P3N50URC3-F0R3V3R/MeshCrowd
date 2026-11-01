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
const hub = require('../socket/hub');
const { DEFAULT_EVERYONE_PERMISSIONS } = require('../lib/permissions');

const mkUser = (n) => Number(db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)').run(n, `${n}@t.local`, 'h', `Name ${n}`).lastInsertRowid);

let server; let base; let sent; let owner; let author; let reader; let serverId; let channelId;
const realNotifyUser = hub.notifyUser;
test.before(async () => {
  owner = mkUser('rt_owner'); author = mkUser('rt_author'); reader = mkUser('rt_reader');
  serverId = Number(db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)').run('RT', owner, 'rtinv').lastInsertRowid);
  db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 0, 1)').run(serverId, '@everyone', DEFAULT_EVERYONE_PERMISSIONS);
  channelId = Number(db.prepare('INSERT INTO channels (server_id, name, type) VALUES (?, ?, ?)').run(serverId, 'general', 'public').lastInsertRowid);
  for (const u of [owner, author, reader]) db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(serverId, u);
  for (const u of [author, reader]) require('../lib/notifications').setPref(u, 'channel', channelId, 'all');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.headers['x-uid'])); next(); });
  app.use('/api/servers/:id/channels/:channelId/threads', require('../routes/threads'));
  app.use('/api/messages', require('../routes/messages'));
  app.use(require('../middleware/errorHandler').errorHandler);
  await new Promise((r) => { server = http.createServer(app).listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.beforeEach(() => { sent = []; hub.notifyUser = (userId, payload) => { if (payload.type === 'notify') sent.push({ userId, payload }); }; });
test.after(async () => { hub.notifyUser = realNotifyUser; server.close(); await new Promise((r) => setTimeout(r, 100)); db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

const call = async (method, url, uid, json) => {
  const res = await fetch(base + url, { method, headers: { 'x-uid': String(uid), 'content-type': 'application/json' }, body: json ? JSON.stringify(json) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
};
const post = (uid, content) => Number(db.prepare('INSERT INTO messages (scope_type, scope_id, author_id, content) VALUES (?, ?, ?, ?)').run('channel', channelId, uid, content).lastInsertRowid);

test('starting a thread from a message notifies its author, not the starter; forum-style posts notify nobody', async () => {
  const mid = post(author, 'source message');
  const res = await call('POST', `/api/servers/${serverId}/channels/${channelId}/threads`, owner, { title: 'Side talk', content: 'first', parentMessageId: mid });
  assert.equal(res.status, 201);
  assert.deepEqual(sent.map((s) => s.userId), [author]);
  assert.equal(sent[0].payload.kind, 'thread');
  assert.equal(sent[0].payload.threadId, res.data.thread.id);
  assert.equal(sent[0].payload.actor.displayName, 'Name rt_owner');

  sent = [];
  const own = post(owner, 'my own');
  await call('POST', `/api/servers/${serverId}/channels/${channelId}/threads`, owner, { title: 'Mine', content: 'x', parentMessageId: own });
  await call('POST', `/api/servers/${serverId}/channels/${channelId}/threads`, owner, { title: 'Post', content: 'x' });
  assert.equal(sent.length, 0);
});

test('pinning notifies other viewers once; re-pinning and unpinning stay silent', async () => {
  const mid = post(author, 'pin target');
  const res = await call('PUT', `/api/messages/${mid}/pin`, owner);
  assert.equal(res.status, 200);
  assert.deepEqual(sent.map((s) => s.userId).sort(), [author, reader].sort());
  assert.ok(sent.every((s) => s.payload.kind === 'pin' && s.payload.message.id === mid));

  sent = [];
  await call('PUT', `/api/messages/${mid}/pin`, owner);
  await call('DELETE', `/api/messages/${mid}/pin`, owner);
  assert.equal(sent.length, 0);
});
