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
const hub = require('../socket/hub');
const presence = require('../lib/presence');
const voice = require('../socket/voice');
const automod = require('../lib/automod');
const { voiceChannelInfoFor } = require('../lib/friends');
const { maxMessageChars, readContent } = require('../lib/messageLimits');
const { inboxHandlers } = require('../routes/federationApi');
const { open } = require('../lib/atRest');

hub.broadcastToChannel = () => {};
hub.broadcastToDm = () => {};

let n = 0;
const mkUser = (name) => Number(db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)').run(`${name}${++n}`, `${name}${n}@t.local`, 'h', name).lastInsertRowid);
const mkChannel = (sid, name, type = 'public') => Number(db.prepare('INSERT INTO channels (server_id, name, type) VALUES (?, ?, ?)').run(sid, name, type).lastInsertRowid);
const mkDm = (users) => {
  const id = Number(db.prepare('INSERT INTO dm_channels (is_group, created_by, e2ee_enabled) VALUES (0, ?, 0)').run(users[0]).lastInsertRowid);
  for (const u of users) db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?)').run(id, u);
  return id;
};
const mkMessage = (scopeType, scopeId, authorId, content) => Number(db.prepare('INSERT INTO messages (scope_type, scope_id, author_id, content) VALUES (?, ?, ?, ?)').run(scopeType, scopeId, authorId, content).lastInsertRowid);
const befriend = (a, b) => db.prepare("INSERT INTO friendships (user_a, user_b, status, requested_by) VALUES (?, ?, 'accepted', ?)").run(Math.min(a, b), Math.max(a, b), a);

let w; let server; let base;
test.before(async () => {
  const owner = mkUser('owner');
  const sid = Number(db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)').run('Round3 Srv', owner, 'inv-r3').lastInsertRowid);
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(sid, owner);
  db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 0, 1)').run(sid, '@everyone', PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.SEND_MESSAGES | PERMISSIONS.READ_MESSAGE_HISTORY);
  const member = mkUser('member');
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(sid, member);
  const outsider = mkUser('outsider');
  w = { owner, sid, member, outsider, pub: mkChannel(sid, 'pub'), pub2: mkChannel(sid, 'pub2'), priv: mkChannel(sid, 'secret', 'private'), forum: mkChannel(sid, 'forum', 'forum'), voicePub: mkChannel(sid, 'vpub', 'voice'), voicePriv: mkChannel(sid, 'vpriv', 'voice') };
  db.prepare('UPDATE channels SET type = ? WHERE id = ?').run('private', w.voicePriv);

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const uid = Number(req.headers['x-uid']);
    if (uid) { req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid); req.sitePermissions = 0; }
    next();
  });
  app.use('/api/servers/:id/channels/:channelId/messages', require('../routes/channelMessages'));
  app.use('/api/servers/:id/channels/:channelId/threads', require('../routes/threads'));
  app.use('/api/servers', require('../routes/servers'));
  app.use('/api/dms', require('../routes/dms'));
  app.use('/api/messages', require('../routes/messages'));
  app.use('/api/reports', require('../routes/reports'));
  app.use('/api/friends', require('../routes/friends'));
  app.use('/api/notification-prefs', require('../routes/notificationPrefs'));
  app.use('/api/scheduled', require('../routes/scheduled'));
  app.use((err, req, res, next) => { res.status(500).json({ error: 'server error', detail: String(err && err.message) }); });
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
const chUrl = (ch) => `/api/servers/${w.sid}/channels/${ch}/messages`;

