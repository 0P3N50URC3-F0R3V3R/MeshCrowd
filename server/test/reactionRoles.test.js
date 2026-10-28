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

let n = 0;
const mkUser = (name) => Number(db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)').run(`${name}${++n}`, `${name}${n}@t.local`, 'h', name).lastInsertRowid);
const EVERYONE = PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.SEND_MESSAGES;
const mkServer = (owner) => {
  const id = Number(db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)').run('Srv', owner, `i${Math.random().toString(36).slice(2, 10)}`).lastInsertRowid);
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(id, owner);
  db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 0, 1)').run(id, '@everyone', EVERYONE);
  return id;
};
const mkRole = (sid, name, permissions = 0) => Number(db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 1, 0)').run(sid, name, permissions).lastInsertRowid);
const mkChannel = (sid, type = 'public') => Number(db.prepare('INSERT INTO channels (server_id, name, type) VALUES (?, ?, ?)').run(sid, 'general', type).lastInsertRowid);
const mkMessage = (ch, author, content = 'Pick your roles') => Number(db.prepare("INSERT INTO messages (scope_type, scope_id, author_id, content) VALUES ('channel', ?, ?, ?)").run(ch, author, content).lastInsertRowid);
const join = (sid, uid) => db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(sid, uid);
const rolesOf = (sid, uid) => db.prepare('SELECT role_id FROM member_roles WHERE server_id = ? AND user_id = ?').all(sid, uid).map((r) => r.role_id).sort();

let server; let base;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const uid = Number(req.headers['x-uid']);
    if (uid) { req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid); req.sitePermissions = 0; }
    next();
  });
  app.use('/api/servers/:id/reaction-roles', require('../routes/reactionRoles'));
  app.use('/api/messages', require('../routes/messages'));
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
const react = (uid, mid, emoji) => call('PUT', `/api/messages/${mid}/reactions/${encodeURIComponent(emoji)}`, uid);
const unreact = (uid, mid, emoji) => call('DELETE', `/api/messages/${mid}/reactions/${encodeURIComponent(emoji)}`, uid);

function world() {
  const owner = mkUser('owner');
  const sid = mkServer(owner);
  const ch = mkChannel(sid);
  const mid = mkMessage(ch, owner);
  const member = mkUser('member');
  join(sid, member);
  return { owner, sid, ch, mid, member };
}
const addMapping = (w, emoji, roleId, extra = {}) => call('POST', `/api/servers/${w.sid}/reaction-roles`, w.owner, { channelId: w.ch, messageId: w.mid, emoji, roleId, ...extra });

test('reacting gives the role and removing the reaction takes it away again', async () => {
  const w = world();
  const gamer = mkRole(w.sid, 'Gamer');
  assert.equal((await addMapping(w, '🎮', gamer)).status, 201);
  assert.deepEqual(rolesOf(w.sid, w.member), []);
  assert.equal((await react(w.member, w.mid, '🎮')).status, 200);
  assert.deepEqual(rolesOf(w.sid, w.member), [gamer]);
  assert.equal((await unreact(w.member, w.mid, '🎮')).status, 200);
  assert.deepEqual(rolesOf(w.sid, w.member), []);
});

test('an unrelated emoji or message gives nothing', async () => {
  const w = world();
  const gamer = mkRole(w.sid, 'Gamer');
  await addMapping(w, '🎮', gamer);
  await react(w.member, w.mid, '🎨');
  const other = mkMessage(w.ch, w.owner, 'other');
  await react(w.member, other, '🎮');
  assert.deepEqual(rolesOf(w.sid, w.member), []);
});

test('creating one validates the message, channel, role and power of the role', async () => {
  const w = world();
  const gamer = mkRole(w.sid, 'Gamer');
  const mod = mkRole(w.sid, 'Mod', PERMISSIONS.BAN_MEMBERS);
  const admin = mkRole(w.sid, 'Admin', PERMISSIONS.ADMINISTRATOR);
  const everyone = db.prepare('SELECT id FROM roles WHERE server_id = ? AND is_default = 1').get(w.sid).id;
  for (const roleId of [mod, admin, everyone]) assert.equal((await addMapping(w, '🎮', roleId)).status, 400, `role ${roleId}`);
  assert.equal((await addMapping(w, '', gamer)).status, 400);
  assert.equal((await addMapping(w, '🎮', 999999)).status, 404);
  assert.equal((await call('POST', `/api/servers/${w.sid}/reaction-roles`, w.owner, { channelId: w.ch, messageId: 999999, emoji: '🎮', roleId: gamer })).status, 404);
  const otherServerMessage = mkMessage(mkChannel(mkServer(mkUser('o2'))), w.owner);
  assert.equal((await call('POST', `/api/servers/${w.sid}/reaction-roles`, w.owner, { channelId: w.ch, messageId: otherServerMessage, emoji: '🎮', roleId: gamer })).status, 404);
  assert.equal((await addMapping(w, '🎮', gamer)).status, 201);
  assert.equal((await addMapping(w, '🎮', gamer)).status, 409, 'same emoji twice');
});

