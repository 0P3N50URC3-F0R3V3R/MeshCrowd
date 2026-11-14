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
const sent = [];
hub.notifyUser = (userId, payload) => sent.push({ userId, payload });

const mkUser = (n, extra = '') => Number(db.prepare(`INSERT INTO users (username, email, password_hash, display_name${extra ? ', ' + extra.split('=')[0] : ''}) VALUES (?, ?, ?, ?${extra ? ', ?' : ''})`)
  .run(...[n, `${n}@t.local`, 'h', n, ...(extra ? [extra.split('=')[1]] : [])]).lastInsertRowid);
const mkDm = (users, isGroup = 0, e2ee = 0) => {
  const id = Number(db.prepare('INSERT INTO dm_channels (is_group, created_by, e2ee_enabled) VALUES (?, ?, ?)').run(isGroup, users[0], e2ee).lastInsertRowid);
  for (const u of users) db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?)').run(id, u);
  return id;
};
const members = (dmId) => db.prepare('SELECT user_id FROM dm_members WHERE dm_channel_id = ? ORDER BY user_id').all(dmId).map((r) => r.user_id);

let server; let base;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const uid = Number(req.headers['x-uid']);
    if (uid) req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
    next();
  });
  app.use('/api/dms', require('../routes/dms'));
  await new Promise((r) => { server = http.createServer(app).listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.beforeEach(() => { sent.length = 0; });
test.after(async () => {
  server.close(); db.close();
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function call(method, url, uid, json) {
  const headers = { 'x-uid': String(uid) };
  if (json !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(base + url, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, data };
}

test('adding to a 1:1 starts a new group and leaves the 1:1 untouched', async () => {
  const a = mkUser('d1_a'); const b = mkUser('d1_b'); const c = mkUser('d1_c');
  const dm = mkDm([a, b]);
  const r = await call('POST', `/api/dms/${dm}/members`, a, { userIds: [c], name: 'Trio' });
  assert.equal(r.status, 201);
  assert.equal(r.data.created, true);
  assert.notEqual(r.data.dmId, dm);
  assert.deepEqual(members(r.data.dmId), [a, b, c].sort((x, y) => x - y));
  assert.deepEqual(members(dm), [a, b]);
  const row = db.prepare('SELECT * FROM dm_channels WHERE id = ?').get(r.data.dmId);
  assert.equal(row.is_group, 1); assert.equal(row.created_by, a); assert.equal(row.name, 'Trio');
  assert.deepEqual(sent.map((s) => s.userId).sort(), [b, c].sort());
  assert.ok(sent.every((s) => s.payload.type === 'dm_create' && s.payload.dm.isGroup));
});

test('adding to a group adds in place and tells everyone', async () => {
  const a = mkUser('d2_a'); const b = mkUser('d2_b'); const c = mkUser('d2_c'); const d = mkUser('d2_d');
  const dm = mkDm([a, b, c], 1);
  const r = await call('POST', `/api/dms/${dm}/members`, b, { userIds: [d] });
  assert.equal(r.status, 200); assert.equal(r.data.created, false); assert.equal(r.data.dmId, dm);
  assert.deepEqual(members(dm), [a, b, c, d].sort((x, y) => x - y));
  assert.deepEqual(sent.filter((s) => s.payload.type === 'dm_update').map((s) => s.userId).sort(), [a, b, c].sort());
  assert.deepEqual(sent.filter((s) => s.payload.type === 'dm_create').map((s) => s.userId), [d]);
  const forD = sent.find((s) => s.userId === d).payload.dm;
  assert.equal(forD.members.length, 3);
});

test('refusals: non-member, nobody new, bot, e2ee, missing user, over the 10 cap, blocked/closed privacy', async () => {
  const a = mkUser('d3_a'); const b = mkUser('d3_b'); const c = mkUser('d3_c'); const out = mkUser('d3_out');
  const bot = mkUser('d3_bot', 'is_bot=1');
  const closed = mkUser('d3_closed', "dm_privacy=none");
  const dm = mkDm([a, b, c], 1);
  assert.equal((await call('POST', `/api/dms/${dm}/members`, out, { userIds: [a] })).status, 403);
  assert.equal((await call('POST', `/api/dms/${dm}/members`, a, { userIds: [b, a] })).status, 400);
  assert.equal((await call('POST', `/api/dms/${dm}/members`, a, { userIds: [bot] })).status, 400);
  assert.equal((await call('POST', `/api/dms/${dm}/members`, a, { userIds: [99999] })).status, 404);
  assert.equal((await call('POST', `/api/dms/${dm}/members`, a, { userIds: [closed] })).status, 403);
  assert.equal((await call('POST', `/api/dms/${mkDm([a, b], 0, 1)}/members`, a, { userIds: [out] })).status, 400);
  const many = Array.from({ length: 8 }, (_, i) => mkUser(`d3_m${i}`));
  assert.equal((await call('POST', `/api/dms/${dm}/members`, a, { userIds: many })).status, 400, '3 + 8 > 10');
  assert.deepEqual(members(dm), [a, b, c].sort((x, y) => x - y));
  assert.equal((await call('POST', `/api/dms/${dm}/members`, a, { userIds: many.slice(0, 7) })).status, 200, '3 + 7 = 10 fits');
});

test('the new group shows up in the normal DM list of every member', async () => {
  const a = mkUser('d4_a'); const b = mkUser('d4_b'); const c = mkUser('d4_c');
  const r = await call('POST', `/api/dms/${mkDm([a, b])}/members`, a, { userIds: [c] });
  for (const u of [a, b, c]) {
    const list = (await call('GET', '/api/dms', u)).data.dms;
    const g = list.find((d) => d.id === r.data.dmId);
    assert.ok(g, `user ${u} sees the group`);
    assert.equal(g.isGroup, true);
    assert.equal(g.members.length, 2);
  }
});
