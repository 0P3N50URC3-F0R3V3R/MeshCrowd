'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const express = require('express');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const { db } = require('../db');
const logger = require('../lib/logger');
const { attachUser } = require('../middleware/auth');
const { SITE_PERMISSIONS } = require('../lib/permissions');
const guard = require('../lib/security/guard');

logger.setConsoleOutput(false);
logger.setLevel('debug');
const entries = [];
logger.subscribe((e) => entries.push(e));
const since = (n) => entries.slice(n);

const PASSWORDS = ['password123', 'wrong-pass-77', 'reset-pass-88', 'changed-pass-99'];

const app = express();
app.use(express.json());
app.use(attachUser);
app.use((req, res, next) => {
  const uid = Number(req.headers['x-uid']);
  if (uid) { req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid); req.sitePermissions = SITE_PERMISSIONS.SITE_ADMINISTRATOR | SITE_PERMISSIONS.VIEW_ADMIN_PANEL; }
  next();
});
app.use('/api/auth', require('../routes/auth'));
app.use('/api/admin', require('../routes/admin'));
let server; let base;
test.before(async () => { await new Promise((r) => { server = app.listen(0, r); }); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server.close(); db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

async function call(method, url, body, headers = {}) {
  const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}

test('a failed login emits exactly one warn in auth with the username and no password', async () => {
  await call('POST', '/api/auth/register', { username: 'log_alice', email: 'la@t.co', password: 'password123' });
  const n = entries.length;
  const r = await call('POST', '/api/auth/login', { username: 'log_alice', password: 'wrong-pass-77' });
  assert.equal(r.status, 401);
  const got = since(n);
  assert.equal(got.length, 1);
  assert.equal(got[0].level, 'warn');
  assert.equal(got[0].category, 'auth');
  assert.match(got[0].message, /log_alice/);
  assert.match(got[0].message, /127\.0\.0\.1|::1/);
  assert.ok(!got[0].message.includes('wrong-pass-77'));
});

test('a login with control characters in the username cannot forge log lines', async () => {
  const n = entries.length;
  await call('POST', '/api/auth/login', { username: 'x\n[INFO] [auth] forged', password: 'wrong-pass-77' });
  const got = since(n);
  assert.equal(got.length, 1);
  assert.ok(!got[0].message.includes('\n'));
});

test('a successful login emits one info in auth', async () => {
  const n = entries.length;
  const r = await call('POST', '/api/auth/login', { username: 'log_alice', password: 'password123' });
  assert.equal(r.status, 200);
  const got = since(n);
  assert.equal(got.length, 1);
  assert.equal(got[0].level, 'info');
  assert.equal(got[0].category, 'auth');
  assert.match(got[0].message, /log_alice/);
});

test('registration and password change are logged without credentials', async () => {
  const n = entries.length;
  const reg = await call('POST', '/api/auth/register', { username: 'log_bob', email: 'lb@t.co', password: 'password123' });
  assert.equal(reg.status, 201);
  const r = await call('POST', '/api/auth/change-password', { currentPassword: 'password123', newPassword: 'changed-pass-99' }, { cookie: reg.cookie });
  assert.equal(r.status, 200);
  const got = since(n).filter((e) => e.category === 'auth');
  assert.ok(got.some((e) => e.level === 'info' && /regist/i.test(e.message) && /log_bob/.test(e.message)));
  assert.ok(got.some((e) => e.level === 'info' && /password/i.test(e.message) && /log_bob/.test(e.message)));
});

test('admin disabling a user and resetting a password emit admin entries naming actor and target', async () => {
  const actor = db.prepare('SELECT id FROM users WHERE username = ?').get('log_alice').id;
  const target = db.prepare('SELECT id FROM users WHERE username = ?').get('log_bob').id;
  const n = entries.length;
  const r = await call('PATCH', `/api/admin/users/${target}`, { isDisabled: true }, { 'x-uid': String(actor) });
  assert.equal(r.status, 200);
  const got = since(n).filter((e) => e.category === 'admin');
  assert.equal(got.length, 1);
  assert.match(got[0].message, /log_alice/);
  assert.match(got[0].message, /log_bob/);
  assert.match(got[0].message, /disabl/i);

  const m = entries.length;
  await call('PATCH', `/api/admin/users/${target}`, { password: 'reset-pass-88' }, { 'x-uid': String(actor) });
  const reset = since(m).filter((e) => e.category === 'admin');
  assert.equal(reset.length, 1);
  assert.match(reset[0].message, /reset/i);
});

test('site role create, edit and delete are logged', async () => {
  const actor = db.prepare('SELECT id FROM users WHERE username = ?').get('log_alice').id;
  const h = { 'x-uid': String(actor) };
  const n = entries.length;
  const created = await call('POST', '/api/admin/site-roles', { name: 'Janitor' }, h);
  await call('PATCH', `/api/admin/site-roles/${created.body.role.id}`, { color: '#112233' }, h);
  await call('DELETE', `/api/admin/site-roles/${created.body.role.id}`, null, h);
  const got = since(n).filter((e) => e.category === 'admin');
  assert.equal(got.length, 3);
  for (const e of got) assert.match(e.message, /log_alice/);
});

test('guard logs ban added and removed in security', () => {
  const n = entries.length;
  const ban = guard.addBan('203.0.113.9', { reason: 'test', source: 'manual' });
  guard.removeBan(ban.id);
  const got = since(n).filter((e) => e.category === 'security');
  assert.ok(got.some((e) => /203\.0\.113\.9/.test(e.message) && /ban/i.test(e.message)));
  assert.equal(got.filter((e) => /remov|lift/i.test(e.message)).length, 1);
});

test('no emitted entry contains any password used in this file', () => {
  for (const e of entries) for (const p of PASSWORDS) assert.ok(!e.message.includes(p), `leaked ${p}: ${e.message}`);
});
