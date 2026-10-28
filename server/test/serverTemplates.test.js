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
const templates = require('../lib/serverTemplates');

let n = 0;
const mkUser = (name) => Number(db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)').run(`${name}${++n}`, `${name}${n}@t.local`, 'h', name).lastInsertRowid);
const EVERYONE = PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.SEND_MESSAGES | PERMISSIONS.CREATE_INVITE;
const mkServer = (owner) => {
  const id = Number(db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)').run('Src', owner, `i${Math.random().toString(36).slice(2, 10)}`).lastInsertRowid);
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(id, owner);
  db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 0, 1)').run(id, '@everyone', EVERYONE);
  return id;
};

function buildSource() {
  const owner = mkUser('owner');
  const sid = mkServer(owner);
  const mod = Number(db.prepare('INSERT INTO roles (server_id, name, color, permissions, position) VALUES (?, ?, ?, ?, 2)').run(sid, 'Moderator', '#ff0000', PERMISSIONS.KICK_MEMBERS | PERMISSIONS.MANAGE_MESSAGES).lastInsertRowid);
  const gamer = Number(db.prepare('INSERT INTO roles (server_id, name, color, permissions, position) VALUES (?, ?, ?, 0, 1)').run(sid, 'Gamer', '#00ff00').lastInsertRowid);
  const text = Number(db.prepare('INSERT INTO channel_categories (server_id, name, position) VALUES (?, ?, 0)').run(sid, 'Text').lastInsertRowid);
  const general = Number(db.prepare("INSERT INTO channels (server_id, name, type, topic, position, category_id, slowmode_seconds) VALUES (?, 'general', 'public', 'chat here', 0, ?, 5)").run(sid, text).lastInsertRowid);
  const staff = Number(db.prepare("INSERT INTO channels (server_id, name, type, position, category_id) VALUES (?, 'staff', 'private', 1, ?)").run(sid, text).lastInsertRowid);
  const voice = Number(db.prepare("INSERT INTO channels (server_id, name, type, position, voice_quality) VALUES (?, 'lounge', 'voice', 2, 'high')").run(sid).lastInsertRowid);
  db.prepare("INSERT INTO channels (server_id, name, type, position) VALUES (?, 'my notes', 'notes', 3)").run(sid);
  const everyoneId = db.prepare('SELECT id FROM roles WHERE server_id = ? AND is_default = 1').get(sid).id;
  db.prepare('INSERT INTO channel_role_overrides (channel_id, role_id, allow, deny) VALUES (?, ?, ?, 0)').run(staff, mod, PERMISSIONS.VIEW_CHANNEL);
  db.prepare('INSERT INTO channel_role_overrides (channel_id, role_id, allow, deny) VALUES (?, ?, 0, ?)').run(general, everyoneId, PERMISSIONS.ATTACH_FILES);
  db.prepare("UPDATE servers SET rules_text = 'Be kind' WHERE id = ?").run(sid);
  // things that must NOT travel: members, messages, emoji, bots
  const other = mkUser('member');
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(sid, other);
  db.prepare("INSERT INTO messages (scope_type, scope_id, author_id, content) VALUES ('channel', ?, ?, 'secret chatter')").run(general, owner);
  return { owner, sid, mod, gamer, general, staff, voice };
}

let server; let base;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const uid = Number(req.headers['x-uid']);
    if (uid) { req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid); req.sitePermissions = 0; }
    next();
  });
  const routes = require('../routes/serverTemplates');
  app.use('/api/servers/:id/templates', routes.serverRouter);
  app.use('/api/templates', routes.codeRouter);
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

test('a template captures structure and nothing else', async () => {
  const s = buildSource();
  const res = await call('POST', `/api/servers/${s.sid}/templates`, s.owner, { name: 'Community', description: 'A starter' });
  assert.equal(res.status, 201);
  const t = res.data.template;
  assert.match(t.code, /^[A-Za-z0-9]{8}$/);
  assert.deepEqual(t.summary.channels.map((c) => c.name), ['general', 'staff', 'lounge'], 'notes channels are left out');
  assert.equal(t.summary.roles, 2);
  const stored = db.prepare('SELECT snapshot FROM server_templates WHERE id = ?').get(t.id).snapshot;
  assert.ok(!stored.includes('secret chatter'));
  assert.ok(!stored.includes('member'));
});

