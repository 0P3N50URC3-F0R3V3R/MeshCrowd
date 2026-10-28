'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const { db } = require('../db');
const { PERMISSIONS } = require('../lib/permissions');
const { getChannelPermissionBits } = require('../lib/channelAccess');

function makeUser(username) {
  return db.prepare(
    'INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)'
  ).run(username, `${username}@test.local`, 'hash', username).lastInsertRowid;
}

function makePrivateChannel(serverId, name) {
  return db.prepare('INSERT INTO channels (server_id, name, type) VALUES (?, ?, ?)')
    .run(serverId, name, 'private').lastInsertRowid;
}

test.after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('redeeming a channel invite grants VIEW_CHANNEL via a per-user override, not a role', () => {
  const ownerId = makeUser('inv_owner1');
  const invitee = makeUser('inv_guest1');
  const serverId = db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)')
    .run('S1', ownerId, 'srv1').lastInsertRowid;
  db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, 0, 0, 1)')
    .run(serverId, '@everyone');
  const channelId = makePrivateChannel(serverId, 'secret');
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);

  assert.equal(getChannelPermissionBits(channel, invitee) & PERMISSIONS.VIEW_CHANNEL, 0, 'no access before redeeming');

  const code = crypto.randomBytes(6).toString('hex');
  db.prepare('INSERT INTO channel_invites (channel_id, code, created_by) VALUES (?, ?, ?)')
    .run(channelId, code, ownerId);

  // Mirrors what servers.js does on redemption: join the server, then the ON CONFLICT upsert.
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(serverId, invitee);
  db.prepare(
    `INSERT INTO channel_user_overrides (channel_id, user_id, allow, deny) VALUES (?, ?, ?, 0)
     ON CONFLICT(channel_id, user_id) DO UPDATE SET allow = allow | excluded.allow`
  ).run(channelId, invitee, PERMISSIONS.VIEW_CHANNEL);
  db.prepare('UPDATE channel_invites SET uses = uses + 1 WHERE code = ?').run(code);

  const bits = getChannelPermissionBits(channel, invitee);
  assert.equal(bits & PERMISSIONS.VIEW_CHANNEL, PERMISSIONS.VIEW_CHANNEL, 'redeeming grants view access');
  assert.equal(bits & PERMISSIONS.SEND_MESSAGES, 0, 'invite grants only what it lists, nothing else');
  assert.equal(db.prepare('SELECT uses FROM channel_invites WHERE code = ?').get(code).uses, 1);
});

test('a channel-level deny override still wins over a user allow granted by invite', () => {
  const ownerId = makeUser('inv_owner2');
  const invitee = makeUser('inv_guest2');
  const serverId = db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)')
    .run('S2', ownerId, 'srv2').lastInsertRowid;
  db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, 0, 0, 1)')
    .run(serverId, '@everyone');
  const channelId = makePrivateChannel(serverId, 'secret2');
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);

  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(serverId, invitee);
  db.prepare('INSERT INTO channel_user_overrides (channel_id, user_id, allow, deny) VALUES (?, ?, ?, ?)')
    .run(channelId, invitee, PERMISSIONS.VIEW_CHANNEL, PERMISSIONS.SEND_MESSAGES);

  const bits = getChannelPermissionBits(channel, invitee);
  assert.equal(bits & PERMISSIONS.VIEW_CHANNEL, PERMISSIONS.VIEW_CHANNEL);
  assert.equal(bits & PERMISSIONS.SEND_MESSAGES, 0, 'explicit deny on the same override row is not overridden by its own allow bits');
});

test('invite code is unique, max_uses and expires_at default to unlimited/never', () => {
  const ownerId = makeUser('inv_owner3');
  const serverId = db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)')
    .run('S3', ownerId, 'srv3').lastInsertRowid;
  const channelId = makePrivateChannel(serverId, 'secret3');
  const code = crypto.randomBytes(6).toString('hex');

  db.prepare('INSERT INTO channel_invites (channel_id, code, created_by) VALUES (?, ?, ?)').run(channelId, code, ownerId);
  const row = db.prepare('SELECT * FROM channel_invites WHERE code = ?').get(code);
  assert.equal(row.max_uses, null);
  assert.equal(row.expires_at, null);
  assert.equal(row.uses, 0);

  assert.throws(() => {
    db.prepare('INSERT INTO channel_invites (channel_id, code, created_by) VALUES (?, ?, ?)').run(channelId, code, ownerId);
  }, /UNIQUE/);
});
