'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const { db } = require('../db');
const presence = require('../lib/presence');
const hub = require('../socket/hub');
const { parseMentions, notifyChannelMessage, notifyDmMessage, setPref, pollOutbox } = require('../lib/notifications');
const { DEFAULT_EVERYONE_PERMISSIONS, PERMISSIONS } = require('../lib/permissions');

function makeEveryoneRole(serverId) {
  db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 0, 1)')
    .run(serverId, '@everyone', DEFAULT_EVERYONE_PERMISSIONS);
}

function makeUser(username) {
  return db.prepare(
    'INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)'
  ).run(username, `${username}@test.local`, 'hash', username).lastInsertRowid;
}

// Records every hub.notifyUser call instead of actually touching a WebSocket — notifications.js
// calls hub.notifyUser dynamically off the shared module object, so reassigning it here is
// visible to it without any other plumbing.
let sent;
const realNotifyUser = hub.notifyUser;
test.beforeEach(() => { sent = []; hub.notifyUser = (userId, payload) => sent.push({ userId, payload }); });
test.after(() => {
  hub.notifyUser = realNotifyUser;
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('parseMentions resolves @username, @role, @everyone, @here as separate signals', () => {
  const candidateUsers = [{ id: 1, username: 'alice' }, { id: 2, username: 'bob' }];
  const roles = [{ id: 10, name: 'Mods' }];
  const out = parseMentions('hey @alice and @Mods, also @everyone @here @stranger', { candidateUsers, roles });
  assert.deepEqual(out.userIds, [1]);
  assert.deepEqual(out.roleIds, [10]);
  assert.equal(out.everyone, true);
  assert.equal(out.here, true);
});

test('parseMentions is case-insensitive and ignores unknown tokens', () => {
  const out = parseMentions('@ALICE @EVERYONE @nobody', { candidateUsers: [{ id: 1, username: 'alice' }], roles: [] });
  assert.deepEqual(out.userIds, [1]);
  assert.equal(out.everyone, true);
});

test('@everyone notifies a mentions-only member even without a direct @username', () => {
  const authorId = makeUser('author1');
  const memberId = makeUser('member1');
  const serverId = db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)').run('S1', authorId, 'inv1').lastInsertRowid;
  makeEveryoneRole(serverId);
  const channelId = db.prepare('INSERT INTO channels (server_id, name, type) VALUES (?, ?, ?)').run(serverId, 'general', 'public').lastInsertRowid;
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?), (?, ?)').run(serverId, authorId, serverId, memberId);
  setPref(memberId, 'channel', channelId, 'mentions');

  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  notifyChannelMessage(channel, { author: { id: authorId }, content: '@everyone check this out' }, { userIds: [], roleIds: [], everyone: true, here: false });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].userId, memberId);
  assert.equal(sent[0].payload.mentioned, true);
});

test('@here only notifies members who are currently online', () => {
  const authorId = makeUser('author2');
  const onlineId = makeUser('online2');
  const offlineId = makeUser('offline2');
  const serverId = db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)').run('S2', authorId, 'inv2').lastInsertRowid;
  makeEveryoneRole(serverId);
  const channelId = db.prepare('INSERT INTO channels (server_id, name, type) VALUES (?, ?, ?)').run(serverId, 'general', 'public').lastInsertRowid;
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?), (?, ?), (?, ?)')
    .run(serverId, authorId, serverId, onlineId, serverId, offlineId);
  setPref(onlineId, 'channel', channelId, 'mentions');
  setPref(offlineId, 'channel', channelId, 'mentions');
  presence.registerConnection(onlineId, { readyState: 1, OPEN: 1, send: () => {} });

  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  notifyChannelMessage(channel, { author: { id: authorId }, content: '@here anyone around?' }, { userIds: [], roleIds: [], everyone: false, here: true });

  const notifiedIds = sent.map((s) => s.userId);
  assert.ok(notifiedIds.includes(onlineId), 'online member should be notified');
  assert.ok(!notifiedIds.includes(offlineId), 'offline member must not be notified by @here');
});

