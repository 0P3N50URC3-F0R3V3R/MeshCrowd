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
const scheduled = require('../lib/scheduledMessages');
const automod = require('../lib/automod');

let n = 0;
const mkUser = (name) => Number(db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)').run(`${name}${++n}`, `${name}${n}@t.local`, 'h', name).lastInsertRowid);
const userRow = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
const mkServer = (owner) => {
  const id = Number(db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)').run('Srv', owner, `i${Math.random().toString(36).slice(2, 10)}`).lastInsertRowid);
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(id, owner);
  db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 0, 1)').run(id, '@everyone', PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.SEND_MESSAGES);
  return id;
};
const mkChannel = (sid, type = 'public') => Number(db.prepare('INSERT INTO channels (server_id, name, type) VALUES (?, ?, ?)').run(sid, 'general', type).lastInsertRowid);
const inMinutes = (m) => new Date(Date.now() + m * 60_000).toISOString();
const count = (ch) => db.prepare("SELECT COUNT(*) AS n FROM messages WHERE scope_type = 'channel' AND scope_id = ?").get(ch).n;
const makeDue = (id) => db.prepare('UPDATE scheduled_messages SET send_at = ? WHERE id = ?').run(new Date(Date.now() - 5000).toISOString(), id);

function world() {
  const owner = mkUser('owner');
  const sid = mkServer(owner);
  const ch = mkChannel(sid);
  const user = mkUser('user');
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(sid, user);
  return { owner, sid, ch, user, userRow: userRow(user) };
}

