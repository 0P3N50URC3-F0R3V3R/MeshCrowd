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
const { getChannelPermissionBits, getChannelPermissionBitsBulk } = require('../lib/channelAccess');

const makeUser = (n) => db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
  .run(n, `${n}@test.local`, 'hash', n).lastInsertRowid;

test.after(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

test('bulk permission bits equal the per-user result for every kind of member and channel', () => {
  const owner = makeUser('owner');
  const serverId = db.prepare('INSERT INTO servers (name, owner_id, invite_code, screening_enabled) VALUES (?, ?, ?, 1)').run('S', owner, 'inv').lastInsertRowid;
  const everyone = db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 0, 1)').run(serverId, '@everyone', DEFAULT_EVERYONE_PERMISSIONS).lastInsertRowid;
  const mod = db.prepare('INSERT INTO roles (server_id, name, permissions, position) VALUES (?, ?, ?, 2)').run(serverId, 'mod', PERMISSIONS.MANAGE_MESSAGES | PERMISSIONS.VIEW_CHANNEL).lastInsertRowid;
  const admin = db.prepare('INSERT INTO roles (server_id, name, permissions, position) VALUES (?, ?, ?, 3)').run(serverId, 'admin', PERMISSIONS.ADMINISTRATOR).lastInsertRowid;
  const vip = db.prepare('INSERT INTO roles (server_id, name, permissions, position) VALUES (?, ?, ?, 1)').run(serverId, 'vip', 0).lastInsertRowid;

  const users = {};
  for (const n of ['plain', 'modu', 'adminu', 'vipu', 'pending', 'overridden', 'outsider']) users[n] = makeUser(n);
  const join = (u, screened = true) => db.prepare('INSERT INTO server_members (server_id, user_id, screened_at) VALUES (?, ?, ?)').run(serverId, u, screened ? '2026-01-01' : null);
  for (const n of ['plain', 'modu', 'adminu', 'vipu', 'overridden']) join(users[n]);
  join(users.pending, false);
  join(owner);
  const give = (u, r) => db.prepare('INSERT INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)').run(serverId, u, r);
  give(users.modu, mod); give(users.adminu, admin); give(users.vipu, vip);

  const results = [];
  for (const type of ['public', 'private', 'announcement', 'readonly', 'stage', 'voice']) {
    const channelId = db.prepare('INSERT INTO channels (server_id, name, type) VALUES (?, ?, ?)').run(serverId, `c-${type}`, type).lastInsertRowid;
    db.prepare('INSERT INTO channel_role_overrides (channel_id, role_id, allow, deny) VALUES (?, ?, ?, ?)').run(channelId, vip, PERMISSIONS.VIEW_CHANNEL, PERMISSIONS.SEND_MESSAGES);
    db.prepare('INSERT INTO channel_role_overrides (channel_id, role_id, allow, deny) VALUES (?, ?, ?, ?)').run(channelId, everyone, 0, PERMISSIONS.ADD_REACTIONS || 0);
    db.prepare('INSERT INTO channel_user_overrides (channel_id, user_id, allow, deny) VALUES (?, ?, ?, ?)').run(channelId, users.overridden, PERMISSIONS.VIEW_CHANNEL, 0);
    const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
    const ids = [owner, ...Object.values(users)];
    const bulk = getChannelPermissionBitsBulk(channel, ids);
    for (const id of ids) {
      assert.equal(bulk.get(id), getChannelPermissionBits(channel, id), `${type} user ${id}`);
      results.push(bulk.get(id));
    }
  }
  assert.ok(new Set(results).size > 3, 'the scenario produces several different permission sets');
});

test('bulk permission bits for an empty list is an empty map', () => {
  assert.equal(getChannelPermissionBitsBulk({ id: 1, server_id: 1, type: 'public' }, []).size, 0);
});