test('@role notifies only members holding that role', () => {
  const authorId = makeUser('author3');
  const modId = makeUser('mod3');
  const plainId = makeUser('plain3');
  const serverId = db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)').run('S3', authorId, 'inv3').lastInsertRowid;
  makeEveryoneRole(serverId);
  const channelId = db.prepare('INSERT INTO channels (server_id, name, type) VALUES (?, ?, ?)').run(serverId, 'general', 'public').lastInsertRowid;
  const roleId = db.prepare('INSERT INTO roles (server_id, name, permissions, position) VALUES (?, ?, 0, 1)').run(serverId, 'Mods').lastInsertRowid;
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?), (?, ?), (?, ?)')
    .run(serverId, authorId, serverId, modId, serverId, plainId);
  db.prepare('INSERT INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)').run(serverId, modId, roleId);
  setPref(modId, 'channel', channelId, 'mentions');
  setPref(plainId, 'channel', channelId, 'mentions');

  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  notifyChannelMessage(channel, { author: { id: authorId }, content: '@Mods please look' }, { userIds: [], roleIds: [roleId], everyone: false, here: false });

  const notifiedIds = sent.map((s) => s.userId);
  assert.ok(notifiedIds.includes(modId));
  assert.ok(!notifiedIds.includes(plainId));
});

test('the author never gets notified of their own mention', () => {
  const authorId = makeUser('author4');
  const serverId = db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)').run('S4', authorId, 'inv4').lastInsertRowid;
  makeEveryoneRole(serverId);
  const channelId = db.prepare('INSERT INTO channels (server_id, name, type) VALUES (?, ?, ?)').run(serverId, 'general', 'public').lastInsertRowid;
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(serverId, authorId);

  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  notifyChannelMessage(channel, { author: { id: authorId }, content: '@everyone hi' }, { userIds: [], roleIds: [], everyone: true, here: false });

  assert.equal(sent.length, 0);
});

test('a channel notify is durably recorded in the outbox and readable via pollOutbox', () => {
  const authorId = makeUser('author5');
  const memberId = makeUser('member5');
  const serverId = db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)').run('S5', authorId, 'inv5').lastInsertRowid;
  makeEveryoneRole(serverId);
  const channelId = db.prepare('INSERT INTO channels (server_id, name, type) VALUES (?, ?, ?)').run(serverId, 'general', 'public').lastInsertRowid;
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?), (?, ?)').run(serverId, authorId, serverId, memberId);
  setPref(memberId, 'channel', channelId, 'mentions');

  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  notifyChannelMessage(channel, { id: 1, author: { id: authorId }, content: '@everyone check this out' }, { userIds: [], roleIds: [], everyone: true, here: false });

  const { notifications, latestId } = pollOutbox(memberId, 0);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].scopeType, 'channel');
  assert.equal(notifications[0].scopeId, channelId);
  assert.equal(notifications[0].mentioned, true);
  assert.equal(notifications[0].message.content, '@everyone check this out');
  assert.equal(latestId, notifications[0].id);

  // Polling again with since=latestId sees no new rows, but the cursor doesn't reset to 0.
  const second = pollOutbox(memberId, latestId);
  assert.equal(second.notifications.length, 0);
  assert.equal(second.latestId, latestId);
});

test('a muted scope never reaches the outbox, matching the live-push filtering', () => {
  const authorId = makeUser('author6');
  const mutedId = makeUser('muted6');
  const serverId = db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)').run('S6', authorId, 'inv6').lastInsertRowid;
  makeEveryoneRole(serverId);
  const channelId = db.prepare('INSERT INTO channels (server_id, name, type) VALUES (?, ?, ?)').run(serverId, 'general', 'public').lastInsertRowid;
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?), (?, ?)').run(serverId, authorId, serverId, mutedId);
  setPref(mutedId, 'channel', channelId, 'mute');

  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  notifyChannelMessage(channel, { id: 2, author: { id: authorId }, content: '@everyone hi' }, { userIds: [], roleIds: [], everyone: true, here: false });

  assert.equal(pollOutbox(mutedId, 0).notifications.length, 0);
});

test('a DM notify is recorded in the outbox with mentioned always true', () => {
  const authorId = makeUser('author7');
  const otherId = makeUser('other7');
  const dmId = db.prepare('INSERT INTO dm_channels (is_group, created_by) VALUES (0, ?)').run(authorId).lastInsertRowid;
  db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?), (?, ?)').run(dmId, authorId, dmId, otherId);

  const dm = db.prepare('SELECT * FROM dm_channels WHERE id = ?').get(dmId);
  notifyDmMessage(dm, { id: 3, author: { id: authorId }, content: 'hey' });

  const { notifications } = pollOutbox(otherId, 0);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].scopeType, 'dm');
  assert.equal(notifications[0].mentioned, true);
});

