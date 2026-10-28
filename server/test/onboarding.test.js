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
const { getChannelPermissionBits, getMemberPermissionBits, isPendingMember } = require('../lib/channelAccess');
const onboarding = require('../lib/onboarding');
const botStore = require('../lib/ai/botStore');

let n = 0;
const mkUser = (name) => Number(db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)').run(`${name}${++n}`, `${name}${n}@t.local`, 'h', name).lastInsertRowid);
const EVERYONE = PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.SEND_MESSAGES | PERMISSIONS.ATTACH_FILES | PERMISSIONS.CREATE_INVITE;
const mkServer = (owner) => {
  const id = Number(db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)').run('Srv', owner, `i${Math.random().toString(36).slice(2, 10)}`).lastInsertRowid);
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(id, owner);
  db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 0, 1)').run(id, '@everyone', EVERYONE);
  return id;
};
const mkRole = (sid, name, permissions = 0) => Number(db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 1, 0)').run(sid, name, permissions).lastInsertRowid);
const mkChannel = (sid, name = 'general') => Number(db.prepare('INSERT INTO channels (server_id, name, type) VALUES (?, ?, ?)').run(sid, name, 'public').lastInsertRowid);
const join = (sid, uid) => db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(sid, uid);
const channelOf = (id) => db.prepare('SELECT * FROM channels WHERE id = ?').get(id);

let server; let base;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const uid = Number(req.headers['x-uid']);
    if (uid) { req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid); req.sitePermissions = 0; }
    next();
  });
  app.use('/api/servers/:id/onboarding', require('../routes/onboarding'));
  app.use('/api/servers/:id/channels/:channelId/messages', require('../routes/channelMessages'));
  app.use('/api/servers', require('../routes/servers'));
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

function world() {
  const owner = mkUser('owner');
  const sid = mkServer(owner);
  const ch = mkChannel(sid);
  const old = mkUser('old');
  join(sid, old);
  return { owner, sid, ch, old };
}
const config = (w, extra = {}) => call('PUT', `/api/servers/${w.sid}/onboarding`, w.owner, { enabled: true, rules: 'Be kind.', ...extra });

test('saving validates the rules, the questions and the roles they hand out', async () => {
  const w = world();
  assert.equal((await config(w, { rules: '   ' })).status, 400);
  assert.equal((await config(w, { rules: 'x'.repeat(4001) })).status, 400);
  assert.equal((await config(w, { questions: Array.from({ length: 6 }, () => ({ title: 'q', options: [{ label: 'a' }] })) })).status, 400);
  assert.equal((await config(w, { questions: [{ title: '', options: [{ label: 'a' }] }] })).status, 400);
  assert.equal((await config(w, { questions: [{ title: 'q', options: [] }] })).status, 400);
  assert.equal((await config(w, { questions: [{ title: 'q', options: [{ label: 'a', roleId: 999999 }] }] })).status, 400);
  const mod = mkRole(w.sid, 'Mod', PERMISSIONS.KICK_MEMBERS);
  const admin = mkRole(w.sid, 'Admin', PERMISSIONS.ADMINISTRATOR);
  const everyone = db.prepare('SELECT id FROM roles WHERE server_id = ? AND is_default = 1').get(w.sid).id;
  for (const roleId of [mod, admin, everyone]) {
    assert.equal((await config(w, { questions: [{ title: 'q', options: [{ label: 'a', roleId }] }] })).status, 400, `role ${roleId}`);
  }
  const fine = mkRole(w.sid, 'Gamer');
  assert.equal((await config(w, { questions: [{ title: 'Pick', options: [{ label: 'Games', roleId: fine }] }] })).status, 200);
  const other = world();
  assert.equal((await call('PUT', `/api/servers/${w.sid}/onboarding`, other.owner, { enabled: true, rules: 'x' })).status, 403);
});

test('turning screening on does not lock out existing members, but new joiners are pending', async () => {
  const w = world();
  assert.equal((await config(w)).status, 200);
  assert.equal(isPendingMember(w.sid, w.old), false);
  const fresh = mkUser('fresh');
  join(w.sid, fresh);
  assert.equal(isPendingMember(w.sid, fresh), true);
  assert.equal(isPendingMember(w.sid, w.owner), false);
});

test('a pending member can look but not take part; accepting restores normal access', async () => {
  const w = world();
  await config(w);
  const fresh = mkUser('fresh');
  join(w.sid, fresh);
  const ch = channelOf(w.ch);
  const bits = getChannelPermissionBits(ch, fresh);
  assert.equal(bits, PERMISSIONS.VIEW_CHANNEL);
  assert.equal(getMemberPermissionBits(w.sid, fresh), PERMISSIONS.VIEW_CHANNEL);
  const post = (uid) => fetch(`${base}/api/servers/${w.sid}/channels/${w.ch}/messages`, { method: 'POST', headers: { 'x-uid': String(uid), 'content-type': 'application/json' }, body: JSON.stringify({ content: 'hello' }) }).then((r) => r.status);
  assert.equal(await post(fresh), 403);
  assert.equal(await post(w.old), 201);

  const accepted = await call('POST', `/api/servers/${w.sid}/onboarding/accept`, fresh, { answers: {} });
  assert.equal(accepted.status, 200);
  assert.equal(isPendingMember(w.sid, fresh), false);
  assert.equal(await post(fresh), 201);
  assert.equal((await call('POST', `/api/servers/${w.sid}/onboarding/accept`, fresh, {})).status, 200, 'accepting twice is harmless');
});

