'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const express = require('express');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const { db } = require('../db');
const { attachUser } = require('../middleware/auth');
const { SITE_PERMISSIONS } = require('../lib/permissions');
const accounts = require('../lib/accounts');
const { toPublicUser } = require('../lib/publicUser');
const { isInvisible } = require('../lib/invisible');

const app = express();
app.use(express.json());
app.use(attachUser);
app.use((req, res, next) => {
  const uid = Number(req.headers['x-uid']);
  if (uid) { req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid); req.sitePermissions = SITE_PERMISSIONS.SITE_ADMINISTRATOR | SITE_PERMISSIONS.VIEW_ADMIN_PANEL; }
  next();
});
app.use('/api/auth', require('../routes/auth'));
app.use('/api/users', require('../routes/users'));
app.use('/api/read-state', require('../routes/readState'));
app.use('/api/messages', require('../routes/messages'));
app.use('/api/dms', require('../routes/dms'));
app.use('/api/admin', require('../routes/admin'));
app.use(require('../middleware/errorHandler').errorHandler);
let server; let base;
const ids = {}; const cookies = {};

async function call(method, url, body, who) {
  const headers = { 'content-type': 'application/json', 'x-uid': String(ids[who]) };
  const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test.before(async () => {
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  for (const name of ['pf_a', 'pf_b']) ids[name] = accounts.createAccount({ username: name, email: `${name}@t.co`, password: 'password123' }).userId;
});
test.after(() => { server.close(); db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

const makeDm = () => {
  const dmId = db.prepare('INSERT INTO dm_channels (is_group, created_by) VALUES (0, ?)').run(ids.pf_a).lastInsertRowid;
  db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?), (?, ?)').run(dmId, ids.pf_a, dmId, ids.pf_b);
  return dmId;
};

test('invisible users hide their custom status from others but not from themselves', () => {
  db.prepare("UPDATE users SET status = 'invisible', custom_status_text = 'brb', custom_status_emoji = 'x' WHERE id = ?").run(ids.pf_a);
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(ids.pf_a);
  assert.equal(isInvisible(ids.pf_a), true);
  assert.equal(toPublicUser(row, {}).customStatusText, '');
  assert.equal(toPublicUser(row, { viewerIsSelf: true }).customStatusText, 'brb');
  db.prepare("UPDATE users SET status = 'online' WHERE id = ?").run(ids.pf_a);
  assert.equal(toPublicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(ids.pf_a), {}).customStatusText, 'brb');
});

test('read receipts do not advance while the reader is invisible and stay hidden afterwards', async () => {
  const dmId = makeDm();
  const m1 = db.prepare("INSERT INTO messages (scope_type, scope_id, author_id, content) VALUES ('dm', ?, ?, 'one')").run(dmId, ids.pf_b).lastInsertRowid;
  const m2 = db.prepare("INSERT INTO messages (scope_type, scope_id, author_id, content) VALUES ('dm', ?, ?, 'two')").run(dmId, ids.pf_b).lastInsertRowid;
  const seenByB = async () => (await call('GET', '/api/dms', null, 'pf_b')).body.dms.find((d) => d.id === dmId).readStates.find((r) => r.userId === ids.pf_a)?.lastReadMessageId;

  await call('PUT', '/api/users/me/status', { status: 'online' }, 'pf_a');
  await call('PUT', `/api/read-state/dm/${dmId}`, { messageId: Number(m1) }, 'pf_a');
  assert.equal(await seenByB(), Number(m1));

  await call('PUT', '/api/users/me/status', { status: 'invisible' }, 'pf_a');
  await call('PUT', `/api/read-state/dm/${dmId}`, { messageId: Number(m2) }, 'pf_a');
  assert.equal(await seenByB(), Number(m1));
  const own = (await call('GET', '/api/read-state', null, 'pf_a')).body.state.find((r) => r.scopeId === dmId);
  assert.equal(own.lastReadMessageId, Number(m2));

  await call('PUT', '/api/users/me/status', { status: 'online' }, 'pf_a');
  assert.equal(await seenByB(), Number(m1));
  await call('PUT', `/api/read-state/dm/${dmId}`, { messageId: Number(m2) }, 'pf_a');
  assert.equal(await seenByB(), Number(m2));
});

test('stranger view of own profile drops private fields and mutual data', async () => {
  const mine = await call('GET', `/api/users/${ids.pf_a}`, null, 'pf_a');
  assert.ok('email' in mine.body.user);
  const stranger = await call('GET', `/api/users/${ids.pf_a}?as=stranger`, null, 'pf_a');
  assert.equal('email' in stranger.body.user, false);
  assert.deepEqual(stranger.body.user.mutualServers, []);
  const other = await call('GET', `/api/users/${ids.pf_a}?as=stranger`, null, 'pf_b');
  assert.equal('email' in other.body.user, false);
});

test('admin can edit a bio and sees online/invisible flags', async () => {
  const r = await call('PATCH', `/api/admin/users/${ids.pf_b}`, { bio: 'cleaned' }, 'pf_a');
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT bio FROM users WHERE id = ?').get(ids.pf_b).bio, 'cleaned');
  assert.equal((await call('PATCH', `/api/admin/users/${ids.pf_b}`, { bio: 5 }, 'pf_a')).status, 400);
  const list = (await call('GET', '/api/admin/users', null, 'pf_a')).body.users.find((u) => u.id === ids.pf_b);
  assert.equal(list.bio, 'cleaned');
  assert.equal(list.online, false);
  assert.equal(list.invisible, false);
});

test('pin dot: unseen pins by others are listed until the list is opened', async () => {
  const dmId = makeDm();
  const mid = db.prepare("INSERT INTO messages (scope_type, scope_id, author_id, content, pinned_at, pinned_by) VALUES ('dm', ?, ?, 'p', ?, ?)")
    .run(dmId, ids.pf_a, new Date().toISOString(), ids.pf_a).lastInsertRowid;
  assert.ok(mid);
  const unseen = async (who) => (await call('GET', '/api/read-state', null, who)).body.pinsUnseen.filter((p) => p.scopeId === dmId);
  assert.equal((await unseen('pf_a')).length, 0);
  assert.equal((await unseen('pf_b')).length, 1);
  assert.equal((await call('PUT', `/api/read-state/pins/dm/${dmId}`, {}, 'pf_b')).status, 200);
  assert.equal((await unseen('pf_b')).length, 0);
  assert.equal((await call('PUT', '/api/read-state/pins/dm/999999', {}, 'pf_b')).status, 403);
});

test('closing a 1:1 DM marks it closed for the other side, blocks sends, and a new DM starts fresh', async () => {
  const dmId = makeDm();
  await call('POST', `/api/dms/${dmId}/messages`, { content: 'hi' }, 'pf_a');
  assert.equal((await call('DELETE', `/api/dms/${dmId}/members/me`, null, 'pf_a')).status, 200);
  const list = (await call('GET', '/api/dms', null, 'pf_b')).body.dms.find((d) => d.id === dmId);
  assert.equal(list.closedBy.id, ids.pf_a);
  assert.equal(list.members.length, 0);
  assert.equal((await call('POST', `/api/dms/${dmId}/messages`, { content: 'anyone?' }, 'pf_b')).status, 409);
  const fresh = await call('POST', '/api/dms', { userId: ids.pf_b }, 'pf_a');
  assert.notEqual(fresh.body.dmId, dmId);
  assert.equal((await call('DELETE', `/api/dms/${dmId}/members/me`, null, 'pf_b')).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE scope_type = ? AND scope_id = ?').get('dm', dmId).n, 0);
});
