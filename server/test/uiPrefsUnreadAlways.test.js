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

test('unreadAlways is stored per user and rejects other values', async () => {
  const reg = await call('POST', '/api/auth/register', { username: 'ua_one', email: 'ua1@t.co', password: 'password123' });
  assert.equal((await call('GET', '/api/users/me/ui-prefs', null, reg.cookie)).body.uiPrefs.unreadAlways, undefined);
  assert.equal((await call('PUT', '/api/users/me/ui-prefs', { unreadAlways: 'on' }, reg.cookie)).body.uiPrefs.unreadAlways, 'on');
  assert.equal((await call('GET', '/api/users/me/ui-prefs', null, reg.cookie)).body.uiPrefs.unreadAlways, 'on');
  const bad = await call('PUT', '/api/users/me/ui-prefs', { unreadAlways: 'maybe' }, reg.cookie);
  assert.equal(bad.body.uiPrefs.unreadAlways, undefined);
});