test('only members with Manage Roles may manage them', async () => {
  const w = world();
  const gamer = mkRole(w.sid, 'Gamer');
  assert.equal((await call('GET', `/api/servers/${w.sid}/reaction-roles`, w.member)).status, 403);
  assert.equal((await call('POST', `/api/servers/${w.sid}/reaction-roles`, w.member, { channelId: w.ch, messageId: w.mid, emoji: '🎮', roleId: gamer })).status, 403);
  const created = (await addMapping(w, '🎮', gamer)).data.reactionRole;
  assert.equal((await call('DELETE', `/api/servers/${w.sid}/reaction-roles/${created.id}`, w.member)).status, 403);
  const list = (await call('GET', `/api/servers/${w.sid}/reaction-roles`, w.owner)).data.reactionRoles;
  assert.equal(list.length, 1);
  assert.equal(list[0].roleName, 'Gamer');
  assert.equal(list[0].messagePreview, 'Pick your roles');
  assert.equal((await call('DELETE', `/api/servers/${w.sid}/reaction-roles/${created.id}`, w.owner)).status, 200);
  await react(w.member, w.mid, '🎮');
  assert.deepEqual(rolesOf(w.sid, w.member), []);
});

test('exclusive: choosing one emoji drops the other roles and reactions of that message', async () => {
  const w = world();
  const red = mkRole(w.sid, 'Red'); const blue = mkRole(w.sid, 'Blue');
  await addMapping(w, '🔴', red, { exclusive: true });
  await addMapping(w, '🔵', blue, { exclusive: true });
  await react(w.member, w.mid, '🔴');
  assert.deepEqual(rolesOf(w.sid, w.member), [red]);
  await react(w.member, w.mid, '🔵');
  assert.deepEqual(rolesOf(w.sid, w.member), [blue]);
  const left = db.prepare('SELECT emoji FROM message_reactions WHERE message_id = ? AND user_id = ?').all(w.mid, w.member).map((r) => r.emoji);
  assert.deepEqual(left, ['🔵']);
});

test('a pending member cannot react or collect roles; a role that gained power is not handed out', async () => {
  const w = world();
  const gamer = mkRole(w.sid, 'Gamer');
  await addMapping(w, '🎮', gamer);
  db.prepare('UPDATE servers SET screening_enabled = 1 WHERE id = ?').run(w.sid);
  const fresh = mkUser('fresh');
  join(w.sid, fresh);
  assert.equal((await react(fresh, w.mid, '🎮')).status, 403);
  assert.deepEqual(rolesOf(w.sid, fresh), []);
  db.prepare('UPDATE server_members SET screened_at = ? WHERE user_id = ?').run(new Date().toISOString(), fresh);
  db.prepare('UPDATE roles SET permissions = ? WHERE id = ?').run(PERMISSIONS.KICK_MEMBERS, gamer);
  assert.equal((await react(fresh, w.mid, '🎮')).status, 200);
  assert.deepEqual(rolesOf(w.sid, fresh), [], 'power was added after the mapping');
});

test('deleting the message or the role removes the mapping', async () => {
  const w = world();
  const gamer = mkRole(w.sid, 'Gamer');
  const artist = mkRole(w.sid, 'Artist');
  await addMapping(w, '🎮', gamer);
  await addMapping(w, '🎨', artist);
  db.prepare('DELETE FROM roles WHERE id = ?').run(artist);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reaction_roles WHERE server_id = ?').get(w.sid).n, 1);
  db.prepare('DELETE FROM messages WHERE id = ?').run(w.mid);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reaction_roles WHERE server_id = ?').get(w.sid).n, 0);
});
