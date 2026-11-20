'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const express = require('express');
const WebSocket = require('ws');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const { db } = require('../db');
const { PERMISSIONS, DEFAULT_EVERYONE_PERMISSIONS } = require('../lib/permissions');
const automod = require('../lib/automod');
const socket = require('../socket');
const { createSession } = require('../lib/session');

let n = 0;
const mkUser = (name) => Number(db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)').run(`${name}${++n}`, `${name}${n}@t.local`, 'h', name).lastInsertRowid);

function mkServer(owner, members, { type = 'public', level = 0 } = {}) {
  const sid = Number(db.prepare('INSERT INTO servers (name, owner_id, invite_code, verification_level) VALUES (?, ?, ?, ?)').run('S', owner, `i${Math.random()}`, level).lastInsertRowid);
  db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 0, 1)').run(sid, '@everyone', DEFAULT_EVERYONE_PERMISSIONS);
  for (const u of [owner, ...members]) db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(sid, u);
  const cid = Number(db.prepare('INSERT INTO channels (server_id, name, type) VALUES (?, ?, ?)').run(sid, 'c', type).lastInsertRowid);
  return { sid, cid };
}
function grant(sid, userId, bits, position = 1) {
  const rid = Number(db.prepare('INSERT INTO roles (server_id, name, permissions, position) VALUES (?, ?, ?, ?)').run(sid, `r${Math.random()}`, bits, position).lastInsertRowid);
  db.prepare('INSERT INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)').run(sid, userId, rid);
}
function mkDm(users) {
  const id = Number(db.prepare('INSERT INTO dm_channels (is_group, created_by) VALUES (0, ?)').run(users[0]).lastInsertRowid);
  for (const u of users) db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?)').run(id, u);
  return id;
}
const block = (by, target) => {
  const [a, b] = by < target ? [by, target] : [target, by];
  db.prepare("INSERT INTO friendships (user_a, user_b, status, requested_by) VALUES (?, ?, 'blocked', ?)").run(a, b, by);
};

