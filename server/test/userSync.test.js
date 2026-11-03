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
const accounts = require('../lib/accounts');
const hub = require('../socket/hub');

const app = express();
app.use(express.json());
app.use(attachUser);
app.use('/api/auth', require('../routes/auth'));
app.use('/api/users', require('../routes/users'));
app.use('/api/friends', require('../routes/friends'));
app.use('/api/notification-prefs', require('../routes/notificationPrefs'));
app.use('/api', require('../routes/personal'));
app.use(require('../middleware/errorHandler').errorHandler);
let server; let base;
const cookies = {}; const ids = {}; const inbox = {};

async function call(method, url, body, who) {
  const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', cookie: cookies[who] || '' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
const syncs = (who) => inbox[who].filter((m) => m.type === 'user_sync').map((m) => m.what);

test.before(async () => {
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  for (const name of ['us_a', 'us_b']) {
    ids[name] = accounts.createAccount({ username: name, email: `${name}@t.co`, password: 'password123' }).userId;
    cookies[name] = (await call('POST', '/api/auth/login', { username: name, password: 'password123' })).cookie;
    inbox[name] = [];
    hub.registerConnection(ids[name], { readyState: 1, OPEN: 1, send: (raw) => inbox[name].push(JSON.parse(raw)) });
  }
});
test.after(() => { server.close(); db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

test('saving a setting tells the caller\'s own devices which one changed', async () => {
  await call('PUT', '/api/users/me/theme', { theme: { brand: '#112233' } }, 'us_a');
  await call('PUT', '/api/users/me/ui-prefs', { sidebarWidth: 300 }, 'us_a');
  await call('PUT', `/api/user-annotations/${ids.us_b}`, { nickname: 'x' }, 'us_a');
  await call('PUT', '/api/notification-prefs/dm/1', { pref: 'mute' }, 'us_a');
  const got = syncs('us_a');
  for (const w of ['theme', 'ui_prefs', 'annotations']) assert.ok(got.includes(w), `${w} in ${got}`);
  assert.equal(syncs('us_b').length, 0);
});

test('failed writes do not sync', async () => {
  const n = syncs('us_a').length;
  const r = await call('PUT', '/api/users/me/language', { code: '!!' }, 'us_a');
  assert.equal(r.status, 400);
  assert.equal(syncs('us_a').length, n);
});

test('manual device sync sends "all" to the caller only', async () => {
  await call('POST', '/api/users/me/sync-devices', null, 'us_b');
  assert.deepEqual(syncs('us_b').slice(-1), ['all']);
  assert.ok(!syncs('us_a').includes('all'));
});

test('friend request, cancel and unfriend sync both sides; block and unblock sync only the blocker', async () => {
  const reset = () => { inbox.us_a.length = 0; inbox.us_b.length = 0; };
  reset();
  await call('POST', '/api/friends/request', { username: 'us_b' }, 'us_a');
  assert.ok(syncs('us_a').includes('friends'));
  reset();
  await call('DELETE', `/api/friends/${ids.us_b}`, null, 'us_a');
  assert.ok(syncs('us_a').includes('friends') && syncs('us_b').includes('friends'));
  await call('POST', '/api/friends/request', { username: 'us_b' }, 'us_a');
  await call('POST', `/api/friends/${ids.us_a}/accept`, null, 'us_b');
  reset();
  await call('POST', `/api/friends/${ids.us_a}/block`, null, 'us_b');
  assert.ok(syncs('us_b').includes('friends'));
  assert.equal(syncs('us_a').length, 0);
  reset();
  await call('DELETE', `/api/friends/${ids.us_a}`, null, 'us_b');
  assert.ok(syncs('us_b').includes('friends'));
  assert.equal(syncs('us_a').length, 0);
});
