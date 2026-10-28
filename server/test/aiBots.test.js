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
const { PERMISSIONS, SITE_PERMISSIONS } = require('../lib/permissions');
const botStore = require('../lib/ai/botStore');

const AI = SITE_PERMISSIONS.MANAGE_AI;
const STAFF = SITE_PERMISSIONS.MANAGE_ANY_SERVER;
const mkUser = (n) => Number(db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
  .run(n, `${n}@t.local`, 'h', n).lastInsertRowid);
const mkServer = (owner, kind = 'chat') => {
  const id = Number(db.prepare('INSERT INTO servers (name, owner_id, invite_code, kind) VALUES (?, ?, ?, ?)').run('Srv', owner, `i${Math.random()}`, kind).lastInsertRowid);
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(id, owner);
  db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 0, 1)').run(id, '@everyone', 3);
  return id;
};
const mkProvider = (extra = {}) => Number(db.prepare(
  'INSERT INTO ai_providers (name, kind, base_url, models, server_admin_usable, enabled) VALUES (?, ?, ?, ?, ?, ?)'
).run(`p${Math.random()}`, 'ollama', 'http://127.0.0.1:11434', JSON.stringify(extra.models || ['m1', 'm2']), extra.usable ?? 1, extra.enabled ?? 1).lastInsertRowid);

