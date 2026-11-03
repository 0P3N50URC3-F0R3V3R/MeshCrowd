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
app.use('/api/servers', require('../routes/servers'));
let server; let base;
test.before(async () => { await new Promise((r) => { server = app.listen(0, r); }); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server.close(); db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

async function call(method, url, body, cookie) {
  const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}

test('server icon background defaults to on with no color, and can be toggled and colored', async () => {
  const reg = await call('POST', '/api/auth/register', { username: 'ib_one', email: 'ib1@t.co', password: 'password123' });
  const created = await call('POST', '/api/servers', { name: 'Iconic' }, reg.cookie);
  const id = created.body.server.id;
  const row = () => db.prepare('SELECT icon_bg, icon_bg_color FROM servers WHERE id = ?').get(id);
  assert.deepEqual({ ...row() }, { icon_bg: 1, icon_bg_color: '' });

  const r = await call('PATCH', `/api/servers/${id}`, { iconBackground: false, iconBgColor: '#aabbcc' }, reg.cookie);
  assert.equal(r.status, 200);
  assert.equal(r.body.server.icon_bg, 0);
  assert.equal(r.body.server.icon_bg_color, '#aabbcc');

  assert.equal((await call('PATCH', `/api/servers/${id}`, { iconBackground: true, iconBgColor: '' }, reg.cookie)).status, 200);
  assert.deepEqual({ ...row() }, { icon_bg: 1, icon_bg_color: '' });
});

test('rejects a malformed icon color and leaves the stored one alone', async () => {
  const reg = await call('POST', '/api/auth/register', { username: 'ib_two', email: 'ib2@t.co', password: 'password123' });
  const id = (await call('POST', '/api/servers', { name: 'Bad' }, reg.cookie)).body.server.id;
  assert.equal((await call('PATCH', `/api/servers/${id}`, { iconBgColor: 'red; x' }, reg.cookie)).status, 400);
  assert.equal(db.prepare('SELECT icon_bg_color FROM servers WHERE id = ?').get(id).icon_bg_color, '');
});