test('using a template builds an equivalent server owned by the user, without members or messages', async () => {
  const s = buildSource();
  const t = (await call('POST', `/api/servers/${s.sid}/templates`, s.owner, { name: 'Community' })).data.template;
  const newcomer = mkUser('newcomer');
  const preview = await call('GET', `/api/templates/${t.code}`, newcomer);
  assert.equal(preview.status, 200);
  assert.equal(preview.data.template.code, undefined, 'a preview never repeats the code');
  const used = await call('POST', `/api/templates/${t.code}/use`, newcomer, { name: 'My Server' });
  assert.equal(used.status, 201);
  const sid = used.data.server.id;
  assert.equal(used.data.server.owner_id, newcomer);
  assert.equal(used.data.server.name, 'My Server');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM server_members WHERE server_id = ?').get(sid).c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM messages WHERE scope_type = 'channel' AND scope_id IN (SELECT id FROM channels WHERE server_id = ?)").get(sid).c, 0);
  assert.equal(db.prepare('SELECT rules_text FROM servers WHERE id = ?').get(sid).rules_text, 'Be kind');

  const roles = db.prepare('SELECT * FROM roles WHERE server_id = ? ORDER BY position ASC').all(sid);
  assert.deepEqual(roles.map((r) => r.name), ['@everyone', 'Gamer', 'Moderator']);
  assert.equal(roles[0].permissions, EVERYONE);
  assert.equal(roles[0].is_default, 1);
  assert.equal(roles[2].permissions, PERMISSIONS.KICK_MEMBERS | PERMISSIONS.MANAGE_MESSAGES);
  assert.equal(roles[2].color, '#ff0000');

  const cats = db.prepare('SELECT * FROM channel_categories WHERE server_id = ?').all(sid);
  assert.equal(cats.length, 1);
  const chans = db.prepare('SELECT * FROM channels WHERE server_id = ? ORDER BY position ASC').all(sid);
  assert.deepEqual(chans.map((c) => [c.name, c.type]), [['general', 'public'], ['staff', 'private'], ['lounge', 'voice']]);
  assert.equal(chans[0].topic, 'chat here');
  assert.equal(chans[0].slowmode_seconds, 5);
  assert.equal(chans[0].category_id, cats[0].id);
  assert.equal(chans[2].voice_quality, 'high');
  const modRole = roles.find((r) => r.name === 'Moderator').id;
  const staffOverride = db.prepare('SELECT * FROM channel_role_overrides WHERE channel_id = ?').get(chans[1].id);
  assert.equal(staffOverride.role_id, modRole);
  assert.equal(staffOverride.allow, PERMISSIONS.VIEW_CHANNEL);
  const generalOverride = db.prepare('SELECT * FROM channel_role_overrides WHERE channel_id = ?').get(chans[0].id);
  assert.equal(generalOverride.role_id, roles[0].id, 'the @everyone override lands on the new @everyone role');
  assert.equal(generalOverride.deny, PERMISSIONS.ATTACH_FILES);
  assert.equal(db.prepare('SELECT uses FROM server_templates WHERE id = ?').get(t.id).uses, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM servers').get().c >= 2, true);
});

test('only members with Manage Server manage templates; the source stays untouched', async () => {
  const s = buildSource();
  const plain = mkUser('plain');
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(s.sid, plain);
  assert.equal((await call('GET', `/api/servers/${s.sid}/templates`, plain)).status, 403);
  assert.equal((await call('POST', `/api/servers/${s.sid}/templates`, plain, { name: 'x' })).status, 403);
  assert.equal((await call('POST', `/api/servers/${s.sid}/templates`, s.owner, { name: '' })).status, 400);
  const made = (await call('POST', `/api/servers/${s.sid}/templates`, s.owner, { name: 'T1' })).data.template;
  assert.equal((await call('GET', `/api/servers/${s.sid}/templates`, s.owner)).data.templates.length, 1);
  const other = buildSource();
  assert.equal((await call('DELETE', `/api/servers/${other.sid}/templates/${made.id}`, other.owner)).status, 404, 'another server cannot delete it');
  assert.equal((await call('DELETE', `/api/servers/${s.sid}/templates/${made.id}`, s.owner)).status, 200);
  assert.equal((await call('GET', `/api/templates/${made.code}`, s.owner)).status, 404);
  for (let i = 0; i < templates.MAX_TEMPLATES_PER_SERVER; i++) assert.equal((await call('POST', `/api/servers/${s.sid}/templates`, s.owner, { name: `t${i}` })).status, 201);
  assert.equal((await call('POST', `/api/servers/${s.sid}/templates`, s.owner, { name: 'one too many' })).status, 409);
});

test('syncing refreshes the snapshot from the source server', async () => {
  const s = buildSource();
  const t = (await call('POST', `/api/servers/${s.sid}/templates`, s.owner, { name: 'Live' })).data.template;
  db.prepare("INSERT INTO channels (server_id, name, type, position) VALUES (?, 'added-later', 'public', 9)").run(s.sid);
  assert.equal((await call('GET', `/api/templates/${t.code}`, s.owner)).data.template.summary.channels.length, 3);
  const synced = await call('POST', `/api/servers/${s.sid}/templates/${t.id}/sync`, s.owner);
  assert.equal(synced.data.template.summary.channels.length, 4);
  assert.equal((await call('GET', `/api/templates/${t.code}`, s.owner)).data.template.summary.channels.length, 4);
});

test('a template outlives its source server', async () => {
  const s = buildSource();
  const t = (await call('POST', `/api/servers/${s.sid}/templates`, s.owner, { name: 'Keeper' })).data.template;
  db.prepare('DELETE FROM servers WHERE id = ?').run(s.sid);
  const used = await call('POST', `/api/templates/${t.code}/use`, mkUser('later'), { name: 'Copy' });
  assert.equal(used.status, 201);
});

test('a hand-edited or hostile snapshot is rejected, never half-applied', async () => {
  const s = buildSource();
  const t = (await call('POST', `/api/servers/${s.sid}/templates`, s.owner, { name: 'Tampered' })).data.template;
  const user = mkUser('victim');
  const before = db.prepare('SELECT COUNT(*) AS c FROM servers').get().c;
  const tamper = (mutate) => {
    const snap = JSON.parse(db.prepare('SELECT snapshot FROM server_templates WHERE id = ?').get(t.id).snapshot);
    mutate(snap);
    db.prepare('UPDATE server_templates SET snapshot = ? WHERE id = ?').run(JSON.stringify(snap), t.id);
  };
  tamper((snap) => { snap.channels[0].type = 'webhook'; });
  assert.equal((await call('POST', `/api/templates/${t.code}/use`, user, {})).status, 400);
  assert.equal((await call('GET', `/api/templates/${t.code}`, user)).status >= 400, true);
  tamper((snap) => { snap.channels[0].type = 'public'; snap.channels[1].category = 99; });
  assert.equal((await call('POST', `/api/templates/${t.code}/use`, user, {})).status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM servers').get().c, before, 'no server was created');
});

test('validateSnapshot masks permission bits, clamps numbers and rebuilds every field', () => {
  const snap = templates.validateSnapshot({
    v: 1, everyonePermissions: -1 >>> 0 > 0 ? 0x7fffffff : 0, rulesText: 'r'.repeat(9000),
    roles: [{ name: 'A', color: 'javascript:alert(1)', permissions: 0x7fffffff, position: 99999 }],
    categories: [{ name: 'C', position: -5 }],
    channels: [{ name: 'x', type: 'voice', topic: 't', position: 1e9, category: 0, slowmodeSeconds: 1e9, voiceQuality: 'nope', overrides: [{ role: 'everyone', allow: 1, deny: 0 }] }],
  });
  assert.equal(snap.roles[0].color, '#99aab5');
  assert.equal(snap.roles[0].position, 1000);
  assert.equal(snap.rulesText.length, 4000);
  assert.equal(snap.categories[0].position, 0);
  assert.equal(snap.channels[0].slowmodeSeconds, 21600);
  assert.equal(snap.channels[0].voiceQuality, 'medium');
  assert.equal(snap.channels[0].position, 10000);
  assert.throws(() => templates.validateSnapshot({ v: 2 }), templates.TemplateError);
  assert.throws(() => templates.validateSnapshot({ v: 1, roles: [{ name: '@everyone' }], categories: [], channels: [] }), templates.TemplateError);
  assert.throws(() => templates.validateSnapshot({ v: 1, roles: Array.from({ length: 51 }, (_, i) => ({ name: `r${i}` })), categories: [], channels: [] }), templates.TemplateError);
});