let server; let base;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const uid = Number(req.headers['x-uid']);
    if (uid) { req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid); req.sitePermissions = Number(req.headers['x-perms'] || 0); }
    next();
  });
  app.use('/api/admin/ai', require('../routes/adminAi'));
  app.use('/api/servers/:id', require('../routes/serverBots'));
  await new Promise((r) => { server = http.createServer(app).listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.close(); db.close();
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function call(method, url, { uid, perms = 0, json, form } = {}) {
  const headers = {};
  if (uid) { headers['x-uid'] = String(uid); headers['x-perms'] = String(perms); }
  if (json !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(base + url, { method, headers, body: form || (json === undefined ? undefined : JSON.stringify(json)) });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, data, text };
}
const input = (providerId, extra = {}) => ({ displayName: 'Helper', providerId, model: 'm1', persona: 'Be nice', ...extra });

test('createBot makes a bot user, membership, bots row and an audit entry', () => {
  const owner = mkUser('b_owner');
  const serverId = mkServer(owner);
  const bot = botStore.createBot({ serverId, actorId: owner, body: input(mkProvider()), siteAuthority: false });
  assert.equal(bot.user.isBot, true);
  assert.match(bot.user.username, /^helper_bot(_[0-9a-f]{4})?$/);
  assert.equal(bot.mentionEnabled, true);
  assert.equal(bot.dmEnabled, false);
  assert.equal(bot.contextMessages, 12);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(bot.userId);
  assert.equal(u.is_bot, 1);
  assert.equal(u.discoverable, 0);
  assert.match(u.email, /@local\.invalid$/);
  assert.ok(db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(serverId, bot.userId));
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE server_id = ? AND action = 'bot_create'").get(serverId));
});

test('a second bot with the same name gets a unique username', () => {
  const owner = mkUser('b_owner2');
  const serverId = mkServer(owner);
  const p = mkProvider();
  const a = botStore.createBot({ serverId, actorId: owner, body: input(p), siteAuthority: false });
  const b = botStore.createBot({ serverId, actorId: owner, body: input(p), siteAuthority: false });
  assert.notEqual(a.user.username, b.user.username);
});

test('input validation', () => {
  const owner = mkUser('b_val');
  const serverId = mkServer(owner);
  const p = mkProvider({ models: ['m1'] });
  const mk = (body, authority = false) => botStore.createBot({ serverId, actorId: owner, body, siteAuthority: authority });
  assert.throws(() => mk(input(p, { displayName: '' })), /name/i);
  assert.throws(() => mk(input(p, { model: 'other' })), /model/i);
  assert.throws(() => mk(input(p, { persona: 'x'.repeat(4001) })), /persona/i);
  assert.throws(() => mk(input(p, { contextMessages: 99 })), /context/i);
  assert.throws(() => mk(input(99999)), /provider/i);
  assert.throws(() => mk(input(mkProvider({ enabled: 0 }))), /provider/i);
  assert.throws(() => mk(input(mkProvider({ usable: 0 }))), /not available/i);
  assert.doesNotThrow(() => mk(input(mkProvider({ usable: 0 })), true));
  const openList = mkProvider({ models: [] });
  assert.doesNotThrow(() => mk(input(openList, { model: 'anything-goes' })));
});

test('sites cannot have bots', () => {
  const owner = mkUser('b_site');
  const siteId = mkServer(owner, 'site');
  assert.throws(() => botStore.createBot({ serverId: siteId, actorId: owner, body: input(mkProvider()), siteAuthority: false }), /site/i);
});

test('updateBot changes fields, display name and validates the model against a new provider', () => {
  const owner = mkUser('b_upd');
  const serverId = mkServer(owner);
  const p1 = mkProvider({ models: ['a'] });
  const p2 = mkProvider({ models: ['b'] });
  const bot = botStore.createBot({ serverId, actorId: owner, body: input(p1, { model: 'a' }), siteAuthority: false });
  const upd = botStore.updateBot(bot.id, { actorId: owner, body: { displayName: 'Renamed', persona: 'new', dmEnabled: true, mentionEnabled: false, contextMessages: 5 }, siteAuthority: false });
  assert.equal(upd.user.displayName, 'Renamed');
  assert.equal(upd.persona, 'new');
  assert.equal(upd.dmEnabled, true);
  assert.equal(upd.mentionEnabled, false);
  assert.equal(upd.contextMessages, 5);
  assert.throws(() => botStore.updateBot(bot.id, { actorId: owner, body: { providerId: p2 }, siteAuthority: false }), /model/i);
  const moved = botStore.updateBot(bot.id, { actorId: owner, body: { providerId: p2, model: 'b' }, siteAuthority: false });
  assert.equal(moved.providerId, p2);
});

test('deleteBot removes membership and row, disables the user, and keeps past messages', () => {
  const owner = mkUser('b_del');
  const serverId = mkServer(owner);
  const channel = Number(db.prepare("INSERT INTO channels (server_id, name, type) VALUES (?, 'general', 'public')").run(serverId).lastInsertRowid);
  const bot = botStore.createBot({ serverId, actorId: owner, body: input(mkProvider()), siteAuthority: false });
  db.prepare("INSERT INTO messages (scope_type, scope_id, author_id, content) VALUES ('channel', ?, ?, 'old words')").run(channel, bot.userId);
  botStore.deleteBot(bot.id, owner);
  assert.equal(botStore.getBotRow(bot.id), undefined);
  assert.equal(db.prepare('SELECT is_disabled FROM users WHERE id = ?').get(bot.userId).is_disabled, 1);
  assert.equal(db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(serverId, bot.userId), undefined);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM messages WHERE author_id = ?').get(bot.userId).c, 1);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE server_id = ? AND action = 'bot_delete'").get(serverId));
});

test('server routes: permission matrix', async () => {
  const owner = mkUser('r_owner');
  const member = mkUser('r_member');
  const manager = mkUser('r_manager');
  const stranger = mkUser('r_stranger');
  const serverId = mkServer(owner);
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(serverId, member);
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(serverId, manager);
  const role = Number(db.prepare('INSERT INTO roles (server_id, name, permissions, position) VALUES (?, ?, ?, 1)').run(serverId, 'Bots', PERMISSIONS.MANAGE_BOTS).lastInsertRowid);
  db.prepare('INSERT INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)').run(serverId, manager, role);
  const p = mkProvider();
  const url = `/api/servers/${serverId}/bots`;

  assert.equal((await call('GET', url)).status, 401);
  assert.equal((await call('GET', url, { uid: member })).status, 403);
  assert.equal((await call('GET', url, { uid: stranger })).status, 403);
  assert.equal((await call('GET', url, { uid: owner })).status, 200);
  assert.equal((await call('GET', url, { uid: manager })).status, 200);
  assert.equal((await call('GET', url, { uid: stranger, perms: STAFF })).status, 200);
  assert.equal((await call('POST', url, { uid: member, json: input(p) })).status, 403);
  const created = await call('POST', url, { uid: manager, json: input(p) });
  assert.equal(created.status, 201);
  assert.equal(created.data.bot.user.isBot, true);
  const botId = created.data.bot.id;
  assert.equal((await call('PATCH', `${url}/${botId}`, { uid: member, json: { persona: 'x' } })).status, 403);
  assert.equal((await call('PATCH', `${url}/${botId}`, { uid: manager, json: { persona: 'x' } })).status, 200);
  assert.equal((await call('DELETE', `${url}/${botId}`, { uid: manager })).status, 200);
  assert.equal((await call('DELETE', `${url}/${botId}`, { uid: manager })).status, 404);
});

test('a bot id from another server cannot be touched through this server', async () => {
  const ownerA = mkUser('x_a');
  const ownerB = mkUser('x_b');
  const sa = mkServer(ownerA);
  const sb = mkServer(ownerB);
  const bot = botStore.createBot({ serverId: sb, actorId: ownerB, body: input(mkProvider()), siteAuthority: false });
  assert.equal((await call('PATCH', `/api/servers/${sa}/bots/${bot.id}`, { uid: ownerA, json: { persona: 'hijack' } })).status, 404);
  assert.equal((await call('DELETE', `/api/servers/${sa}/bots/${bot.id}`, { uid: ownerA })).status, 404);
});

test('server admins see only usable providers, without URL or key', async () => {
  const owner = mkUser('s_owner');
  const serverId = mkServer(owner);
  mkProvider({ usable: 1 });
  const hidden = mkProvider({ usable: 0 });
  mkProvider({ enabled: 0, usable: 1 });
  const r = await call('GET', `/api/servers/${serverId}/ai/providers`, { uid: owner });
  assert.equal(r.status, 200);
  assert.ok(r.data.providers.length >= 1);
  assert.ok(!r.data.providers.some((x) => x.id === hidden));
  for (const x of r.data.providers) assert.deepEqual(Object.keys(x).sort(), ['id', 'kind', 'models', 'name']);
  const siteView = await call('GET', `/api/servers/${serverId}/ai/providers`, { uid: owner, perms: AI });
  assert.ok(siteView.data.providers.some((x) => x.id === hidden));
});

test('a server admin cannot use a provider that is not offered to them (route)', async () => {
  const owner = mkUser('u_owner');
  const serverId = mkServer(owner);
  const r = await call('POST', `/api/servers/${serverId}/bots`, { uid: owner, json: input(mkProvider({ usable: 0 })) });
  assert.equal(r.status, 403);
});

test('admin routes: any server, requires MANAGE_AI', async () => {
  const owner = mkUser('a_owner');
  const admin = mkUser('a_admin');
  const serverId = mkServer(owner);
  const p = mkProvider({ usable: 0 });
  assert.equal((await call('POST', '/api/admin/ai/bots', { uid: admin, perms: STAFF, json: { serverId, ...input(p) } })).status, 403);
  const r = await call('POST', '/api/admin/ai/bots', { uid: admin, perms: AI, json: { serverId, ...input(p) } });
  assert.equal(r.status, 201);
  assert.equal(r.data.bot.serverId, serverId);
  assert.equal((await call('POST', '/api/admin/ai/bots', { uid: admin, perms: AI, json: { serverId: 99999, ...input(p) } })).status, 404);
  const list = await call('GET', '/api/admin/ai/bots', { uid: admin, perms: AI });
  assert.ok(list.data.bots.some((b) => b.id === r.data.bot.id));
  assert.equal((await call('DELETE', `/api/admin/ai/bots/${r.data.bot.id}`, { uid: admin, perms: AI })).status, 200);
});

test('admin ai server list needs MANAGE_AI and excludes sites', async () => {
  const owner = mkUser('l_owner');
  const admin = mkUser('l_admin');
  const chat = mkServer(owner);
  const site = mkServer(owner, 'site');
  assert.equal((await call('GET', '/api/admin/ai/servers', { uid: admin, perms: STAFF })).status, 403);
  const r = await call('GET', '/api/admin/ai/servers', { uid: admin, perms: AI });
  assert.equal(r.status, 200);
  assert.ok(r.data.servers.some((s) => s.id === chat));
  assert.ok(!r.data.servers.some((s) => s.id === site));
  assert.deepEqual(Object.keys(r.data.servers[0]).sort(), ['id', 'name']);
});

test('avatar upload stores a png and rejects other types', async () => {
  const owner = mkUser('v_owner');
  const serverId = mkServer(owner);
  const bot = botStore.createBot({ serverId, actorId: owner, body: input(mkProvider()), siteAuthority: false });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const good = new FormData();
  good.append('avatar', new Blob([png], { type: 'image/png' }), 'a.png');
  const r = await call('POST', `/api/servers/${serverId}/bots/${bot.id}/avatar`, { uid: owner, form: good });
  assert.equal(r.status, 200);
  assert.match(r.data.bot.user.avatarPath, /^\/uploads\/avatars\/bot-/);
  assert.ok(fs.existsSync(path.join(tmpDir, 'avatars', path.basename(r.data.bot.user.avatarPath))));
  const bad = new FormData();
  bad.append('avatar', new Blob(['hello'], { type: 'text/plain' }), 'a.txt');
  assert.equal((await call('POST', `/api/servers/${serverId}/bots/${bot.id}/avatar`, { uid: owner, form: bad })).status, 400);
});
