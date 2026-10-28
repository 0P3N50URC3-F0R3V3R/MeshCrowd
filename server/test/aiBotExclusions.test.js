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
const { OWNER_SITE_PERMISSIONS } = require('../lib/permissions');
const { toPublicUser } = require('../lib/publicUser');
const splitAuth = require('../lib/splitAuth');
const { createAccount } = require('../lib/accounts');
const { isSiteAdmin } = require('../lib/siteAuth');

const mkUser = (n, isBot = 0) => Number(db.prepare(
  'INSERT INTO users (username, email, password_hash, display_name, is_bot) VALUES (?, ?, ?, ?, ?)'
).run(n, `${n}@t.local`, 'h', n, isBot).lastInsertRowid);

let server; let base;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const uid = Number(req.headers['x-uid']);
    if (uid) { req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid); req.sitePermissions = OWNER_SITE_PERMISSIONS; }
    next();
  });
  app.use('/api/admin', require('../routes/admin'));
  app.use('/api/friends', require('../routes/friends'));
  await new Promise((r) => { server = http.createServer(app).listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.close();
  db.close();
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const call = async (method, url, uid, json) => {
  const res = await fetch(base + url, {
    method,
    headers: { 'x-uid': String(uid), ...(json ? { 'content-type': 'application/json' } : {}) },
    body: json ? JSON.stringify(json) : undefined,
  });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, data };
};

test('toPublicUser exposes isBot', () => {
  const botRow = db.prepare('SELECT * FROM users WHERE id = ?').get(mkUser('helper_bot', 1));
  const humanRow = db.prepare('SELECT * FROM users WHERE id = ?').get(mkUser('human1'));
  assert.equal(toPublicUser(botRow, {}).isBot, true);
  assert.equal(toPublicUser(humanRow, {}).isBot, false);
});

test('a bot user can never be found as a login', () => {
  assert.equal(splitAuth.findLoginUser('helper_bot'), null);
  assert.equal(splitAuth.findLoginUser('helper_bot@t.local'), null);
  assert.ok(splitAuth.findLoginUser('human1'));
});

test('a bot row does not stop the first real registrant becoming site owner', () => {
  db.prepare("DELETE FROM users WHERE username = 'human1'").run();
  const { userId } = createAccount({ username: 'firstreal', email: 'firstreal@t.local', password: 'testpassword123' });
  assert.equal(isSiteAdmin(userId), true);
  mkUser('human1');
});

test('admin stats and user list exclude bots', async () => {
  const admin = db.prepare("SELECT id FROM users WHERE username = 'firstreal'").get().id;
  const stats = await call('GET', '/api/admin/stats', admin);
  assert.equal(stats.status, 200);
  const realCount = db.prepare("SELECT COUNT(*) AS c FROM users WHERE username != '__webhook__' AND is_bot = 0").get().c;
  assert.equal(stats.data.users, realCount);
  const list = await call('GET', '/api/admin/users', admin);
  assert.ok(!list.data.users.some((u) => u.username === 'helper_bot'));
  assert.ok(list.data.users.some((u) => u.username === 'human1'));
});

test('friend requests to a bot answer 404', async () => {
  const human = db.prepare("SELECT id FROM users WHERE username = 'human1'").get().id;
  const r = await call('POST', '/api/friends/request', human, { username: 'helper_bot' });
  assert.equal(r.status, 404);
});

test('federation lookups by username never return a bot', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'federationApi.js'), 'utf8');
  const lookups = src.match(/SELECT \* FROM users WHERE username = \? COLLATE NOCASE[^'`]*/g) || [];
  assert.equal(lookups.length, 4);
  for (const l of lookups) assert.match(l, /is_bot = 0/);
});
