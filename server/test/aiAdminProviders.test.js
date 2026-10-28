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
const { SITE_PERMISSIONS } = require('../lib/permissions');

const AI = SITE_PERMISSIONS.MANAGE_AI;
const mkUser = (n) => Number(db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
  .run(n, `${n}@t.local`, 'h', n).lastInsertRowid);

let server; let base; let fake; let fakePort;
test.before(async () => {
  fake = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ models: [{ name: 'gemma3:4b' }] }));
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  fakePort = fake.address().port;

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const uid = Number(req.headers['x-uid']);
    if (uid) { req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid); req.sitePermissions = Number(req.headers['x-perms'] || 0); }
    next();
  });
  app.use('/api/admin/ai', require('../routes/adminAi'));
  await new Promise((r) => { server = http.createServer(app).listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.close(); fake.close(); db.close();
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function call(method, url, { uid, perms = 0, json } = {}) {
  const headers = {};
  if (uid) { headers['x-uid'] = String(uid); headers['x-perms'] = String(perms); }
  if (json !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(base + url, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, data, text };
}

const body = (extra = {}) => ({ name: 'Local Ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', ...extra });

test('only MANAGE_AI or SITE_ADMINISTRATOR may use the provider routes', async () => {
  const u = mkUser('p_perm');
  assert.equal((await call('GET', '/api/admin/ai/providers')).status, 401);
  assert.equal((await call('GET', '/api/admin/ai/providers', { uid: u, perms: 0 })).status, 403);
  assert.equal((await call('GET', '/api/admin/ai/providers', { uid: u, perms: SITE_PERMISSIONS.VIEW_ADMIN_PANEL })).status, 403);
  assert.equal((await call('GET', '/api/admin/ai/providers', { uid: u, perms: AI })).status, 200);
  assert.equal((await call('GET', '/api/admin/ai/providers', { uid: u, perms: SITE_PERMISSIONS.SITE_ADMINISTRATOR })).status, 200);
});

test('create validates input and never returns the api key', async () => {
  const u = mkUser('p_create');
  const bad = [
    body({ name: '' }), body({ kind: 'nope' }), body({ baseUrl: 'ftp://x' }), body({ baseUrl: 'http://u:p@h' }),
    body({ timeoutS: 1 }), body({ concurrency: 9 }), body({ models: 'x' }),
  ];
  for (const b of bad) assert.equal((await call('POST', '/api/admin/ai/providers', { uid: u, perms: AI, json: b })).status, 400, JSON.stringify(b));

  const ok = await call('POST', '/api/admin/ai/providers', {
    uid: u, perms: AI, json: body({ name: 'Cloud', kind: 'openai', baseUrl: 'https://api.example.com/v1/', apiKey: 'sk-very-secret', models: ['gpt-x', 'gpt-x', ' gpt-y '], serverAdminUsable: true }),
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.provider.hasKey, true);
  assert.equal(ok.data.provider.baseUrl, 'https://api.example.com/v1');
  assert.deepEqual(ok.data.provider.models, ['gpt-x', 'gpt-y']);
  assert.equal(ok.data.provider.serverAdminUsable, true);
  assert.ok(!ok.text.includes('sk-very-secret'));
  const list = await call('GET', '/api/admin/ai/providers', { uid: u, perms: AI });
  assert.ok(!list.text.includes('sk-very-secret'));
  assert.ok(!list.text.includes('api_key_enc'));
  const stored = db.prepare("SELECT api_key_enc FROM ai_providers WHERE name = 'Cloud'").get();
  assert.ok(stored.api_key_enc.startsWith('v1.'));
});

test('duplicate names answer 409', async () => {
  const u = mkUser('p_dup');
  assert.equal((await call('POST', '/api/admin/ai/providers', { uid: u, perms: AI, json: body({ name: 'Same' }) })).status, 201);
  assert.equal((await call('POST', '/api/admin/ai/providers', { uid: u, perms: AI, json: body({ name: 'same' }) })).status, 409);
});

test('patch keeps the key unless apiKey is sent, and an empty apiKey clears it', async () => {
  const u = mkUser('p_patch');
  const created = (await call('POST', '/api/admin/ai/providers', { uid: u, perms: AI, json: body({ name: 'Patchy', apiKey: 'k1' }) })).data.provider;
  const before = db.prepare('SELECT api_key_enc FROM ai_providers WHERE id = ?').get(created.id).api_key_enc;
  let r = await call('PATCH', `/api/admin/ai/providers/${created.id}`, { uid: u, perms: AI, json: { enabled: false, models: ['m1'] } });
  assert.equal(r.status, 200);
  assert.equal(r.data.provider.enabled, false);
  assert.equal(db.prepare('SELECT api_key_enc FROM ai_providers WHERE id = ?').get(created.id).api_key_enc, before);
  r = await call('PATCH', `/api/admin/ai/providers/${created.id}`, { uid: u, perms: AI, json: { apiKey: '' } });
  assert.equal(r.data.provider.hasKey, false);
  assert.equal((await call('PATCH', '/api/admin/ai/providers/99999', { uid: u, perms: AI, json: { enabled: true } })).status, 404);
});

test('a provider in use cannot be deleted; an unused one can', async () => {
  const u = mkUser('p_del');
  const used = (await call('POST', '/api/admin/ai/providers', { uid: u, perms: AI, json: body({ name: 'Used' }) })).data.provider;
  const serverId = Number(db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)').run('S', u, 'inv-del').lastInsertRowid);
  const botUser = Number(db.prepare('INSERT INTO users (username, email, password_hash, display_name, is_bot) VALUES (?, ?, ?, ?, 1)').run('del_bot', 'del@t.local', 'h', 'D').lastInsertRowid);
  db.prepare('INSERT INTO bots (user_id, server_id, provider_id, model) VALUES (?, ?, ?, ?)').run(botUser, serverId, used.id, 'm');
  const r = await call('DELETE', `/api/admin/ai/providers/${used.id}`, { uid: u, perms: AI });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /del_bot|Used|bots/);
  const free = (await call('POST', '/api/admin/ai/providers', { uid: u, perms: AI, json: body({ name: 'Free' }) })).data.provider;
  assert.equal((await call('DELETE', `/api/admin/ai/providers/${free.id}`, { uid: u, perms: AI })).status, 200);
});

test('test endpoint lists models from a reachable provider and reports failure generically', async () => {
  const u = mkUser('p_test');
  const ok = await call('POST', '/api/admin/ai/providers/test', { uid: u, perms: AI, json: { kind: 'ollama', baseUrl: `http://127.0.0.1:${fakePort}` } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.ok, true);
  assert.deepEqual(ok.data.models, ['gemma3:4b']);
  assert.equal(typeof ok.data.latencyMs, 'number');
  const down = await call('POST', '/api/admin/ai/providers/test', { uid: u, perms: AI, json: { kind: 'ollama', baseUrl: 'http://127.0.0.1:1' } });
  assert.equal(down.status, 200);
  assert.equal(down.data.ok, false);
  assert.match(down.data.error, /connect/);
  assert.equal((await call('POST', '/api/admin/ai/providers/test', { uid: u, perms: AI, json: { kind: 'ollama', baseUrl: 'ftp://nope' } })).status, 400);
});

test('test endpoint reuses the stored key when providerId is given and apiKey is omitted', async () => {
  const u = mkUser('p_testkey');
  const created = (await call('POST', '/api/admin/ai/providers', { uid: u, perms: AI, json: body({ name: 'Keyed', baseUrl: `http://127.0.0.1:${fakePort}`, apiKey: 'abc' }) })).data.provider;
  const r = await call('POST', '/api/admin/ai/providers/test', { uid: u, perms: AI, json: { providerId: created.id, kind: 'ollama', baseUrl: `http://127.0.0.1:${fakePort}` } });
  assert.equal(r.data.ok, true);
});
