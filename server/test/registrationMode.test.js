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
const appConfig = require('../lib/config');
const registration = require('../lib/registration');
const invites = require('../lib/serverInvites');

let server; let base;
const body = (n, extra = {}) => ({ username: n, email: `${n}@t.local`, password: 'longenoughpw', ...extra });
const post = async (p, b) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  return { status: r.status, json: await r.json() };
};

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/passport', require('../routes/passport'));
  await new Promise((ok) => { server = http.createServer(app).listen(0, '127.0.0.1', ok); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.close(); db.close();
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('defaults to open and ignores unknown values', () => {
  assert.equal(registration.getMode(), 'open');
  appConfig.save({ registrationMode: 'bogus' });
  assert.equal(registration.getMode(), 'open');
});

test('first account is allowed in every mode', async () => {
  appConfig.save({ registrationMode: 'closed' });
  const r = await post('/api/auth/register', body('first'));
  assert.equal(r.status, 201);
});

test('closed refuses both register endpoints', async () => {
  appConfig.save({ registrationMode: 'closed' });
  assert.equal((await post('/api/auth/register', body('second'))).status, 403);
  assert.equal((await post('/api/passport/register', body('second'))).status, 403);
});

test('invite mode needs a live invite code', async () => {
  appConfig.save({ registrationMode: 'invite' });
  const owner = db.prepare("SELECT id FROM users WHERE username = 'first'").get().id;
  const sid = Number(db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)').run('S', owner, 'srvcode1').lastInsertRowid);
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(sid, owner);
  assert.equal((await post('/api/auth/register', body('user1'))).status, 403);
  assert.equal((await post('/api/auth/register', body('user1', { inviteCode: 'nope' }))).status, 403);
  assert.equal((await post('/api/auth/register', body('user1', { inviteCode: 'x@evil.test' }))).status, 403);
  assert.equal((await post('/api/auth/register', body('user1', { inviteCode: 'srvcode1' }))).status, 201);
  const dead = invites.createInvite({ serverId: sid, userId: owner, maxUses: 1 });
  db.prepare('UPDATE server_invites SET uses = 1 WHERE id = ?').run(dead.id);
  assert.equal((await post('/api/auth/register', body('user2', { inviteCode: dead.code }))).status, 403);
});

test('open allows registration again', async () => {
  appConfig.save({ registrationMode: 'open' });
  const r3 = await post('/api/auth/register', body('user3')); assert.equal(r3.status, 201, JSON.stringify(r3.json));
});

test('a single-use invite registers exactly one account and joins it to the server', async () => {
  appConfig.save({ registrationMode: 'invite' });
  const owner = db.prepare("SELECT id FROM users WHERE username = 'first'").get().id;
  const sid = db.prepare("SELECT id FROM servers WHERE invite_code = 'srvcode1'").get().id;
  const inv = invites.createInvite({ serverId: sid, userId: owner, maxUses: 1 });
  const ok = await post('/api/auth/register', body('solo1', { inviteCode: inv.code }));
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  const uid = db.prepare("SELECT id FROM users WHERE username = 'solo1'").get().id;
  assert.ok(db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(sid, uid), 'joined by the invite');
  assert.equal(db.prepare('SELECT uses FROM server_invites WHERE id = ?').get(inv.id).uses, 1);
  assert.equal((await post('/api/auth/register', body('solo2', { inviteCode: inv.code }))).status, 403);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM users WHERE username = 'solo2'").get().c, 0);
});

test('an N-use invite counts each registration and a taken username burns no use', async () => {
  appConfig.save({ registrationMode: 'invite' });
  const owner = db.prepare("SELECT id FROM users WHERE username = 'first'").get().id;
  const sid = db.prepare("SELECT id FROM servers WHERE invite_code = 'srvcode1'").get().id;
  const inv = invites.createInvite({ serverId: sid, userId: owner, maxUses: 2 });
  assert.equal((await post('/api/auth/register', body('first', { inviteCode: inv.code }))).status, 409);
  assert.equal(db.prepare('SELECT uses FROM server_invites WHERE id = ?').get(inv.id).uses, 0);
  assert.equal((await post('/api/auth/register', body('multi1', { inviteCode: inv.code }))).status, 201);
  assert.equal((await post('/api/auth/register', body('multi2', { inviteCode: inv.code }))).status, 201);
  assert.equal((await post('/api/auth/register', body('multi3', { inviteCode: inv.code }))).status, 403);
  assert.equal(db.prepare('SELECT uses FROM server_invites WHERE id = ?').get(inv.id).uses, 2);
});

test('a channel invite registers one account, joins and grants the channel', async () => {
  appConfig.save({ registrationMode: 'invite' });
  const owner = db.prepare("SELECT id FROM users WHERE username = 'first'").get().id;
  const sid = db.prepare("SELECT id FROM servers WHERE invite_code = 'srvcode1'").get().id;
  const cid = Number(db.prepare("INSERT INTO channels (server_id, name, type) VALUES (?, 'priv', 'text')").run(sid).lastInsertRowid);
  db.prepare("INSERT INTO channel_invites (channel_id, code, created_by, max_uses) VALUES (?, 'chinvite1', ?, 1)").run(cid, owner);
  const ok = await post('/api/auth/register', body('chuser', { inviteCode: 'chinvite1' }));
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  const uid = db.prepare("SELECT id FROM users WHERE username = 'chuser'").get().id;
  assert.ok(db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(sid, uid));
  assert.ok(db.prepare('SELECT 1 FROM channel_user_overrides WHERE channel_id = ? AND user_id = ?').get(cid, uid));
  assert.equal((await post('/api/auth/register', body('chuser2', { inviteCode: 'chinvite1' }))).status, 403);
});