test('the outbox is pruned to the newest rows per user, oldest first dropped', () => {
  const authorId = makeUser('author8');
  const otherId = makeUser('other8');
  const dmId = db.prepare('INSERT INTO dm_channels (is_group, created_by) VALUES (0, ?)').run(authorId).lastInsertRowid;
  db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?), (?, ?)').run(dmId, authorId, dmId, otherId);
  const dm = db.prepare('SELECT * FROM dm_channels WHERE id = ?').get(dmId);

  for (let i = 0; i < 205; i++) {
    notifyDmMessage(dm, { id: i, author: { id: authorId }, content: `msg ${i}` });
  }

  const row = db.prepare('SELECT COUNT(*) AS c FROM notifications_outbox WHERE user_id = ?').get(otherId);
  assert.equal(row.c, 200, 'outbox should be capped at 200 rows per user');

  const oldest = db.prepare('SELECT message_json FROM notifications_outbox WHERE user_id = ? ORDER BY id ASC LIMIT 1').get(otherId);
  assert.equal(JSON.parse(require('../lib/atRest').open(oldest.message_json)).content, 'msg 5', 'the oldest 5 rows should have been pruned away');
});

function pinFixture(tag) {
  const pinner = makeUser(`pinner_${tag}`);
  const author = makeUser(`author_${tag}`);
  const watcher = makeUser(`watcher_${tag}`);
  const muted = makeUser(`muted_${tag}`);
  const outsider = makeUser(`outsider_${tag}`);
  const serverId = db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)').run(`PS_${tag}`, pinner, `pinv_${tag}`).lastInsertRowid;
  makeEveryoneRole(serverId);
  const channelId = db.prepare('INSERT INTO channels (server_id, name, type) VALUES (?, ?, ?)').run(serverId, 'general', 'public').lastInsertRowid;
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?), (?, ?), (?, ?), (?, ?)')
    .run(serverId, pinner, serverId, author, serverId, watcher, serverId, muted);
  setPref(muted, 'channel', channelId, 'mute');
  setPref(author, 'channel', channelId, 'all');
  setPref(watcher, 'channel', channelId, 'all');
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  return { pinner, author, watcher, muted, outsider, serverId, channel };
}

test('a pinned channel message notifies viewers except the pinner and muted members', () => {
  const { notifyPin } = require('../lib/notifications');
  const f = pinFixture('p1');
  const message = { id: 90, scopeType: 'channel', scopeId: f.channel.id, author: { id: f.author, displayName: 'Author' }, content: 'pin me' };
  notifyPin(message, { id: f.pinner, displayName: 'Pinner' });
  const ids = sent.map((s) => s.userId).sort();
  assert.deepEqual(ids, [f.author, f.watcher].sort());
  const p = sent[0].payload;
  assert.equal(p.type, 'notify');
  assert.equal(p.kind, 'pin');
  assert.equal(p.actor.displayName, 'Pinner');
  assert.equal(p.scopeType, 'channel');
  assert.equal(p.scopeId, f.channel.id);
  assert.equal(p.channelName, 'general');
  assert.equal(p.message.id, 90);
  const polled = pollOutbox(f.watcher, 0).notifications;
  assert.equal(polled.length, 1);
  assert.equal(polled[0].kind, 'pin');
  assert.equal(polled[0].actor.displayName, 'Pinner');
});

test('pin notifications honour channel visibility and ignore lists', () => {
  const { notifyPin } = require('../lib/notifications');
  const f = pinFixture('p2');
  db.prepare('INSERT INTO channel_user_overrides (channel_id, user_id, allow, deny) VALUES (?, ?, 0, ?)')
    .run(f.channel.id, f.watcher, PERMISSIONS.VIEW_CHANNEL);
  const message = { id: 91, scopeType: 'channel', scopeId: f.channel.id, author: { id: f.author, displayName: 'A' }, content: 'x' };
  notifyPin(message, { id: f.pinner, displayName: 'Pinner' });
  assert.deepEqual(sent.map((s) => s.userId), [f.author], 'a member who cannot view the channel is not told');
});

