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
const { PERMISSIONS, SITE_PERMISSIONS } = require('../lib/permissions');
const hub = require('../socket/hub');

const events = [];
hub.broadcastToChannel = (channel, payload) => { events.push({ channelId: channel.id, ...payload }); };

let n = 0;
const mkUser = (name) => Number(db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)').run(`${name}${++n}`, `${name}${n}@t.local`, 'h', name).lastInsertRowid);

let w; let server; let base; let sitePerms = {};
test.before(async () => {
  const owner = mkUser('owner');
  const sid = Number(db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)').run('Srv', owner, 'inv-forum').lastInsertRowid);
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(sid, owner);
  db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 0, 1)').run(sid, '@everyone', PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.SEND_MESSAGES | PERMISSIONS.READ_MESSAGE_HISTORY);
  const modRole = Number(db.prepare('INSERT INTO roles (server_id, name, permissions, position) VALUES (?, ?, ?, 1)').run(sid, 'Mod', PERMISSIONS.MANAGE_MESSAGES).lastInsertRowid);
  const ch = Number(db.prepare('INSERT INTO channels (server_id, name, type) VALUES (?, ?, ?)').run(sid, 'forum', 'forum').lastInsertRowid);
  const mk = (name) => { const id = mkUser(name); db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(sid, id); return id; };
  const author = mk('author'); const other = mk('other'); const mod = mk('mod'); const siteAdmin = mk('siteadmin');
  db.prepare('INSERT INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)').run(sid, mod, modRole);
  sitePerms[siteAdmin] = SITE_PERMISSIONS.DELETE_ANY_MESSAGE;
  w = { sid, ch, owner, author, other, mod, siteAdmin };

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const uid = Number(req.headers['x-uid']);
    if (uid) { req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid); req.sitePermissions = sitePerms[uid] || 0; }
    next();
  });
  app.use('/api/servers/:id/channels/:channelId/threads', require('../routes/threads'));
  app.use('/api/messages', require('../routes/messages'));
  await new Promise((r) => { server = http.createServer(app).listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.close(); db.close();
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const call = async (method, url, uid, json) => {
  const res = await fetch(base + url, { method, headers: { 'x-uid': String(uid), ...(json !== undefined ? { 'content-type': 'application/json' } : {}) }, body: json === undefined ? undefined : JSON.stringify(json) });
  return { status: res.status, data: await res.json().catch(() => null) };
};
const tUrl = (id = '') => `/api/servers/${w.sid}/channels/${w.ch}/threads${id ? `/${id}` : ''}`;
const newPost = async (uid, title = 'Post') => (await call('POST', tUrl(), uid, { title, content: 'opening' })).data;

test('creating a post broadcasts the message before the thread so live counts are not double counted', async () => {
  events.length = 0;
  const { thread } = await newPost(w.author);
  const types = events.map((e) => e.type);
  assert.ok(types.indexOf('message_create') < types.indexOf('thread_create'));
  assert.equal(thread.messageCount, 1);
});

test('author edits own post title and opening message; others get 403, including MANAGE_MESSAGES holders', async () => {
  const { thread } = await newPost(w.author);
  events.length = 0;
  const ok = await call('PATCH', tUrl(thread.id), w.author, { title: 'New title', content: 'new opening' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.thread.title, 'New title');
  assert.equal(ok.data.thread.preview.content, 'new opening');
  assert.ok(events.some((e) => e.type === 'thread_update' && e.thread.title === 'New title'));
  assert.ok(events.some((e) => e.type === 'message_update' && e.message.content === 'new opening' && e.message.editedAt));
  assert.equal((await call('PATCH', tUrl(thread.id), w.other, { title: 'hax' })).status, 403);
  assert.equal((await call('PATCH', tUrl(thread.id), w.mod, { title: 'hax' })).status, 403);
  assert.equal((await call('PATCH', tUrl(thread.id), w.siteAdmin, { content: 'hax' })).status, 403);
  assert.equal(db.prepare('SELECT title FROM threads WHERE id = ?').get(thread.id).title, 'New title');
});

test('author deletes own post and it is audited and broadcast', async () => {
  const { thread } = await newPost(w.author);
  events.length = 0;
  assert.equal((await call('DELETE', tUrl(thread.id), w.author)).status, 200);
  assert.equal(db.prepare('SELECT 1 FROM threads WHERE id = ?').get(thread.id), undefined);
  assert.ok(events.some((e) => e.type === 'thread_delete' && e.threadId === thread.id));
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE server_id = ? AND action = 'thread_delete'").get(w.sid));
});

test('a regular member cannot delete someone else\'s post', async () => {
  const { thread } = await newPost(w.author);
  assert.equal((await call('DELETE', tUrl(thread.id), w.other)).status, 403);
  assert.ok(db.prepare('SELECT 1 FROM threads WHERE id = ?').get(thread.id));
});

test('MANAGE_MESSAGES holder and site DELETE_ANY_MESSAGE holder can delete others\' posts', async () => {
  const a = (await newPost(w.author)).thread;
  const b = (await newPost(w.author)).thread;
  assert.equal((await call('DELETE', tUrl(a.id), w.mod)).status, 200);
  assert.equal((await call('DELETE', tUrl(b.id), w.siteAdmin)).status, 200);
});

test('deleting a reply broadcasts a fresh thread_update so every viewer sees the new count', async () => {
  const { thread } = await newPost(w.author);
  const reply = await call('POST', `${tUrl(thread.id)}/messages`, w.other, { content: 'a reply' });
  assert.equal(reply.status, 201);
  events.length = 0;
  assert.equal((await call('DELETE', `/api/messages/${reply.data.message.id}`, w.other)).status, 200);
  const upd = events.find((e) => e.type === 'thread_update');
  assert.equal(upd.thread.id, thread.id);
  assert.equal(upd.thread.messageCount, 1);
});
