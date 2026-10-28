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
const { PERMISSIONS, SITE_PERMISSIONS, DEFAULT_EVERYONE_PERMISSIONS } = require('../lib/permissions');
const { getChannelPermissionBits } = require('../lib/channelAccess');

test.after(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

let seq = 0;
function makeUser() {
  const name = `u${++seq}`;
  return db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run(name, `${name}@test.local`, 'hash', name).lastInsertRowid;
}

function makeServer(ownerId) {
  const serverId = db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)')
    .run(`S${++seq}`, ownerId, `inv${seq}`).lastInsertRowid;
  db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 0, 1)')
    .run(serverId, '@everyone', DEFAULT_EVERYONE_PERMISSIONS);
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(serverId, ownerId);
  return serverId;
}

function makeChannel(serverId, type = 'public') {
  const id = db.prepare('INSERT INTO channels (server_id, name, type) VALUES (?, ?, ?)').run(serverId, `c${++seq}`, type).lastInsertRowid;
  return db.prepare('SELECT * FROM channels WHERE id = ?').get(id);
}

function addMember(serverId, userId, rolePermissions) {
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(serverId, userId);
  if (rolePermissions === undefined) return null;
  const roleId = db.prepare('INSERT INTO roles (server_id, name, permissions, position) VALUES (?, ?, ?, 1)')
    .run(serverId, `r${++seq}`, rolePermissions).lastInsertRowid;
  db.prepare('INSERT INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)').run(serverId, userId, roleId);
  return roleId;
}

function grantChannelOverride(channelId, userId) {
  db.prepare('INSERT INTO channel_user_overrides (channel_id, user_id, allow, deny) VALUES (?, ?, ?, 0)')
    .run(channelId, userId, PERMISSIONS.VIEW_CHANNEL);
}

const overrideCount = (userId) => db.prepare('SELECT COUNT(*) AS c FROM channel_user_overrides WHERE user_id = ?').get(userId).c;