test('a pinned thread message notifies via its parent channel; a pinned DM message notifies the other members', () => {
  const { notifyPin } = require('../lib/notifications');
  const f = pinFixture('p3');
  const threadId = db.prepare('INSERT INTO threads (channel_id, title, created_by) VALUES (?, ?, ?)').run(f.channel.id, 'T', f.author).lastInsertRowid;
  notifyPin({ id: 92, scopeType: 'thread', scopeId: threadId, author: { id: f.author, displayName: 'A' }, content: 'x' }, { id: f.pinner, displayName: 'Pinner' });
  assert.deepEqual(sent.map((s) => s.userId).sort(), [f.author, f.watcher].sort());
  assert.equal(sent[0].payload.scopeType, 'channel');
  assert.equal(sent[0].payload.threadId, threadId);

  sent = [];
  const dmId = db.prepare('INSERT INTO dm_channels (is_group, created_by) VALUES (0, ?)').run(f.pinner).lastInsertRowid;
  db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?), (?, ?)').run(dmId, f.pinner, dmId, f.author);
  setPref(f.author, 'dm', dmId, 'all');
  notifyPin({ id: 93, scopeType: 'dm', scopeId: dmId, author: { id: f.author, displayName: 'A' }, content: 'secret' }, { id: f.pinner, displayName: 'Pinner' });
  assert.deepEqual(sent.map((s) => s.userId), [f.author]);
  assert.equal(sent[0].payload.scopeType, 'dm');
  setPref(f.author, 'dm', dmId, 'mute');
  sent = [];
  notifyPin({ id: 93, scopeType: 'dm', scopeId: dmId, author: { id: f.author, displayName: 'A' }, content: 'secret' }, { id: f.pinner, displayName: 'Pinner' });
  assert.equal(sent.length, 0);
});

test('starting a thread from a message notifies that message\'s author only', () => {
  const { notifyThreadStarted } = require('../lib/notifications');
  const f = pinFixture('t1');
  const first = { id: 95, scopeType: 'thread', scopeId: 7, author: { id: f.pinner, displayName: 'Pinner' }, content: 'opening' };
  const parent = { id: 94, author_id: f.author };
  notifyThreadStarted(f.channel, { id: 7, title: 'Talk' }, parent, first, { id: f.pinner, displayName: 'Pinner' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].userId, f.author);
  assert.equal(sent[0].payload.kind, 'thread');
  assert.equal(sent[0].payload.threadId, 7);
  assert.equal(sent[0].payload.threadTitle, 'Talk');
  assert.equal(sent[0].payload.actor.displayName, 'Pinner');
  assert.equal(sent[0].payload.mentioned, true);

  sent = [];
  notifyThreadStarted(f.channel, { id: 8, title: 'Mine' }, { id: 96, author_id: f.pinner }, first, { id: f.pinner, displayName: 'Pinner' });
  assert.equal(sent.length, 0, 'own message');

  setPref(f.author, 'channel', f.channel.id, 'mute');
  notifyThreadStarted(f.channel, { id: 9, title: 'Muted' }, parent, first, { id: f.pinner, displayName: 'Pinner' });
  assert.equal(sent.length, 0, 'muted channel');
});

test('pin notifications skip mentions-only and muted members and the pinner', () => {
  const { notifyPin } = require('../lib/notifications');
  const f = pinFixture('p4');
  const mentionsOnly = makeUser('mentionsonly_p4');
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(f.serverId, mentionsOnly);
  setPref(mentionsOnly, 'channel', f.channel.id, 'mentions');
  setPref(f.pinner, 'channel', f.channel.id, 'all');
  notifyPin({ id: 97, scopeType: 'channel', scopeId: f.channel.id, author: { id: f.author, displayName: 'A' }, content: 'x' }, { id: f.pinner, displayName: 'Pinner' });
  const ids = sent.map((s) => s.userId);
  assert.ok(ids.includes(f.watcher), 'all-messages member is notified');
  assert.ok(!ids.includes(mentionsOnly), 'mentions-only member is not');
  assert.ok(!ids.includes(f.muted), 'muted member is not');
  assert.ok(!ids.includes(f.pinner), 'pinner is not');
});
