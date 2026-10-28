'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const { db } = require('../db');
const { PERMISSIONS, DEFAULT_EVERYONE_PERMISSIONS } = require('../lib/permissions');
const { getChannelPermissionBits } = require('../lib/channelAccess');

function makeUser(username) {
  return db.prepare(
    'INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)'
  ).run(username, `${username}@test.local`, 'hash', username).lastInsertRowid;
}

test.after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('owner always has full permissions regardless of roles', () => {
  const ownerId = makeUser('owner1');
  const serverId = db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)')
    .run('S1', ownerId, 'inv1').lastInsertRowid;
  db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 0, 1)')
    .run(serverId, '@everyone', 0);
  const channelId = db.prepare('INSERT INTO channels (server_id, name, type) VALUES (?, ?, ?)')
    .run(serverId, 'general', 'public').lastInsertRowid;
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(serverId, ownerId);

  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  const bits = getChannelPermissionBits(channel, ownerId);
  assert.equal(bits & PERMISSIONS.ADMINISTRATOR, PERMISSIONS.ADMINISTRATOR);
  assert.equal(bits & PERMISSIONS.BAN_MEMBERS, PERMISSIONS.BAN_MEMBERS);
});

test('private channel hides VIEW_CHANNEL from a plain member with no override', () => {
  const ownerId = makeUser('owner2');
  const memberId = makeUser('member2');
  const serverId = db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)')
    .run('S2', ownerId, 'inv2').lastInsertRowid;
  const everyoneRoleId = db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 0, 1)')
    .run(serverId, '@everyone', DEFAULT_EVERYONE_PERMISSIONS).lastInsertRowid;
  const channelId = db.prepare('INSERT INTO channels (server_id, name, type) VALUES (?, ?, ?)')
    .run(serverId, 'secret', 'private').lastInsertRowid;
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(serverId, memberId);

  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  let bits = getChannelPermissionBits(channel, memberId);
  assert.equal(bits & PERMISSIONS.VIEW_CHANNEL, 0, 'no override yet, should be hidden');

  // Grant an explicit view override to @everyone and confirm it now unlocks.
  db.prepare('INSERT INTO channel_role_overrides (channel_id, role_id, allow, deny) VALUES (?, ?, ?, 0)')
    .run(channelId, everyoneRoleId, PERMISSIONS.VIEW_CHANNEL);
  bits = getChannelPermissionBits(channel, memberId);
  assert.equal(bits & PERMISSIONS.VIEW_CHANNEL, PERMISSIONS.VIEW_CHANNEL, 'explicit override should unlock view');
});

test('announcement channel strips SEND_MESSAGES unless mod+', () => {
  const ownerId = makeUser('owner3');
  const memberId = makeUser('member3');
  const modId = makeUser('mod3');
  const serverId = db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)')
    .run('S3', ownerId, 'inv3').lastInsertRowid;
  db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 0, 1)')
    .run(serverId, '@everyone', DEFAULT_EVERYONE_PERMISSIONS);
  const modRoleId = db.prepare('INSERT INTO roles (server_id, name, permissions, position) VALUES (?, ?, ?, 1)')
    .run(serverId, 'Mods', PERMISSIONS.MANAGE_MESSAGES).lastInsertRowid;
  const channelId = db.prepare('INSERT INTO channels (server_id, name, type) VALUES (?, ?, ?)')
    .run(serverId, 'news', 'announcement').lastInsertRowid;
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(serverId, memberId);
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(serverId, modId);
  db.prepare('INSERT INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)').run(serverId, modId, modRoleId);

  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  const memberBits = getChannelPermissionBits(channel, memberId);
  const modBits = getChannelPermissionBits(channel, modId);

  assert.equal(memberBits & PERMISSIONS.VIEW_CHANNEL, PERMISSIONS.VIEW_CHANNEL, 'everyone can still view');
  assert.equal(memberBits & PERMISSIONS.SEND_MESSAGES, 0, 'plain member cannot post in announcement channel');
  assert.equal(modBits & PERMISSIONS.SEND_MESSAGES, PERMISSIONS.SEND_MESSAGES, 'mod can post');
});

test('a non-member gets zero permission bits, even in a public channel with a generous @everyone role', () => {
  const ownerId = makeUser('owner4');
  const outsiderId = makeUser('outsider4');
  const serverId = db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)')
    .run('S4', ownerId, 'inv4').lastInsertRowid;
  db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 0, 1)')
    .run(serverId, '@everyone', DEFAULT_EVERYONE_PERMISSIONS);
  const channelId = db.prepare('INSERT INTO channels (server_id, name, type) VALUES (?, ?, ?)')
    .run(serverId, 'general', 'public').lastInsertRowid;
  // Deliberately never inserted into server_members.

  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  const bits = getChannelPermissionBits(channel, outsiderId);
  assert.equal(bits, 0, 'a non-member must not inherit @everyone permissions in any channel');
});
