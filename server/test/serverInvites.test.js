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
const invites = require('../lib/serverInvites');

const mkUser = (n) => Number(db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)').run(n, `${n}@t.local`, 'h', n).lastInsertRowid);
const mkServer = (owner, everyonePerms = PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.SEND_MESSAGES | PERMISSIONS.CREATE_INVITE) => {
  const id = Number(db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)').run('Srv', owner, `i${Math.random().toString(36).slice(2, 10)}`).lastInsertRowid);
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(id, owner);
  db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 0, 1)').run(id, '@everyone', everyonePerms);
  return id;
};
const addMember = (sid, uid) => db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(sid, uid);

let server; let base;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const uid = Number(req.headers['x-uid']);
    if (uid) { req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid); req.sitePermissions = 0; }
    next();
  });
  app.use('/api/servers/:id/invites', require('../routes/serverInvites'));
  app.use('/api/servers', require('../routes/servers'));
  await new Promise((r) => { server = http.createServer(app).listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.close(); db.close();
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function call(method, url, uid, json) {
  const res = await fetch(base + url, { method, headers: { 'x-uid': String(uid), ...(json !== undefined ? { 'content-type': 'application/json' } : {}) }, body: json === undefined ? undefined : JSON.stringify(json) });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const join = (uid, code) => call('POST', '/api/servers/join', uid, { inviteCode: code });
const uses = (id) => db.prepare('SELECT uses FROM server_invites WHERE id = ?').get(id).uses;

test('creating an invite validates its limits', async () => {
  const owner = mkUser('iv_o1');
  const sid = mkServer(owner);
  const ok = await call('POST', `/api/servers/${sid}/invites`, owner, { maxUses: 5, expiresInSeconds: 3600 });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.invite.maxUses, 5);
  assert.ok(new Date(ok.data.invite.expiresAt) > new Date());
  assert.match(ok.data.invite.code, /^[A-Za-z0-9]{8}$/);
  const forever = await call('POST', `/api/servers/${sid}/invites`, owner, {});
  assert.equal(forever.data.invite.maxUses, null);
  assert.equal(forever.data.invite.expiresAt, null);
  for (const bad of [{ maxUses: 0 }, { maxUses: 1.5 }, { maxUses: 5000 }, { maxUses: 'x' }, { expiresInSeconds: 5 }, { expiresInSeconds: 99999999 }]) {
    assert.equal((await call('POST', `/api/servers/${sid}/invites`, owner, bad)).status, 400, JSON.stringify(bad));
  }
});

test('a member without Create Invite can neither list nor create, and non-members are refused', async () => {
  const owner = mkUser('iv_o2');
  const sid = mkServer(owner, PERMISSIONS.VIEW_CHANNEL);
  const plain = mkUser('iv_plain2');
  addMember(sid, plain);
  const stranger = mkUser('iv_stranger2');
  assert.equal((await call('GET', `/api/servers/${sid}/invites`, plain)).status, 403);
  assert.equal((await call('POST', `/api/servers/${sid}/invites`, plain, {})).status, 403);
  assert.equal((await call('GET', `/api/servers/${sid}/invites`, stranger)).status, 403);
  assert.equal((await call('GET', `/api/servers/${sid}/invites`, owner)).status, 200);
});

test('members see and revoke only their own invites; a manager sees and revokes all', async () => {
  const owner = mkUser('iv_o3');
  const sid = mkServer(owner);
  const a = mkUser('iv_a3'); const b = mkUser('iv_b3');
  addMember(sid, a); addMember(sid, b);
  const inviteA = (await call('POST', `/api/servers/${sid}/invites`, a, {})).data.invite;
  const inviteB = (await call('POST', `/api/servers/${sid}/invites`, b, {})).data.invite;
  assert.deepEqual((await call('GET', `/api/servers/${sid}/invites`, a)).data.invites.map((i) => i.id), [inviteA.id]);
  assert.deepEqual((await call('GET', `/api/servers/${sid}/invites`, owner)).data.invites.map((i) => i.id).sort(), [inviteA.id, inviteB.id].sort());
  assert.equal((await call('DELETE', `/api/servers/${sid}/invites/${inviteB.id}`, a)).status, 403);
  assert.equal((await call('DELETE', `/api/servers/${sid}/invites/${inviteA.id}`, a)).status, 200);
  assert.equal((await call('DELETE', `/api/servers/${sid}/invites/${inviteB.id}`, owner)).status, 200);
  assert.equal((await call('DELETE', `/api/servers/${sid}/invites/${inviteB.id}`, owner)).status, 404);
});

test('joining with an invite counts one use per new member and never for someone already in', async () => {
  const owner = mkUser('iv_o4');
  const sid = mkServer(owner);
  const inv = (await call('POST', `/api/servers/${sid}/invites`, owner, { maxUses: 2 })).data.invite;
  const g1 = mkUser('iv_g41'); const g2 = mkUser('iv_g42'); const g3 = mkUser('iv_g43');
  assert.equal((await join(g1, inv.code)).status, 200);
  assert.equal(uses(inv.id), 1);
  assert.equal((await join(g1, inv.code)).status, 200, 'an existing member is not charged again');
  assert.equal(uses(inv.id), 1);
  assert.equal((await join(owner, inv.code)).status, 200);
  assert.equal(uses(inv.id), 1);
  assert.equal((await join(g2, inv.code)).status, 200);
  assert.equal(uses(inv.id), 2);
  const full = await join(g3, inv.code);
  assert.equal(full.status, 410);
  assert.match(full.data.error, /use limit/);
  assert.equal(db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(sid, g3), undefined);
});

test('an expired or revoked invite cannot be used, and the permanent server code keeps working', async () => {
  const owner = mkUser('iv_o5');
  const sid = mkServer(owner);
  const inv = (await call('POST', `/api/servers/${sid}/invites`, owner, { expiresInSeconds: 3600 })).data.invite;
  db.prepare('UPDATE server_invites SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), inv.id);
  const late = mkUser('iv_late5');
  const expired = await join(late, inv.code);
  assert.equal(expired.status, 410);
  assert.match(expired.data.error, /expired/);
  const live = (await call('POST', `/api/servers/${sid}/invites`, owner, {})).data.invite;
  await call('DELETE', `/api/servers/${sid}/invites/${live.id}`, owner);
  assert.equal((await join(late, live.code)).status, 404);
  const code = db.prepare('SELECT invite_code FROM servers WHERE id = ?').get(sid).invite_code;
  assert.equal((await join(late, code)).status, 200);
});

test('a banned user is refused without using up the invite', async () => {
  const owner = mkUser('iv_o6');
  const sid = mkServer(owner);
  const inv = (await call('POST', `/api/servers/${sid}/invites`, owner, { maxUses: 1 })).data.invite;
  const banned = mkUser('iv_ban6');
  db.prepare('INSERT INTO server_bans (server_id, user_id, banned_by) VALUES (?, ?, ?)').run(sid, banned, owner);
  assert.equal((await join(banned, inv.code)).status, 403);
  assert.equal(uses(inv.id), 0);
});

test('invite limits per user and per server are enforced', async () => {
  const owner = mkUser('iv_o7');
  const sid = mkServer(owner);
  for (let i = 0; i < invites.MAX_ACTIVE_PER_USER; i++) assert.equal((await call('POST', `/api/servers/${sid}/invites`, owner, {})).status, 201);
  assert.equal((await call('POST', `/api/servers/${sid}/invites`, owner, {})).status, 409);
});

test('vanity links: validation, reserved and taken names, case-insensitive join, clearing', async () => {
  const owner = mkUser('iv_o8');
  const sid = mkServer(owner);
  const other = mkServer(mkUser('iv_o8b'));
  const put = (uid, sidd, code) => call('PUT', `/api/servers/${sidd}/invites/vanity`, uid, { code });
  for (const bad of ['ab', '-abc', 'abc-', 'has space', 'UPPER_case', 'x'.repeat(33), 'api', 'join']) {
    assert.equal((await put(owner, sid, bad)).status, 400, bad);
  }
  const ok = await put(owner, sid, 'My-Game');
  assert.equal(ok.status, 200);
  assert.equal(ok.data.vanityCode, 'my-game');
  assert.equal((await put(db.prepare('SELECT owner_id FROM servers WHERE id = ?').get(other).owner_id, other, 'my-game')).status, 409);
  const guest = mkUser('iv_g8');
  assert.equal((await join(guest, 'MY-GAME')).status, 200);
  assert.equal((await call('GET', `/api/servers/${sid}/invites`, owner)).data.vanityCode, 'my-game');
  const member = mkUser('iv_m8');
  addMember(sid, member);
  assert.equal((await put(member, sid, 'nope-name')).status, 403, 'needs Manage Server');
  assert.equal((await put(owner, sid, null)).data.vanityCode, null);
  assert.equal((await join(mkUser('iv_late8'), 'my-game')).status, 404);
});

test('a vanity name cannot equal another server\'s permanent invite code', async () => {
  const owner = mkUser('iv_o9');
  const sid = mkServer(owner);
  const other = mkServer(mkUser('iv_o9b'));
  const taken = db.prepare('SELECT invite_code FROM servers WHERE id = ?').get(other).invite_code;
  const res = await call('PUT', `/api/servers/${sid}/invites/vanity`, owner, { code: taken });
  assert.equal(res.status, 409);
});

test('expired invites are swept out', () => {
  const owner = mkUser('iv_o10');
  const sid = mkServer(owner);
  db.prepare('INSERT INTO server_invites (server_id, code, created_by, expires_at) VALUES (?, ?, ?, ?)').run(sid, 'oldcode1', owner, new Date(Date.now() - 5000).toISOString());
  db.prepare('INSERT INTO server_invites (server_id, code, created_by) VALUES (?, ?, ?)').run(sid, 'newcode1', owner);
  invites.sweepExpired();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM server_invites WHERE server_id = ?').get(sid).n, 1);
});

test('deleting a server removes its invites', () => {
  const owner = mkUser('iv_o11');
  const sid = mkServer(owner);
  db.prepare('INSERT INTO server_invites (server_id, code, created_by) VALUES (?, ?, ?)').run(sid, 'cascade1', owner);
  db.prepare('DELETE FROM servers WHERE id = ?').run(sid);
  assert.equal(db.prepare("SELECT 1 FROM server_invites WHERE code = 'cascade1'").get(), undefined);
});
