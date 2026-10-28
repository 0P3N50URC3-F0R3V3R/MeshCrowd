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
const { DEFAULT_EVERYONE_PERMISSIONS } = require('../lib/permissions');

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
  assert.equal(JSON.parse(oldest.message_json).content, 'msg 5', 'the oldest 5 rows should have been pruned away');
});