test('a reporter can only attach messages they can currently view', async () => {
  const author = mkUser('author');
  const inPrivate = mkMessage('channel', w.priv, author, 'secret text');
  const inPublic = mkMessage('channel', w.pub, author, 'public text');
  const reporter = w.member;
  const dm = mkDm([author, mkUser('dmpeer')]);
  const inDm = mkMessage('dm', dm, author, 'dm text');

  const reject = await call('POST', '/api/reports', reporter, { reportedUserId: author, reason: 'spam', messageId: inPrivate });
  assert.equal(reject.status, 400);
  assert.deepEqual(reject.data, { error: 'cannot attach that message' });
  assert.equal((await call('POST', '/api/reports', reporter, { reportedUserId: author, reason: 'spam', messageId: inDm })).status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM reports WHERE reporter_id = ?').get(reporter).c, 0);

  assert.equal((await call('POST', '/api/reports', reporter, { reportedUserId: author, reason: 'spam', messageId: inPublic })).status, 201);
  assert.equal(db.prepare('SELECT message_id FROM reports WHERE reporter_id = ?').get(reporter).message_id, inPublic);
  assert.equal((await call('POST', '/api/reports', reporter, { reportedUserId: author, reason: 'spam', messageId: 999999 })).status, 201, 'a stale id is still silently dropped');
  assert.equal((await call('POST', '/api/reports', w.owner, { reportedUserId: author, reason: 'spam', messageId: inPrivate })).status, 201, 'the owner can see the private channel');
});

test('friends only learn the names of a voice channel they can view', async () => {
  const talker = mkUser('talker');
  const insider = mkUser('insider'); const stranger = mkUser('stranger');
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(w.sid, talker);
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(w.sid, insider);
  befriend(talker, insider); befriend(talker, stranger);
  db.prepare('INSERT INTO channel_user_overrides (channel_id, user_id, allow, deny) VALUES (?, ?, ?, 0)').run(w.voicePriv, insider, PERMISSIONS.VIEW_CHANNEL);
  db.prepare('INSERT INTO channel_user_overrides (channel_id, user_id, allow, deny) VALUES (?, ?, ?, 0)').run(w.voicePriv, talker, PERMISSIONS.VIEW_CHANNEL);
  const privChannel = db.prepare('SELECT * FROM channels WHERE id = ?').get(w.voicePriv);
  const pubChannel = db.prepare('SELECT * FROM channels WHERE id = ?').get(w.voicePub);

  const hidden = { id: null, name: '', serverId: null, serverName: '', hidden: true };
  assert.deepEqual(voiceChannelInfoFor(insider, privChannel), { id: w.voicePriv, name: 'vpriv', serverId: w.sid, serverName: 'Round3 Srv' });
  assert.deepEqual(voiceChannelInfoFor(stranger, privChannel), hidden);
  assert.equal(voiceChannelInfoFor(stranger, null), null);
  assert.equal(voiceChannelInfoFor(insider, pubChannel).name, 'vpub');
  assert.deepEqual(voiceChannelInfoFor(stranger, pubChannel), hidden, 'a non-member cannot view the channel either');

  voice.join(w.voicePriv, talker);
  try {
    const snapshot = async (uid) => (await call('GET', '/api/friends/activity/voice', uid)).data.activity;
    assert.deepEqual(await snapshot(insider), [{ userId: talker, channel: { id: w.voicePriv, name: 'vpriv', serverId: w.sid, serverName: 'Round3 Srv' } }]);
    assert.deepEqual(await snapshot(stranger), [{ userId: talker, channel: hidden }]);

    const got = new Map();
    for (const uid of [insider, stranger]) presence.registerConnection(uid, { OPEN: 1, readyState: 1, send: (m) => got.set(uid, JSON.parse(m)) });
    hub.broadcastToFriends(talker, (friendId) => ({ type: 'friend_voice', userId: talker, channel: voiceChannelInfoFor(friendId, privChannel) }));
    assert.equal(got.get(insider).channel.name, 'vpriv');
    assert.deepEqual(got.get(stranger).channel, hidden);
  } finally {
    voice.leave(w.voicePriv, talker);
  }
});

test('forwarding is checked by AutoMod on the forwarded text as well as the comment', async () => {
  automod.createRule(w.sid, { name: 'Words', kind: 'keywords', config: { words: ['forbidden'] } });
  const author = mkUser('fwdauthor');
  const bad = mkMessage('channel', w.pub, author, 'this is forbidden talk');
  const good = mkMessage('channel', w.pub, author, 'perfectly fine');
  const target = { scopeType: 'channel', scopeId: w.pub2 };

  const blocked = await call('POST', `/api/messages/${bad}/forward`, w.member, { ...target });
  assert.equal(blocked.status, 403);
  assert.match(blocked.data.error, /AutoMod/);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM messages WHERE scope_id = ? AND scope_type = ? AND forwarded_from_message_id IS NOT NULL').get(w.pub2, 'channel').c, 0);
  assert.equal((await call('POST', `/api/messages/${bad}/forward`, w.member, { ...target, comment: 'harmless comment' })).status, 403);
  assert.equal((await call('POST', `/api/messages/${good}/forward`, w.member, { ...target, comment: 'forbidden comment' })).status, 403, 'the comment is still checked');
  assert.equal((await call('POST', `/api/messages/${good}/forward`, w.member, { ...target, comment: 'ok' })).status, 201);
  assert.equal((await call('POST', `/api/messages/${bad}/forward`, w.owner, { ...target })).status, 201, 'the owner is exempt from AutoMod');
  db.prepare('DELETE FROM automod_rules WHERE server_id = ?').run(w.sid);
});

test('notification prefs answer the same for a channel the caller cannot view and for one that does not exist', async () => {
  const missing = await call('PUT', '/api/notification-prefs/channel/987654', w.member, { pref: 'mute' });
  const hidden = await call('PUT', `/api/notification-prefs/channel/${w.priv}`, w.member, { pref: 'mute' });
  const outside = await call('PUT', `/api/notification-prefs/channel/${w.pub}`, w.outsider, { pref: 'mute' });
  assert.equal(missing.status, 404);
  assert.deepEqual(hidden, missing);
  assert.deepEqual(outside, missing);
  assert.equal((await call('PUT', `/api/notification-prefs/channel/${w.pub}`, w.member, { pref: 'mute' })).status, 200);
});

test('peer-supplied attachment type and name are bounded', () => {
  const localId = mkUser('fedLocal');
  const peerId = db.prepare(`INSERT INTO federation_peers (domain, public_url, their_pubkey, status) VALUES ('r3.example', 'https://r3', 'PEM', 'active')`).run().lastInsertRowid;
  const data = Buffer.from('hello').toString('base64');
  const send = (id, attachments) => {
    inboxHandlers.dm_message_create({ id: peerId, domain: 'r3.example' }, {
      fromRemoteId: 1, fromUsername: 'peerSender', displayName: 'P', participants: [db.prepare('SELECT username FROM users WHERE id = ?').get(localId).username, 'peerSender@r3.example'],
      content: 'files', attachments, dmMessageId: id,
    });
    const message = db.prepare('SELECT * FROM messages WHERE federation_message_id = ?').get(id);
    return db.prepare('SELECT * FROM attachments WHERE message_id = ?').all(message.id);
  };
  const stored = send('r3-a', [
    { fileName: 'a.txt', mimeType: 'text/plain', dataBase64: data },
    { fileName: 'b.txt', mimeType: 'x'.repeat(200), dataBase64: data },
    { fileName: 'c.txt', mimeType: 'text/html; <script>', dataBase64: data },
    { fileName: 'd.txt', mimeType: { evil: true }, dataBase64: data },
    { fileName: 'f.txt', mimeType: 'application/vnd.api+json', dataBase64: data },
  ]);
  assert.deepEqual(stored.map((a) => a.mime_type), ['text/plain', 'application/octet-stream', 'application/octet-stream', 'application/octet-stream', 'application/vnd.api+json']);
  assert.equal(send('r3-d', [{ fileName: 'e.txt', dataBase64: data }])[0].mime_type, 'application/octet-stream');
  assert.equal(send('r3-b', [{ fileName: `${'n'.repeat(300)}.txt`, mimeType: 'text/plain', dataBase64: data }]).length, 0, 'an absurd file name drops the attachment');
  assert.equal(send('r3-c', [{ fileName: { x: 1 }, mimeType: 'text/plain', dataBase64: data }, { fileName: 'g.txt', mimeType: 'text/plain', dataBase64: { y: 1 } }]).length, 0);
});

test('member colour PATCH rejects non-string values with 400', async () => {
  const url = `/api/servers/${w.sid}/members/${w.member}/color`;
  for (const bad of [['#aabbcc'], 123, { a: 1 }, true, undefined, '#abc']) {
    assert.equal((await call('PATCH', url, w.owner, { color: bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await call('PATCH', url, w.owner, { color: '#aabbcc' })).status, 200);
  assert.equal((await call('PATCH', url, w.owner, { color: null })).status, 200);
});

test('readContent: absent is empty, non-strings are 400, over-long is 413 and never truncated', () => {
  const max = maxMessageChars();
  assert.deepEqual(readContent(undefined), { content: '' });
  assert.deepEqual(readContent(null), { content: '' });
  for (const bad of [123, 1e308, {}, [], ['a'], true]) assert.deepEqual(readContent(bad), { status: 400, body: { error: 'content must be a string', code: 'invalid_content' } });
  assert.deepEqual(readContent('x'.repeat(max)), { content: 'x'.repeat(max) });
  assert.deepEqual(readContent('x'.repeat(max + 1)), { status: 413, body: { error: 'message too long', code: 'message_too_long', maxChars: max } });
  assert.deepEqual(readContent(`  ${'x'.repeat(max)}  `, { trim: true }), { content: 'x'.repeat(max) });
});

test('message routes reject over-long and non-string content instead of truncating or coercing', async () => {
  const max = maxMessageChars();
  const long = 'x'.repeat(max + 1);
  const tooLong = { status: 413, data: { error: 'message too long', code: 'message_too_long', maxChars: max } };
  const notString = (r) => assert.deepEqual(r, { status: 400, data: { error: 'content must be a string', code: 'invalid_content' } });
  const count = () => db.prepare('SELECT COUNT(*) AS c FROM messages').get().c;
  const before = count();

  assert.deepEqual(await call('POST', chUrl(w.pub), w.member, { content: long }), tooLong);
  for (const bad of [123, 1e308, { a: 1 }, ['x']]) notString(await call('POST', chUrl(w.pub), w.member, { content: bad }));

  const dm = mkDm([w.member, w.owner]);
  assert.deepEqual(await call('POST', `/api/dms/${dm}/messages`, w.member, { content: long }), tooLong);
  notString(await call('POST', `/api/dms/${dm}/messages`, w.member, { content: 42 }));

  assert.deepEqual(await call('POST', `/api/servers/${w.sid}/channels/${w.forum}/threads`, w.member, { title: 'T', content: long }), tooLong);
  notString(await call('POST', `/api/servers/${w.sid}/channels/${w.forum}/threads`, w.member, { title: 'T', content: ['x'] }));
  assert.equal(count(), before, 'nothing was stored');

  const ok = await call('POST', chUrl(w.pub), w.member, { content: 'x'.repeat(max) });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.message.content.length, max);
  const id = ok.data.message.id;
  assert.deepEqual(await call('PATCH', `/api/messages/${id}`, w.member, { content: long }), tooLong);
  notString(await call('PATCH', `/api/messages/${id}`, w.member, { content: { a: 1 } }));
  assert.equal(open(db.prepare('SELECT content FROM messages WHERE id = ?').get(id).content).length, max, 'the edit left the message untouched');
  assert.equal((await call('PATCH', `/api/messages/${id}`, w.member, { content: 'short' })).status, 200);

  const { data: { thread } } = await call('POST', `/api/servers/${w.sid}/channels/${w.forum}/threads`, w.member, { title: 'T', content: 'first' });
  const tUrl = `/api/servers/${w.sid}/channels/${w.forum}/threads/${thread.id}`;
  assert.deepEqual(await call('POST', `${tUrl}/messages`, w.member, { content: long }), tooLong);
  notString(await call('POST', `${tUrl}/messages`, w.member, { content: 5 }));
  assert.deepEqual(await call('PATCH', tUrl, w.member, { content: long }), tooLong);
  notString(await call('PATCH', tUrl, w.member, { content: 5 }));

  const when = new Date(Date.now() + 3600_000).toISOString();
  const sched = (content) => call('POST', '/api/scheduled', w.member, { scopeType: 'channel', scopeId: w.pub, content, sendAt: when });
  assert.equal((await sched(long)).status, 400);
  assert.equal((await sched(7)).status, 400);
  assert.equal((await sched('later')).status, 201);
});
