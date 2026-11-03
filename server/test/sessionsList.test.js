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
const { attachUser } = require('../middleware/auth');
const challenges = require('../lib/passportChallenges');

const app = express();
app.use(express.json());
app.use(attachUser);
app.use('/api/auth', require('../routes/auth'));
let server; let base;
test.before(async () => { await new Promise((r) => { server = app.listen(0, r); }); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server.close(); db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });
test.beforeEach(() => challenges._resetForTests());

async function call(method, url, body, cookie, ua) {
  const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(ua ? { 'user-agent': ua } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}

async function twoDevices(name) {
  const a = await call('POST', '/api/auth/register', { username: name, email: `${name}@t.co`, password: 'password123' }, null, 'Firefox/130 Windows');
  const b = await call('POST', '/api/auth/login', { username: name, password: 'password123' }, null, 'Chrome/130 Android');
  return { a: a.cookie, b: b.cookie };
}

test('lists own sessions without leaking tokens and flags the current one', async () => {
  const { a, b } = await twoDevices('sl_one');
  const r = await call('GET', '/api/auth/sessions', null, a);
  assert.equal(r.status, 200);
  assert.equal(r.body.sessions.length, 2);
  assert.equal(r.body.sessions.filter((s) => s.current).length, 1);
  assert.ok(r.body.sessions.some((s) => s.userAgent.includes('Android')));
  assert.ok(!JSON.stringify(r.body).includes(a.split('=')[1]));
  assert.ok(!JSON.stringify(r.body).includes(b.split('=')[1]));
});

test('revoking another session logs that device out but not this one', async () => {
  const { a, b } = await twoDevices('sl_two');
  const list = (await call('GET', '/api/auth/sessions', null, a)).body.sessions;
  const other = list.find((s) => !s.current);
  assert.equal((await call('DELETE', `/api/auth/sessions/${other.id}`, null, a)).status, 200);
  assert.equal((await call('GET', '/api/auth/me', null, b)).status, 401);
  assert.equal((await call('GET', '/api/auth/me', null, a)).status, 200);
});

test('cannot revoke the current session through the list endpoint, or another user\'s session', async () => {
  const { a } = await twoDevices('sl_three');
  const cur = (await call('GET', '/api/auth/sessions', null, a)).body.sessions.find((s) => s.current);
  assert.equal((await call('DELETE', `/api/auth/sessions/${cur.id}`, null, a)).status, 400);
  const other = await call('POST', '/api/auth/register', { username: 'sl_four', email: 'sl4@t.co', password: 'password123' });
  assert.equal((await call('DELETE', `/api/auth/sessions/${cur.id}`, null, other.cookie)).status, 404);
});

test('revoke-all-others keeps only the current session', async () => {
  const { a, b } = await twoDevices('sl_five');
  const r = await call('DELETE', '/api/auth/sessions/others', null, a);
  assert.equal(r.body.revoked, 1);
  assert.equal((await call('GET', '/api/auth/me', null, b)).status, 401);
  assert.equal((await call('GET', '/api/auth/sessions', null, a)).body.sessions.length, 1);
});