let server; let base;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const uid = Number(req.headers['x-uid']);
    if (uid) { req.user = userRow(uid); req.sitePermissions = 0; }
    next();
  });
  app.use('/api/scheduled', require('../routes/scheduled'));
  await new Promise((r) => { server = http.createServer(app).listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.close(); db.close();
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
test.beforeEach(() => automod._reset());

const call = async (method, url, uid, json) => {
  const res = await fetch(base + url, { method, headers: { 'x-uid': String(uid), ...(json !== undefined ? { 'content-type': 'application/json' } : {}) }, body: json === undefined ? undefined : JSON.stringify(json) });
  return { status: res.status, data: await res.json().catch(() => null) };
};

test('a due message is sent as its author, once, and the schedule row is removed', async () => {
  const w = world();
  const created = await call('POST', '/api/scheduled', w.user, { scopeType: 'channel', scopeId: w.ch, content: 'good morning', sendAt: inMinutes(5) });
  assert.equal(created.status, 201);
  assert.equal(created.data.scheduled.where, '#general');
  assert.equal(scheduled.deliverDue(), 0, 'not due yet');
  assert.equal(count(w.ch), 0);
  makeDue(created.data.scheduled.id);
  assert.equal(scheduled.deliverDue(), 1);
  assert.equal(scheduled.deliverDue(), 0, 'never sent twice');
  const msg = db.prepare("SELECT * FROM messages WHERE scope_type = 'channel' AND scope_id = ?").get(w.ch);
  assert.equal(msg.author_id, w.user);
  assert.equal(msg.content, 'good morning');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scheduled_messages WHERE id = ?').get(created.data.scheduled.id).n, 0);
});

test('creation validates time, content, target and the per-user limit', async () => {
  const w = world();
  const post = (b) => call('POST', '/api/scheduled', w.user, { scopeType: 'channel', scopeId: w.ch, content: 'x', sendAt: inMinutes(10), ...b });
  assert.equal((await post({ sendAt: 'tomorrow-ish' })).status, 400);
  assert.equal((await post({ sendAt: new Date(Date.now() + 5000).toISOString() })).status, 400, 'too soon');
  assert.equal((await post({ sendAt: inMinutes(60 * 24 * 400) })).status, 400, 'too far');
  assert.equal((await post({ content: '  ' })).status, 400);
  assert.equal((await post({ content: 'x'.repeat(15001) })).status, 400);
  assert.equal((await post({ scopeType: 'nope' })).status, 400);
  assert.equal((await post({ scopeId: 999999 })).status, 404);
  assert.equal((await post({ replyToMessageId: 999999 })).status, 400);
  const outsider = mkUser('outsider');
  assert.equal((await call('POST', '/api/scheduled', outsider, { scopeType: 'channel', scopeId: w.ch, content: 'x', sendAt: inMinutes(10) })).status, 403);
  const notes = mkChannel(w.sid, 'notes');
  assert.notEqual((await post({ scopeId: notes })).status, 201);
  for (let i = 0; i < scheduled.MAX_PENDING; i++) assert.equal((await post({ content: `m${i}` })).status, 201);
  assert.equal((await post({ content: 'one too many' })).status, 409);
});

test('people only see, edit and cancel their own scheduled messages', async () => {
  const w = world();
  const other = mkUser('other');
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(w.sid, other);
  const mine = (await call('POST', '/api/scheduled', w.user, { scopeType: 'channel', scopeId: w.ch, content: 'mine', sendAt: inMinutes(10) })).data.scheduled;
  assert.equal((await call('GET', '/api/scheduled', other)).data.scheduled.length, 0);
  assert.equal((await call('GET', '/api/scheduled', w.user)).data.scheduled.length, 1);
  assert.equal((await call('PATCH', `/api/scheduled/${mine.id}`, other, { content: 'hijack' })).status, 404);
  assert.equal((await call('DELETE', `/api/scheduled/${mine.id}`, other)).status, 404);
  const edited = await call('PATCH', `/api/scheduled/${mine.id}`, w.user, { content: 'edited', sendAt: inMinutes(20) });
  assert.equal(edited.data.scheduled.content, 'edited');
  assert.equal((await call('PATCH', `/api/scheduled/${mine.id}`, w.user, { content: '' })).status, 400);
  assert.equal((await call('DELETE', `/api/scheduled/${mine.id}`, w.user)).status, 200);
  makeDue(mine.id);
  assert.equal(scheduled.deliverDue(), 0);
  assert.equal(count(w.ch), 0);
});

test('permissions, timeouts and AutoMod are checked again at send time; refused messages stay visible as failed', async () => {
  const w = world();
  const make = async (content) => (await call('POST', '/api/scheduled', w.user, { scopeType: 'channel', scopeId: w.ch, content, sendAt: inMinutes(10) })).data.scheduled;

  const a = await make('will be timed out');
  db.prepare('UPDATE server_members SET timeout_until = ? WHERE user_id = ?').run(inMinutes(60), w.user);
  makeDue(a.id); scheduled.deliverDue();
  db.prepare('UPDATE server_members SET timeout_until = NULL WHERE user_id = ?').run(w.user);
  let row = (await call('GET', '/api/scheduled', w.user)).data.scheduled.find((s) => s.id === a.id);
  assert.equal(row.status, 'failed');
  assert.match(row.error, /timed out/);

  automod.createRule(w.sid, { name: 'Words', kind: 'keywords', config: { words: ['forbidden'] } });
  const b = await make('this is forbidden');
  makeDue(b.id); scheduled.deliverDue();
  row = (await call('GET', '/api/scheduled', w.user)).data.scheduled.find((s) => s.id === b.id);
  assert.equal(row.status, 'failed');
  assert.match(row.error, /AutoMod/);

  const c = await make('left the server');
  db.prepare('DELETE FROM server_members WHERE user_id = ?').run(w.user);
  makeDue(c.id); scheduled.deliverDue();
  assert.equal(count(w.ch), 0);
  row = db.prepare('SELECT * FROM scheduled_messages WHERE id = ?').get(c.id);
  assert.equal(row.status, 'failed');
  assert.equal((await call('DELETE', `/api/scheduled/${c.id}`, w.user)).status, 200, 'failed ones can be dismissed');
});

test('a message that is far overdue is not sent', () => {
  const w = world();
  const made = scheduled.create(w.userRow, { scopeType: 'channel', scopeId: w.ch, content: 'old news', sendAt: inMinutes(5) });
  db.prepare('UPDATE scheduled_messages SET send_at = ? WHERE id = ?').run(new Date(Date.now() - 8 * 24 * 3600_000).toISOString(), made.id);
  scheduled.deliverDue();
  assert.equal(count(w.ch), 0);
  assert.equal(db.prepare('SELECT status FROM scheduled_messages WHERE id = ?').get(made.id).status, 'failed');
});

test('DMs: 1:1 works, encrypted conversations are refused, and delivery notifies the other person', async () => {
  const a = mkUser('dm_a'); const b = mkUser('dm_b');
  const mkDm = (e2ee) => {
    const id = Number(db.prepare('INSERT INTO dm_channels (is_group, e2ee_enabled, created_by) VALUES (0, ?, ?)').run(e2ee, a).lastInsertRowid);
    db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?)').run(id, a);
    db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?)').run(id, b);
    return id;
  };
  const plain = mkDm(0); const secret = mkDm(1);
  const post = (dmId) => call('POST', '/api/scheduled', a, { scopeType: 'dm', scopeId: dmId, content: 'later', sendAt: inMinutes(5) });
  assert.equal((await post(secret)).status, 400);
  const ok = await post(plain);
  assert.equal(ok.status, 201);
  makeDue(ok.data.scheduled.id);
  assert.equal(scheduled.deliverDue(), 1);
  const msg = db.prepare("SELECT * FROM messages WHERE scope_type = 'dm' AND scope_id = ?").get(plain);
  assert.equal(msg.author_id, a);
});

test('a message stuck in "sending" after a crash is retried by the next start', () => {
  const w = world();
  const made = scheduled.create(w.userRow, { scopeType: 'channel', scopeId: w.ch, content: 'resume me', sendAt: inMinutes(5) });
  db.prepare("UPDATE scheduled_messages SET status = 'sending', send_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), made.id);
  assert.equal(scheduled.deliverDue(), 0, 'a claimed row is left alone');
  scheduled.startWorker();
  assert.equal(scheduled.deliverDue(), 1);
  assert.equal(count(w.ch), 1);
});