test('a channel override cannot give a pending member more than view access', () => {
  const w = world();
  db.prepare('UPDATE servers SET screening_enabled = 1, rules_text = ? WHERE id = ?').run('rules', w.sid);
  const fresh = mkUser('fresh');
  join(w.sid, fresh);
  const role = mkRole(w.sid, 'Special');
  db.prepare('INSERT INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)').run(w.sid, fresh, role);
  db.prepare('INSERT INTO channel_role_overrides (channel_id, role_id, allow, deny) VALUES (?, ?, ?, 0)').run(w.ch, role, PERMISSIONS.SEND_MESSAGES | PERMISSIONS.MANAGE_MESSAGES);
  assert.equal(getChannelPermissionBits(channelOf(w.ch), fresh), PERMISSIONS.VIEW_CHANNEL);
});

test('answers hand out roles; bad answers are refused and nothing is granted', async () => {
  const w = world();
  const gamer = mkRole(w.sid, 'Gamer');
  const artist = mkRole(w.sid, 'Artist');
  const saved = await config(w, { questions: [
    { title: 'Interests', multi: true, options: [{ label: 'Games', roleId: gamer }, { label: 'Art', roleId: artist }, { label: 'Nothing' }] },
    { title: 'Region', multi: false, options: [{ label: 'EU' }, { label: 'US' }] },
  ] });
  const [q1, q2] = saved.data.config.questions;
  const fresh = mkUser('fresh');
  join(w.sid, fresh);
  const bad = await call('POST', `/api/servers/${w.sid}/onboarding/accept`, fresh, { answers: { [q2.id]: [q2.options[0].id, q2.options[1].id] } });
  assert.equal(bad.status, 400, 'single choice');
  const wrong = await call('POST', `/api/servers/${w.sid}/onboarding/accept`, fresh, { answers: { [q1.id]: [q2.options[0].id] } });
  assert.equal(wrong.status, 400, 'option from another question');
  assert.equal(isPendingMember(w.sid, fresh), true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM member_roles WHERE user_id = ?').get(fresh).n, 0);
  const ok = await call('POST', `/api/servers/${w.sid}/onboarding/accept`, fresh, { answers: { [q1.id]: [q1.options[0].id, q1.options[1].id], [q2.id]: [q2.options[1].id] } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.data.roleIds.sort(), [gamer, artist].sort());
  assert.deepEqual(db.prepare('SELECT role_id FROM member_roles WHERE user_id = ?').all(fresh).map((r) => r.role_id).sort(), [gamer, artist].sort());
});

test('a role that gained power after the question was saved is not handed out', async () => {
  const w = world();
  const role = mkRole(w.sid, 'Later');
  const saved = await config(w, { questions: [{ title: 'q', options: [{ label: 'a', roleId: role }] }] });
  db.prepare('UPDATE roles SET permissions = ? WHERE id = ?').run(PERMISSIONS.BAN_MEMBERS, role);
  const fresh = mkUser('fresh');
  join(w.sid, fresh);
  const q = saved.data.config.questions[0];
  const res = await call('POST', `/api/servers/${w.sid}/onboarding/accept`, fresh, { answers: { [q.id]: [q.options[0].id] } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.roleIds, []);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM member_roles WHERE user_id = ?').get(fresh).n, 0);
});

test('members see the public config, managers the full one with role wiring', async () => {
  const w = world();
  const role = mkRole(w.sid, 'Gamer');
  await config(w, { rules: 'Rule one', questions: [{ title: 'q', options: [{ label: 'a', roleId: role }] }] });
  const fresh = mkUser('fresh');
  join(w.sid, fresh);
  const asMember = (await call('GET', `/api/servers/${w.sid}/onboarding`, fresh)).data;
  assert.equal(asMember.pending, true);
  assert.equal(asMember.rules, 'Rule one');
  assert.equal(asMember.questions[0].options[0].roleId, undefined);
  assert.equal(asMember.config, undefined);
  const asOwner = (await call('GET', `/api/servers/${w.sid}/onboarding`, w.owner)).data;
  assert.equal(asOwner.canManage, true);
  assert.equal(asOwner.config.questions[0].options[0].roleId, role);
  assert.equal((await call('GET', `/api/servers/${w.sid}/onboarding`, mkUser('stranger'))).status, 403);
});

test('the server detail carries the screening data only while a member is pending', async () => {
  const w = world();
  await config(w);
  const fresh = mkUser('fresh');
  join(w.sid, fresh);
  assert.ok((await call('GET', `/api/servers/${w.sid}`, fresh)).data.onboarding);
  assert.equal((await call('GET', `/api/servers/${w.sid}`, w.old)).data.onboarding, null);
  await call('POST', `/api/servers/${w.sid}/onboarding/accept`, fresh, {});
  assert.equal((await call('GET', `/api/servers/${w.sid}`, fresh)).data.onboarding, null);
});

test('bots are never pending, and turning screening off lifts the restriction', async () => {
  const w = world();
  await config(w);
  const bot = botStore.createBot({ serverId: w.sid, actorId: w.owner, body: { displayName: 'Helper' }, siteAuthority: true });
  assert.equal(isPendingMember(w.sid, bot.userId), false);
  const fresh = mkUser('fresh');
  join(w.sid, fresh);
  assert.equal(isPendingMember(w.sid, fresh), true);
  await call('PUT', `/api/servers/${w.sid}/onboarding`, w.owner, { enabled: false, rules: 'Be kind.' });
  assert.equal(isPendingMember(w.sid, fresh), false);
  assert.ok(getChannelPermissionBits(channelOf(w.ch), fresh) & PERMISSIONS.SEND_MESSAGES);
});
