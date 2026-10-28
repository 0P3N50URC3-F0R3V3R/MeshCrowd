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
const accounts = require('../lib/accounts');
const hub = require('../socket/hub');
const { setPref, getPref, notifyDmMessage } = require('../lib/notifications');
const { deliverDueReminders } = require('../lib/reminders');

const app = express();
app.use(express.json());
app.use(attachUser);
app.use('/api/auth', require('../routes/auth'));
app.use('/api/notification-prefs', require('../routes/notificationPrefs'));
app.use('/api/read-state', require('../routes/readState'));
app.use('/api/users', require('../routes/users'));
app.use('/api/friends', require('../routes/friends'));
app.use('/api/dms', require('../routes/dms'));
app.use('/api', require('../routes/personal'));
app.use(require('../middleware/errorHandler').errorHandler);
let server; let base;
const cookies = {}; const ids = {};

async function call(method, url, body, who) {
  const res = await fetch(base + url, {
    method, headers: { 'content-type': 'application/json', ...(who ? { cookie: cookies[who] } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}

test.before(async () => {
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  for (const name of ['pm_a', 'pm_b', 'pm_c']) {
    ids[name] = accounts.createAccount({ username: name, email: `${name}@t.co`, password: 'password123' }).userId;
    cookies[name] = (await call('POST', '/api/auth/login', { username: name, password: 'password123' })).cookie;
  }
});
test.after(() => { server.close(); db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

const makeDm = (a, b) => {
  const dmId = db.prepare('INSERT INTO dm_channels (is_group, created_by) VALUES (0, ?)').run(ids[a]).lastInsertRowid;
  db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?), (?, ?)').run(dmId, ids[a], dmId, ids[b]);
  return dmId;
};
const postDm = (dmId, author, content) => db.prepare("INSERT INTO messages (scope_type, scope_id, author_id, content) VALUES ('dm', ?, ?, ?)")
  .run(dmId, ids[author], content).lastInsertRowid;

test('annotations: note, nickname and ignore are stored per viewer and cleared when empty', async () => {
  let r = await call('PUT', `/api/user-annotations/${ids.pm_b}`, { note: '  likes tea ', nickname: 'Bee' }, 'pm_a');
  assert.deepEqual(r.body.annotation, { targetId: ids.pm_b, note: 'likes tea', nickname: 'Bee', ignored: false });
  r = await call('PUT', `/api/user-annotations/${ids.pm_b}`, { ignored: true }, 'pm_a');
  assert.equal(r.body.annotation.nickname, 'Bee');
  assert.equal(r.body.annotation.ignored, true);
  assert.equal((await call('GET', '/api/user-annotations', null, 'pm_b')).body.annotations.length, 0);
  assert.equal((await call('PUT', `/api/user-annotations/${ids.pm_a}`, { note: 'x' }, 'pm_a')).status, 400);
  assert.equal((await call('PUT', `/api/user-annotations/${ids.pm_b}`, { ignored: 'yes' }, 'pm_a')).status, 400);
  await call('PUT', `/api/user-annotations/${ids.pm_b}`, { note: null, nickname: null, ignored: false }, 'pm_a');
  assert.equal((await call('GET', '/api/user-annotations', null, 'pm_a')).body.annotations.length, 0);
});

test('ignored authors do not notify the ignoring user', async () => {
  const dmId = makeDm('pm_a', 'pm_b');
  const sent = [];
  const real = hub.notifyUser;
  hub.notifyUser = (userId, payload) => sent.push({ userId, payload });
  try {
    const dm = db.prepare('SELECT * FROM dm_channels WHERE id = ?').get(dmId);
    const msg = (id) => ({ id, content: 'hi', author: { id: ids.pm_b, displayName: 'b' }, attachments: [] });
    notifyDmMessage(dm, msg(1));
    assert.equal(sent.length, 1);
    await call('PUT', `/api/user-annotations/${ids.pm_b}`, { ignored: true }, 'pm_a');
    notifyDmMessage(dm, msg(2));
    assert.equal(sent.length, 1);
  } finally { hub.notifyUser = real; }
});

test('dm-prefs: pin, favorite, close; closed DMs leave the list and return on a new message', async () => {
  const dmId = makeDm('pm_a', 'pm_c');
  postDm(dmId, 'pm_c', 'hello');
  let r = await call('PUT', `/api/dm-prefs/${dmId}`, { pinned: true, favorite: true }, 'pm_a');
  assert.deepEqual(r.body.pref, { dmId, pinned: true, favorite: true, hidden: false });
  assert.ok((await call('GET', '/api/dms', null, 'pm_a')).body.dms.some((d) => d.id === dmId));
  await call('PUT', `/api/dm-prefs/${dmId}`, { hidden: true }, 'pm_a');
  assert.ok(!(await call('GET', '/api/dms', null, 'pm_a')).body.dms.some((d) => d.id === dmId));
  assert.ok((await call('GET', '/api/dms', null, 'pm_c')).body.dms.some((d) => d.id === dmId));
  const real = hub.notifyUser; hub.notifyUser = () => {};
  try { notifyDmMessage(db.prepare('SELECT * FROM dm_channels WHERE id = ?').get(dmId), { id: 9, content: 'again', author: { id: ids.pm_c, displayName: 'c' }, attachments: [] }); } finally { hub.notifyUser = real; }
  const back = (await call('GET', '/api/dms', null, 'pm_a')).body.dms.find((d) => d.id === dmId);
  assert.ok(back);
  assert.equal((await call('PUT', `/api/dm-prefs/${dmId}`, { pinned: true }, 'pm_b')).status, 403);
});

test('timed DM mute lapses; forever mute does not', async () => {
  const dmId = makeDm('pm_b', 'pm_c');
  setPref(ids.pm_b, 'dm', dmId, 'mute', new Date(Date.now() - 1000).toISOString());
  assert.equal(getPref(ids.pm_b, 'dm', dmId), 'all');
  let r = await call('PUT', `/api/notification-prefs/dm/${dmId}`, { pref: 'mute', minutes: 60 }, 'pm_b');
  assert.equal(r.body.pref, 'mute');
  assert.ok(Date.parse(r.body.mutedUntil) > Date.now());
  r = await call('PUT', `/api/notification-prefs/dm/${dmId}`, { pref: 'mute', forever: true }, 'pm_b');
  assert.equal(getPref(ids.pm_b, 'dm', dmId), 'mute');
  r = await call('PUT', `/api/notification-prefs/dm/${dmId}`, { pref: 'all' }, 'pm_b');
  assert.equal(r.body.mutedUntil, null);
});

test('bookmarks: save, list with location, remove; strangers cannot bookmark a private DM message', async () => {
  const dmId = makeDm('pm_a', 'pm_b');
  const mid = postDm(dmId, 'pm_b', 'keep me');
  assert.equal((await call('PUT', `/api/bookmarks/${mid}`, null, 'pm_c')).status, 404);
  assert.equal((await call('PUT', `/api/bookmarks/${mid}`, null, 'pm_a')).status, 200);
  let list = (await call('GET', '/api/bookmarks', null, 'pm_a')).body.bookmarks;
  assert.equal(list.length, 1);
  assert.equal(list[0].message.content, 'keep me');
  assert.deepEqual((await call('GET', '/api/bookmarks/ids', null, 'pm_a')).body.ids, [mid]);
  await call('DELETE', `/api/bookmarks/${mid}`, null, 'pm_a');
  assert.equal((await call('GET', '/api/bookmarks', null, 'pm_a')).body.bookmarks.length, 0);
});

test('reminders: due ones are pushed to an online owner once and then marked delivered', async () => {
  const dmId = makeDm('pm_a', 'pm_b');
  const mid = postDm(dmId, 'pm_b', 'remember this');
  assert.equal((await call('POST', '/api/reminders', { messageId: mid, minutes: 0 }, 'pm_a')).status, 400);
  const created = await call('POST', '/api/reminders', { messageId: mid, minutes: 5 }, 'pm_a');
  assert.equal(created.status, 201);
  const sent = [];
  const realNotify = hub.notifyUser; const realOnline = hub.isOnline;
  hub.notifyUser = (userId, payload) => sent.push({ userId, payload });
  hub.isOnline = () => true;
  try {
    assert.equal(deliverDueReminders(new Date().toISOString()), 0);
    assert.equal(deliverDueReminders(new Date(Date.now() + 6 * 60_000).toISOString()), 1);
    assert.equal(sent[0].payload.type, 'reminder');
    assert.equal(sent[0].payload.snippet, 'remember this');
    assert.equal(deliverDueReminders(new Date(Date.now() + 7 * 60_000).toISOString()), 0);
  } finally { hub.notifyUser = realNotify; hub.isOnline = realOnline; }
  assert.equal((await call('GET', '/api/reminders', null, 'pm_a')).body.reminders.length, 0);
});

test('read-state: only force may move the pointer backwards (mark as unread)', async () => {
  const dmId = makeDm('pm_a', 'pm_c');
  await call('PUT', `/api/read-state/dm/${dmId}`, { messageId: 50 }, 'pm_a');
  await call('PUT', `/api/read-state/dm/${dmId}`, { messageId: 10 }, 'pm_a');
  const get = async () => (await call('GET', '/api/read-state', null, 'pm_a')).body.state.find((s) => s.scopeId === dmId).lastReadMessageId;
  assert.equal(await get(), 50);
  await call('PUT', `/api/read-state/dm/${dmId}`, { messageId: 10, force: true }, 'pm_a');
  assert.equal(await get(), 10);
});

test('profile data: createdAt, friendsSince and mutual friends', async () => {
  const [a, b, c] = [ids.pm_a, ids.pm_b, ids.pm_c];
  const pair = (x, y) => (x < y ? [x, y] : [y, x]);
  for (const [x, y] of [pair(a, c), pair(b, c), pair(a, b)]) {
    db.prepare("INSERT OR REPLACE INTO friendships (user_a, user_b, status, requested_by, accepted_at) VALUES (?, ?, 'accepted', ?, '2026-01-02T00:00:00.000Z')").run(x, y, x);
  }
  const r = await call('GET', `/api/users/${b}`, null, 'pm_a');
  assert.equal(r.body.user.friendsSince, '2026-01-02T00:00:00.000Z');
  assert.ok(r.body.user.createdAt);
  assert.deepEqual(r.body.user.mutualFriends.map((u) => u.id), [c]);
});

test('mounting the personal router at /api does not put auth in front of other public /api routes', async () => {
  const probe = express();
  probe.use(express.json());
  probe.use(attachUser);
  probe.use('/api', require('../routes/personal'));
  probe.get('/api/public-ping', (req, res) => res.json({ ok: true }));
  const s = await new Promise((r) => { const srv = probe.listen(0, () => r(srv)); });
  try {
    const open = await fetch(`http://127.0.0.1:${s.address().port}/api/public-ping`);
    assert.equal(open.status, 200);
    const guarded = await fetch(`http://127.0.0.1:${s.address().port}/api/bookmarks`);
    assert.equal(guarded.status, 401);
  } finally { s.close(); }
});