let server; let base; let wsServer; let wsPort;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const uid = Number(req.headers['x-uid']);
    if (uid) { req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid); req.sitePermissions = 0; }
    next();
  });
  app.use('/api/search', require('../routes/globalSearch'));
  app.use('/api/polls', require('../routes/polls'));
  app.use('/api/checklists', require('../routes/checklists'));
  app.use('/api/messages', require('../routes/messages'));
  app.use('/api/servers', require('../routes/servers'));
  await new Promise((r) => { server = http.createServer(app).listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  wsServer = http.createServer();
  socket.attach(wsServer);
  await new Promise((r) => wsServer.listen(0, '127.0.0.1', r));
  wsPort = wsServer.address().port;
});
test.after(async () => {
  server.close(); await new Promise((r) => wsServer.close(r));
  await new Promise((r) => setTimeout(r, 500));
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const call = async (method, url, uid, json) => {
  const res = await fetch(base + url, { method, headers: { 'x-uid': String(uid), ...(json !== undefined ? { 'content-type': 'application/json' } : {}) }, body: json === undefined ? undefined : JSON.stringify(json) });
  return { status: res.status, data: await res.json().catch(() => null) };
};

test('global search answers 200 and hides private and age-restricted channels', async () => {
  const owner = mkUser('gs_o'); const member = mkUser('gs_m');
  const { sid, cid } = mkServer(owner, [member]);
  const priv = Number(db.prepare("INSERT INTO channels (server_id, name, type) VALUES (?, 'p', 'private')").run(sid).lastInsertRowid);
  const nsfw = Number(db.prepare("INSERT INTO channels (server_id, name, type, nsfw) VALUES (?, 'n', 'public', 1)").run(sid).lastInsertRowid);
  for (const c of [cid, priv, nsfw]) db.prepare("INSERT INTO messages (scope_type, scope_id, author_id, content) VALUES ('channel', ?, ?, 'needle')").run(c, owner);
  const res = await call('GET', `/api/search?serverId=${sid}&q=needle`, member);
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.messages.map((m) => m.scopeId), [cid]);
});

test('polls, checklists and forwards honour a DM block, server verification and AutoMod', async () => {
  const owner = mkUser('sg_o'); const alice = mkUser('sg_a'); const bob = mkUser('sg_b');
  const { sid, cid } = mkServer(owner, [alice]);
  const dm = mkDm([alice, bob]);
  block(bob, alice);
  const src = Number(db.prepare("INSERT INTO messages (scope_type, scope_id, author_id, content) VALUES ('channel', ?, ?, 'hello')").run(cid, owner).lastInsertRowid);

  assert.equal((await call('POST', '/api/polls', alice, { scopeType: 'dm', scopeId: dm, question: 'q?', options: ['a', 'b'] })).status, 403);
  assert.equal((await call('POST', '/api/checklists', alice, { scopeType: 'dm', scopeId: dm, title: 't', items: ['x'] })).status, 403);
  const dmSrc = Number(db.prepare("INSERT INTO messages (scope_type, scope_id, author_id, content) VALUES ('channel', ?, ?, 'x')").run(cid, alice).lastInsertRowid);
  assert.equal((await call('POST', `/api/messages/${dmSrc}/forward`, alice, { scopeType: 'dm', scopeId: dm })).status, 403);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM messages WHERE scope_type = 'dm' AND scope_id = ?").get(dm).c, 0);

  db.prepare('UPDATE servers SET verification_level = 3 WHERE id = ?').run(sid);
  const gated = await call('POST', '/api/polls', alice, { scopeType: 'channel', scopeId: cid, question: 'q?', options: ['a', 'b'] });
  assert.equal(gated.status, 403);
  assert.equal(gated.data.error.includes('verification'), true);
  assert.equal((await call('POST', `/api/messages/${src}/forward`, alice, { scopeType: 'channel', scopeId: cid })).status, 403);
  db.prepare('UPDATE servers SET verification_level = 0 WHERE id = ?').run(sid);

  automod.createRule(sid, { name: 'w', kind: 'keywords', config: { words: ['forbidden'], wholeWord: true } });
  assert.equal((await call('POST', '/api/polls', alice, { scopeType: 'channel', scopeId: cid, question: 'a forbidden word', options: ['a', 'b'] })).status, 403);
  assert.equal((await call('POST', '/api/checklists', alice, { scopeType: 'channel', scopeId: cid, title: 't', items: ['forbidden'] })).status, 403);
  assert.equal((await call('POST', `/api/messages/${src}/forward`, alice, { scopeType: 'channel', scopeId: cid, comment: 'forbidden' })).status, 403);
  assert.equal((await call('POST', '/api/polls', alice, { scopeType: 'channel', scopeId: cid, question: 'fine', options: ['a', 'b'] })).status, 201);
});

test('a message can carry at most 20 different reactions', async () => {
  const owner = mkUser('rx_o'); const member = mkUser('rx_m');
  const { cid } = mkServer(owner, [member]);
  const msg = Number(db.prepare("INSERT INTO messages (scope_type, scope_id, author_id, content) VALUES ('channel', ?, ?, 'hi')").run(cid, owner).lastInsertRowid);
  for (let i = 0; i < 20; i++) assert.equal((await call('PUT', `/api/messages/${msg}/reactions/e${i}`, member)).status, 200);
  assert.equal((await call('PUT', `/api/messages/${msg}/reactions/e20`, member)).status, 400);
  assert.equal((await call('PUT', `/api/messages/${msg}/reactions/e3`, owner)).status, 200);
});

test('a moderator cannot lift their own timeout or one on a higher-ranked member', async () => {
  const owner = mkUser('to_o'); const mod = mkUser('to_m'); const admin = mkUser('to_a'); const plain = mkUser('to_p');
  const { sid } = mkServer(owner, [mod, admin, plain]);
  grant(sid, mod, PERMISSIONS.MODERATE_MEMBERS);
  grant(sid, admin, PERMISSIONS.MODERATE_MEMBERS | PERMISSIONS.BAN_MEMBERS);
  const until = new Date(Date.now() + 3600_000).toISOString();
  const stamp = (u) => db.prepare('UPDATE server_members SET timeout_until = ? WHERE server_id = ? AND user_id = ?').run(until, sid, u);
  const timeoutOf = (u) => db.prepare('SELECT timeout_until FROM server_members WHERE server_id = ? AND user_id = ?').get(sid, u).timeout_until;

  stamp(mod);
  assert.equal((await call('DELETE', `/api/servers/${sid}/members/${mod}/timeout`, mod)).status, 403);
  assert.equal(timeoutOf(mod), until);
  stamp(admin);
  assert.equal((await call('DELETE', `/api/servers/${sid}/members/${admin}/timeout`, mod)).status, 403);
  stamp(plain);
  assert.equal((await call('DELETE', `/api/servers/${sid}/members/${plain}/timeout`, mod)).status, 200);
  assert.equal(timeoutOf(plain), null);
  assert.equal((await call('DELETE', `/api/servers/${sid}/members/${mod}/timeout`, owner)).status, 200);
});

test('a member without rank cannot rename the owner or a higher-ranked member', async () => {
  const owner = mkUser('nk_o'); const mod = mkUser('nk_m'); const plain = mkUser('nk_p');
  const { sid } = mkServer(owner, [mod, plain]);
  grant(sid, mod, PERMISSIONS.MANAGE_NICKNAMES);
  assert.equal((await call('PATCH', `/api/servers/${sid}/members/${owner}/nickname`, mod, { nickname: 'x' })).status, 403);
  assert.equal((await call('PATCH', `/api/servers/${sid}/members/${plain}/nickname`, mod, { nickname: 'x' })).status, 200);
});

test('invite-direct does not add someone who blocked the inviter', async () => {
  const owner = mkUser('id_o'); const target = mkUser('id_t'); const other = mkUser('id_x');
  const { sid } = mkServer(owner, []);
  block(target, owner);
  assert.equal((await call('POST', `/api/servers/${sid}/invite-direct`, owner, { userId: target })).status, 404);
  assert.equal(db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(sid, target), undefined);
  assert.equal((await call('POST', `/api/servers/${sid}/invite-direct`, owner, { userId: other })).status, 200);
});

test('a websocket message with a wrongly typed id is dropped without taking the process down', async () => {
  const uid = mkUser('ws_u');
  const ws = await new Promise((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${wsPort}/ws`, { headers: { cookie: `dismesh_session=${createSession(uid, 'test', '127.0.0.1').token}` } });
    s.frames = [];
    s.on('message', (raw) => s.frames.push(JSON.parse(raw.toString())));
    s.once('open', () => resolve(s));
    s.once('error', reject);
  });
  for (const body of [
    { type: 'typing', scopeType: 'dm', scopeId: { a: 1 } },
    { type: 'typing', scopeType: 'channel', scopeId: [1, 2] },
    { type: 'voice_join', dmChannelId: { a: 1 } },
    { type: 'voice_leave', channelId: { a: 1 } },
    { type: 'wb_sync', channelId: [1] },
    { type: 'stage_raise_hand', channelId: { a: 1 } },
  ]) ws.send(JSON.stringify(body));
  ws.send(JSON.stringify({ type: 'ping' }));
  const end = Date.now() + 2000;
  while (!ws.frames.some((f) => f.type === 'pong') && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  assert.ok(ws.frames.some((f) => f.type === 'pong'));
  ws.close();
});
