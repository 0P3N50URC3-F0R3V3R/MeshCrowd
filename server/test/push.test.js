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
const push = require('../lib/pushEndpoints');
const { recordOutbox } = require('../lib/notifications');

let n = 0;
const mkUser = (name) => Number(db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)').run(`${name}${++n}`, `${name}${n}@t.local`, 'h', name).lastInsertRowid);

let receiver; let hits; let answer; let api; let apiBase;
test.before(async () => {
  receiver = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { hits.push({ url: req.url, body: Buffer.concat(chunks).toString('utf8') }); res.writeHead(answer(hits.length)).end('ok'); });
  });
  await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { const uid = Number(req.headers['x-uid']); if (uid) req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid); next(); });
  app.use('/api/push', require('../routes/push'));
  await new Promise((r) => { api = http.createServer(app).listen(0, '127.0.0.1', r); });
  apiBase = `http://127.0.0.1:${api.address().port}`;
  push.settings.coalesceMs = 30;
});
test.beforeEach(() => { hits = []; answer = () => 200; push.settings.allowPrivate = true; push._reset(); });
test.after(async () => { receiver.close(); api.close(); db.close(); await new Promise((r) => setTimeout(r, 200)); fs.rmSync(tmpDir, { recursive: true, force: true }); });

const url = (p = '/topic') => `http://127.0.0.1:${receiver.address().port}${p}`;
const waitFor = async (cond, ms = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await new Promise((r) => setTimeout(r, 10)); } return cond(); };
const notify = (uid) => recordOutbox(uid, { scopeType: 'dm', scopeId: 1, message: { id: 1, content: 'hi' }, mentioned: true });
const call = async (method, p, uid, json) => {
  const res = await fetch(apiBase + p, { method, headers: { 'x-uid': String(uid), 'content-type': 'application/json' }, body: json === undefined ? undefined : JSON.stringify(json) });
  return { status: res.status, data: await res.json().catch(() => null) };
};

test('registering validates the URL, upserts, and limits the number per account', async () => {
  const u = mkUser('reg');
  assert.equal((await call('PUT', '/api/push/endpoint', u, { endpoint: 'ftp://x/y' })).status, 400);
  assert.equal((await call('PUT', '/api/push/endpoint', u, { endpoint: 'https://user:pw@ntfy.example/t' })).status, 400);
  assert.equal((await call('PUT', '/api/push/endpoint', u, { endpoint: 'not a url' })).status, 400);
  const ok = await call('PUT', '/api/push/endpoint', u, { endpoint: 'https://ntfy.example/upabc', label: 'Pixel' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.endpoint.label, 'Pixel');
  await call('PUT', '/api/push/endpoint', u, { endpoint: 'https://ntfy.example/upabc', label: 'Pixel 2' });
  assert.equal((await call('GET', '/api/push', u)).data.endpoints.length, 1, 'same endpoint is not duplicated');
  for (let i = 1; i < push.MAX_PER_USER; i++) assert.equal((await call('PUT', '/api/push/endpoint', u, { endpoint: `https://ntfy.example/up${i}` })).status, 200);
  assert.equal((await call('PUT', '/api/push/endpoint', u, { endpoint: 'https://ntfy.example/too-many' })).status, 409);
  assert.equal((await call('DELETE', '/api/push/endpoint', u, { endpoint: 'https://ntfy.example/upabc' })).data.removed, true);
});

test('people only see and remove their own endpoints', async () => {
  const a = mkUser('own'); const b = mkUser('other');
  await call('PUT', '/api/push/endpoint', a, { endpoint: 'https://ntfy.example/mine' });
  assert.equal((await call('GET', '/api/push', b)).data.endpoints.length, 0);
  assert.equal((await call('DELETE', '/api/push/endpoint', b, { endpoint: 'https://ntfy.example/mine' })).data.removed, false);
  assert.equal((await call('GET', '/api/push', a)).data.endpoints.length, 1);
});

test('a new notification wakes the endpoint with a body that carries no message content', async () => {
  const u = mkUser('wake');
  push.register(u, url('/topic-a'), 'phone');
  notify(u);
  assert.ok(await waitFor(() => hits.length === 1));
  assert.equal(hits[0].url, '/topic-a');
  assert.equal(hits[0].body, '{"t":"wake"}');
  assert.ok(!hits[0].body.includes('hi'));
});

test('a burst of notifications becomes one wake-up', async () => {
  const u = mkUser('burst');
  push.register(u, url('/burst'));
  for (let i = 0; i < 10; i++) notify(u);
  assert.ok(await waitFor(() => hits.length >= 1));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(hits.length, 1);
});

test('users without endpoints cause no requests, and endpoints are per user', async () => {
  const a = mkUser('none'); const b = mkUser('has');
  push.register(b, url('/b-only'));
  notify(a);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(hits.length, 0);
  notify(b);
  assert.ok(await waitFor(() => hits.length === 1));
});

test('a gone endpoint (404/410) is forgotten, repeated failures eventually remove it', async () => {
  const u = mkUser('gone');
  push.register(u, url('/gone'));
  answer = () => 410;
  notify(u);
  assert.ok(await waitFor(() => push.list(u).length === 0));

  push.register(u, url('/flaky'));
  answer = () => 500;
  for (let i = 0; i < push.MAX_FAILURES; i++) {
    const row = db.prepare('SELECT * FROM push_endpoints WHERE user_id = ?').get(u);
    if (!row) break;
    await push.send(row);
  }
  assert.equal(push.list(u).length, 0);
});

test('success clears the failure counter and records the time', async () => {
  const u = mkUser('ok');
  push.register(u, url('/ok'));
  db.prepare('UPDATE push_endpoints SET failures = 3 WHERE user_id = ?').run(u);
  await push.send(db.prepare('SELECT * FROM push_endpoints WHERE user_id = ?').get(u));
  const row = push.list(u)[0];
  assert.equal(row.failures, 0);
  assert.ok(row.lastOkAt);
});

test('private addresses are not contacted unless the operator allows them', async () => {
  const u = mkUser('priv');
  push.register(u, url('/private'));
  push.settings.allowPrivate = false;
  await push.send(db.prepare('SELECT * FROM push_endpoints WHERE user_id = ?').get(u));
  assert.equal(hits.length, 0);
  assert.equal(push.list(u)[0].failures, 1);
});
