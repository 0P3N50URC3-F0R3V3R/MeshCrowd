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

const app = express();
app.use(express.json());
app.use(attachUser);
app.use('/api/auth', require('../routes/auth'));
app.use('/api/users', require('../routes/users'));
let server; let base;
test.before(async () => { await new Promise((r) => { server = app.listen(0, r); }); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server.close(); db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

async function call(method, url, body, cookie) {
  const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}

test('avatarBackground defaults off, persists, validates and is in the public shape', async () => {
  const reg = await call('POST', '/api/auth/register', { username: 'ab_one', email: 'ab1@t.co', password: 'password123' });
  const me = await call('GET', '/api/auth/me', null, reg.cookie);
  assert.equal(me.body.user.avatarBackground, false);
  const on = await call('PATCH', '/api/users/me', { avatarBackground: true }, reg.cookie);
  assert.equal(on.status, 200);
  assert.equal(on.body.user.avatarBackground, true);
  assert.equal(db.prepare('SELECT avatar_bg FROM users WHERE username = ?').get('ab_one').avatar_bg, 1);
  assert.equal((await call('GET', '/api/auth/me', null, reg.cookie)).body.user.avatarBackground, true);
  const off = await call('PATCH', '/api/users/me', { avatarBackground: false }, reg.cookie);
  assert.equal(off.body.user.avatarBackground, false);
});

test('avatarBackground rejects non-boolean values', async () => {
  const reg = await call('POST', '/api/auth/register', { username: 'ab_two', email: 'ab2@t.co', password: 'password123' });
  for (const v of ['yes', 1, 'true', null, {}]) {
    assert.equal((await call('PATCH', '/api/users/me', { avatarBackground: v }, reg.cookie)).status, 400);
  }
  assert.equal(db.prepare('SELECT avatar_bg FROM users WHERE username = ?').get('ab_two').avatar_bg, 0);
});

test('avatarBgColor validates hex, persists and clears', async () => {
  const reg = await call('POST', '/api/auth/register', { username: 'ab_three', email: 'ab3@t.co', password: 'password123' });
  assert.equal((await call('GET', '/api/auth/me', null, reg.cookie)).body.user.avatarBgColor, '');
  const ok = await call('PATCH', '/api/users/me', { avatarBgColor: '#aabbcc' }, reg.cookie);
  assert.equal(ok.body.user.avatarBgColor, '#aabbcc');
  assert.equal((await call('PATCH', '/api/users/me', { avatarBgColor: 'red' }, reg.cookie)).status, 400);
  assert.equal((await call('PATCH', '/api/users/me', { avatarBgColor: '' }, reg.cookie)).body.user.avatarBgColor, '');
});
