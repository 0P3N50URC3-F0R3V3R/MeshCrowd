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
process.env.DISMESH_FEDERATION_ALLOW_LOOPBACK = '1';

const { db } = require('../db');
const appConfig = require('../lib/config');
const advert = require('../lib/swarmAdvert');
const { SITE_PERMISSIONS } = require('../lib/permissions');

const VIEW = SITE_PERMISSIONS.VIEW_ADMIN_PANEL;
const ADMIN = VIEW | SITE_PERMISSIONS.SITE_ADMINISTRATOR;
let app; let base; let tracker; let trackerUrl; let uid;
const announces = [];
let listBody = [];

test.before(async () => {
  uid = Number(db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)').run('sw_admin', 'sw@t.local', 'h', 'sw').lastInsertRowid);
  tracker = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.method === 'GET') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ servers: listBody })); }
      announces.push({ method: req.method, body });
      res.statusCode = 204; res.end();
    });
  });
  await new Promise((r) => tracker.listen(0, '127.0.0.1', r));
  trackerUrl = `http://127.0.0.1:${tracker.address().port}`;
  const a = express();
  a.use(express.json());
  a.use((req, res, next) => {
    const id = Number(req.headers['x-uid']);
    if (id) { req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(id); req.sitePermissions = Number(req.headers['x-perms'] || 0); }
    next();
  });
  a.use('/api/swarm', require('../routes/swarm'));
  a.use('/api/admin', require('../routes/admin'));
  await new Promise((r) => { app = http.createServer(a).listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${app.address().port}`;
});
test.after(async () => {
  app.close(); tracker.close(); db.close();
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const admin = (method, url, json, perms = ADMIN) => fetch(base + url, {
  method, headers: { 'x-uid': String(uid), 'x-perms': String(perms), ...(json ? { 'content-type': 'application/json' } : {}) }, body: json ? JSON.stringify(json) : undefined,
}).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));

test('list is empty and disabled by default', async () => {
  const r = await fetch(`${base}/api/swarm/list`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { enabled: false, servers: [] });
});

test('swarm settings need a site administrator and validate trackers', async () => {
  assert.equal((await admin('GET', '/api/admin/swarm', null, VIEW)).status, 403);
  assert.equal((await admin('PATCH', '/api/admin/swarm', { trackers: ['http://x.example.com'] })).status, 400);
  assert.equal((await admin('PATCH', '/api/admin/swarm', { trackers: Array.from({ length: 21 }, (_, i) => `https://t${i}.example.com`) })).status, 400);
  assert.equal((await admin('PATCH', '/api/admin/swarm', { advertise: 'yes' })).status, 400);
  assert.equal((await admin('PATCH', '/api/admin/swarm', { intervalSeconds: 5 })).status, 400);
  const ok = await admin('PATCH', '/api/admin/swarm', { advertise: false, trackers: ['https://A.example.com/', 'https://a.example.com'], intervalSeconds: 120 });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.data.trackers, ['https://a.example.com']);
  assert.equal(ok.data.intervalSeconds, 120);
});

test('enabling advertising announces to the tracker and the public list shows its servers', async () => {
  const theirs = advert.build({ url: 'https://friend.example.com', name: 'Friend', description: 'hi', icon: null, registration: 'open', updated: 5 });
  listBody = [{ advert: theirs, lastSeen: 1234 }];
  appConfig.save({ swarm: { advertise: true, trackers: [trackerUrl], intervalSeconds: 300 } });
  assert.equal((await admin('POST', '/api/admin/swarm/announce')).status, 200);
  assert.ok(announces.some((a) => a.method === 'POST' && advert.verify(a.body).ok));
  const list = await (await fetch(`${base}/api/swarm/list`)).json();
  assert.equal(list.enabled, true);
  assert.equal(list.servers[0].name, 'Friend');
  const status = (await admin('GET', '/api/admin/swarm')).data;
  assert.equal(status.advertise, true);
  assert.equal(status.status[0].ok, true);
});

test('an unreachable tracker never breaks the list route', async () => {
  appConfig.save({ swarm: { advertise: true, trackers: ['http://127.0.0.1:1'] } });
  await admin('POST', '/api/admin/swarm/announce');
  const r = await fetch(`${base}/api/swarm/list`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).enabled, true);
});
