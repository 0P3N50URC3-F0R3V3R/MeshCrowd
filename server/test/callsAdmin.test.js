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
const { OWNER_SITE_PERMISSIONS, SITE_PERMISSIONS } = require('../lib/permissions');
const turnManager = require('../lib/turn/manager');
const appConfig = require('../lib/config');

const mkUser = (n) => Number(db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)').run(n, `${n}@t.local`, 'h', n).lastInsertRowid);

let server; let base; let admin; let staff;
test.before(async () => {
  admin = mkUser('calls_admin');
  staff = mkUser('calls_staff');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const uid = Number(req.headers['x-uid']);
    if (uid) {
      req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
      req.sitePermissions = uid === admin ? OWNER_SITE_PERMISSIONS : SITE_PERMISSIONS.VIEW_ADMIN_PANEL;
    }
    next();
  });
  app.use('/api/admin', require('../routes/admin'));
  app.get('/api/voice/ice', require('../middleware/auth').requireAuth, (req, res) => res.json(turnManager.iceServersFor(req.user, req.hostname)));
  await new Promise((r) => { server = http.createServer(app).listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await turnManager.stop();
  server.close();
  db.close();
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const call = async (method, url, uid, json) => {
  const res = await fetch(base + url, {
    method, headers: { 'x-uid': String(uid), ...(json ? { 'content-type': 'application/json' } : {}) }, body: json ? JSON.stringify(json) : undefined,
  });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, data };
};

test('call settings are for site administrators only and never expose the secret', async () => {
  assert.equal((await call('GET', '/api/admin/calls', staff)).status, 403);
  assert.equal((await call('PATCH', '/api/admin/calls', staff, { turn: { enabled: true } })).status, 403);
  const res = await call('GET', '/api/admin/calls', admin);
  assert.equal(res.status, 200);
  assert.equal(res.data.turn.enabled, false);
  assert.equal(res.data.turn.secretSet, true);
  assert.equal(res.data.turn.secret, undefined);
  assert.equal(res.data.status.running, false);
});

test('the built-in server is off by default and hands out no credentials', () => {
  const ice = turnManager.iceServersFor({ id: 1 }, 'chat.example.com');
  assert.deepEqual(ice.iceServers, []);
  assert.equal(ice.builtIn, false);
});

test('invalid settings are rejected', async () => {
  const bad = [
    { turn: { port: 0 } }, { turn: { port: 70000 } }, { turn: { enabled: 'yes' } }, { turn: { externalIp: 'not an ip' } },
    { turn: { relayPortMin: 50000, relayPortMax: 50003 } }, { turn: { realm: 'bad realm!' } }, { turn: { maxKbps: -1 } },
    { turn: { advertisedHost: 'host/with/slash' } }, { iceServers: [{ urls: 'http://nope' }] }, { iceServers: 'x' },
    { iceServers: new Array(11).fill({ urls: 'stun:a.example.com:3478' }) },
  ];
  for (const body of bad) assert.equal((await call('PATCH', '/api/admin/calls', admin, body)).status, 400, JSON.stringify(body));
});

test('enabling starts the relay live, signed-in users get time-limited credentials, disabling stops it', async () => {
  const on = await call('PATCH', '/api/admin/calls', admin, {
    turn: { enabled: true, port: 23478, listenAddress: '127.0.0.1', externalIp: '203.0.113.9', relayPortMin: 55000, relayPortMax: 55050 },
  });
  assert.equal(on.status, 200);
  assert.equal(on.data.status.running, true);
  assert.equal(on.data.status.port, 23478);

  const ice = await call('GET', '/api/voice/ice', staff);
  assert.equal(ice.data.builtIn, true);
  const turn = ice.data.iceServers.find((s) => s.username);
  assert.ok(turn.urls.every((u) => u.startsWith('turn:203.0.113.9:23478')));
  assert.ok(Number(turn.username.split(':')[0]) * 1000 > Date.now());
  assert.ok(ice.data.iceServers.some((s) => s.urls[0] === 'stun:203.0.113.9:23478'));

  const test1 = await call('POST', '/api/admin/calls/test', admin);
  assert.equal(test1.data.checks.find((c) => c.name === 'allocate').ok, true);

  const secretBefore = appConfig.load().turn.secret;
  await call('PATCH', '/api/admin/calls', admin, { turn: { rotateSecret: true } });
  assert.notEqual(appConfig.load().turn.secret, secretBefore);

  const off = await call('PATCH', '/api/admin/calls', admin, { turn: { enabled: false } });
  assert.equal(off.data.status.running, false);
});

test('external ICE servers are stored, served to signed-in users and credential-free ones to everyone', async () => {
  const put = await call('PATCH', '/api/admin/calls', admin, {
    iceServers: [{ urls: 'stun:stun.example.com:3478' }, { urls: ['turn:turn.example.com:3478'], username: 'u', credential: 'p' }],
  });
  assert.equal(put.status, 200);
  assert.equal(put.data.iceServers.length, 2);
  const ice = await call('GET', '/api/voice/ice', staff);
  assert.equal(ice.data.iceServers.length, 2);
  assert.deepEqual(turnManager.publicIceServers(), [{ urls: 'stun:stun.example.com:3478' }]);
});

test('a port that is already taken is reported, not thrown', async () => {
  const dgram = require('node:dgram');
  const blocker = dgram.createSocket('udp4');
  await new Promise((r) => blocker.bind(23999, '127.0.0.1', r));
  const res = await call('PATCH', '/api/admin/calls', admin, { turn: { enabled: true, port: 23999, listenAddress: '127.0.0.1' } });
  assert.equal(res.status, 200);
  assert.equal(res.data.status.running, false);
  assert.match(res.data.status.error, /already in use/);
  blocker.close();
  await call('PATCH', '/api/admin/calls', admin, { turn: { enabled: false } });
});