async function withApp(fn) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const uid = Number(req.headers['x-test-user']);
    if (uid) {
      req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
      req.sitePermissions = Number(req.headers['x-test-site-perms']) || 0;
    }
    next();
  });
  app.use('/api/servers', require('../routes/servers'));
  app.use('/api/messages', require('../routes/messages'));
  app.use('/api/admin', require('../routes/admin'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (userId, method, url, body, extra = {}) => fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-user': String(userId), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  try { await fn(call); } finally { server.close(); }
}

test('a leftover channel override grants nothing to a non-member', () => {
  const owner = makeUser();
  const outsider = makeUser();
  const serverId = makeServer(owner);
  const channel = makeChannel(serverId, 'private');
  grantChannelOverride(channel.id, outsider);
  assert.equal(getChannelPermissionBits(channel, outsider), 0);
});

test('kick, ban and leave delete the user\'s channel overrides in that server only', async () => {
  const owner = makeUser();
  const serverId = makeServer(owner);
  const otherServerId = makeServer(owner);
  const channel = makeChannel(serverId, 'private');
  const otherChannel = makeChannel(otherServerId, 'private');
  const kicked = makeUser(); const banned = makeUser(); const leaver = makeUser();
  for (const u of [kicked, banned, leaver]) {
    addMember(serverId, u);
    addMember(otherServerId, u);
    grantChannelOverride(channel.id, u);
    grantChannelOverride(otherChannel.id, u);
  }

  await withApp(async (call) => {
    assert.equal((await call(owner, 'POST', `/api/servers/${serverId}/members/${kicked}/kick`)).status, 200);
    assert.equal((await call(owner, 'POST', `/api/servers/${serverId}/members/${banned}/ban`, { reason: 'x' })).status, 200);
    assert.equal((await call(leaver, 'POST', `/api/servers/${serverId}/leave`)).status, 200);
  });

  for (const u of [kicked, banned, leaver]) {
    assert.equal(overrideCount(u), 1, 'only the other server\'s override remains');
    assert.ok(db.prepare('SELECT 1 FROM channel_user_overrides WHERE user_id = ? AND channel_id = ?').get(u, otherChannel.id));
  }

  // Rejoining the server must not resurrect the private-channel access.
  addMember(serverId, kicked);
  assert.equal(getChannelPermissionBits(channel, kicked) & PERMISSIONS.VIEW_CHANNEL, 0);
});

test('webhook regenerate refuses a webhook from another server without rotating its token', async () => {
  const ownerA = makeUser(); const ownerB = makeUser();
  const serverA = makeServer(ownerA); const serverB = makeServer(ownerB);
  const channelA = makeChannel(serverA); const channelB = makeChannel(serverB);
  const hookB = db.prepare('INSERT INTO webhooks (channel_id, server_id, name, token, created_by) VALUES (?, ?, ?, ?, ?)')
    .run(channelB.id, serverB, 'hook', 'original-token', ownerB).lastInsertRowid;

  await withApp(async (call) => {
    let res = await call(ownerA, 'POST', `/api/servers/${serverA}/channels/${channelB.id}/webhooks/${hookB}/regenerate`);
    assert.equal(res.status, 404);
    res = await call(ownerA, 'POST', `/api/servers/${serverA}/channels/${channelA.id}/webhooks/${hookB}/regenerate`);
    assert.equal(res.status, 404);
    assert.equal(db.prepare('SELECT token FROM webhooks WHERE id = ?').get(hookB).token, 'original-token');

    res = await call(ownerB, 'POST', `/api/servers/${serverB}/channels/${channelB.id}/webhooks/${hookB}/regenerate`);
    assert.equal(res.status, 200);
    assert.notEqual(db.prepare('SELECT token FROM webhooks WHERE id = ?').get(hookB).token, 'original-token');
  });
});

test('a role manager cannot edit a server role holding bits they lack', async () => {
  const owner = makeUser(); const manager = makeUser();
  const serverId = makeServer(owner);
  addMember(serverId, manager, PERMISSIONS.MANAGE_ROLES);
  const adminRole = db.prepare('INSERT INTO roles (server_id, name, permissions, position) VALUES (?, ?, ?, 5)')
    .run(serverId, 'Admins', PERMISSIONS.ADMINISTRATOR).lastInsertRowid;
  const lowRole = db.prepare('INSERT INTO roles (server_id, name, permissions, position) VALUES (?, ?, ?, 0)')
    .run(serverId, 'Low', PERMISSIONS.VIEW_CHANNEL).lastInsertRowid;

  await withApp(async (call) => {
    assert.equal((await call(manager, 'PATCH', `/api/servers/${serverId}/roles/${adminRole}`, { name: 'pwned' })).status, 403);
    assert.equal((await call(manager, 'PATCH', `/api/servers/${serverId}/roles/${adminRole}`, { permissions: 0 })).status, 403);
    assert.equal((await call(manager, 'DELETE', `/api/servers/${serverId}/roles/${adminRole}`)).status, 403);
    assert.equal(db.prepare('SELECT name, permissions FROM roles WHERE id = ?').get(adminRole).permissions, PERMISSIONS.ADMINISTRATOR);
    assert.equal((await call(manager, 'PATCH', `/api/servers/${serverId}/roles/${lowRole}`, { name: 'renamed' })).status, 200);
  });
});

test('a site-role manager cannot edit a site role holding bits they lack', async () => {
  const staffer = makeUser();
  const topRole = db.prepare('INSERT INTO site_roles (name, color, permissions, position) VALUES (?, ?, ?, ?)')
    .run('Top', '#ffffff', SITE_PERMISSIONS.SITE_ADMINISTRATOR, 99).lastInsertRowid;
  const lowRole = db.prepare('INSERT INTO site_roles (name, color, permissions, position) VALUES (?, ?, ?, ?)')
    .run('Low', '#ffffff', SITE_PERMISSIONS.VIEW_ADMIN_PANEL, 1).lastInsertRowid;
  const perms = { 'x-test-site-perms': String(SITE_PERMISSIONS.VIEW_ADMIN_PANEL | SITE_PERMISSIONS.MANAGE_SITE_ROLES) };

  await withApp(async (call) => {
    assert.equal((await call(staffer, 'PATCH', `/api/admin/site-roles/${topRole}`, { permissions: 0 }, perms)).status, 403);
    assert.equal((await call(staffer, 'PATCH', `/api/admin/site-roles/${topRole}`, { name: 'x' }, perms)).status, 403);
    assert.equal(db.prepare('SELECT permissions FROM site_roles WHERE id = ?').get(topRole).permissions, SITE_PERMISSIONS.SITE_ADMINISTRATOR);
    assert.equal((await call(staffer, 'PATCH', `/api/admin/site-roles/${lowRole}`, { name: 'renamed' }, perms)).status, 200);
  });
});

test('authors lose edit/delete on channel and thread messages once they cannot view the channel', async () => {
  const owner = makeUser(); const author = makeUser();
  const serverId = makeServer(owner);
  const channel = makeChannel(serverId);
  addMember(serverId, author);
  const post = (scopeType, scopeId) => db.prepare('INSERT INTO messages (scope_type, scope_id, author_id, content) VALUES (?, ?, ?, ?)')
    .run(scopeType, scopeId, author, 'hello').lastInsertRowid;
  const threadId = db.prepare('INSERT INTO threads (channel_id, title, created_by) VALUES (?, ?, ?)').run(channel.id, 't', author).lastInsertRowid;
  const channelMsg = post('channel', channel.id);
  const threadMsg = post('thread', threadId);
  const keptMsg = post('channel', channel.id);

  await withApp(async (call) => {
    assert.equal((await call(author, 'PATCH', `/api/messages/${keptMsg}`, { content: 'edited' })).status, 200);

    db.prepare('DELETE FROM server_members WHERE server_id = ? AND user_id = ?').run(serverId, author);
    for (const id of [channelMsg, threadMsg]) {
      assert.equal((await call(author, 'PATCH', `/api/messages/${id}`, { content: 'nope' })).status, 403);
      assert.equal((await call(author, 'DELETE', `/api/messages/${id}`)).status, 403);
      assert.equal(db.prepare('SELECT content FROM messages WHERE id = ?').get(id).content, 'hello');
    }

    // Site-wide message moderators keep their override.
    const res = await call(author, 'DELETE', `/api/messages/${channelMsg}`, undefined, { 'x-test-site-perms': String(SITE_PERMISSIONS.DELETE_ANY_MESSAGE) });
    assert.equal(res.status, 200);
  });
});
