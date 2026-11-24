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

const VIEW = SITE_PERMISSIONS.VIEW_ADMIN_PANEL;
const ADMIN = VIEW | SITE_PERMISSIONS.SITE_ADMINISTRATOR;
let server; let base; let uid;

function png(w, h, size) {
  const head = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8); head.write('IHDR', 12, 'latin1'); head.writeUInt32BE(w, 16); head.writeUInt32BE(h, 20);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, size - 33))]);
}

test.before(async () => {
  uid = Number(db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)').run('ia_admin', 'ia@t.local', 'h', 'ia').lastInsertRowid);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const id = Number(req.headers['x-uid']);
    if (id) { req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(id); req.sitePermissions = Number(req.headers['x-perms'] || 0); }
    next();
  });
  app.use('/instance', require('../routes/instancePublic'));
  app.use('/api/admin', require('../routes/admin'));
  await new Promise((r) => { server = http.createServer(app).listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.close(); db.close();
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function call(method, url, { json, file, mime, perms = ADMIN } = {}) {
  const headers = { 'x-uid': String(uid), 'x-perms': String(perms) };
  let body;
  if (json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
  if (file) { body = new FormData(); body.append('file', new Blob([file], { type: mime }), 'x'); }
  const res = await fetch(base + url, { method, headers, body });
  return { status: res.status, res, data: await res.clone().json().catch(() => null) };
}

test('only a site administrator can change the instance profile', async () => {
  assert.equal((await call('PATCH', '/api/admin/instance', { json: { name: 'Nope' }, perms: VIEW })).status, 403);
  assert.equal((await call('GET', '/api/admin/instance', { perms: VIEW })).status, 403);
});

test('name and description round-trip', async () => {
  const r = await call('PATCH', '/api/admin/instance', { json: { name: 'Home Lab', description: 'Our place' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.name, 'Home Lab');
  assert.equal((await call('GET', '/api/admin/instance')).data.description, 'Our place');
  assert.equal((await call('PATCH', '/api/admin/instance', { json: { name: 7 } })).status, 400);
});

test('icon upload enforces the advert limits and the public route serves it', async () => {
  const big = await call('POST', '/api/admin/instance/icon', { file: png(200, 200, 2000), mime: 'image/png' });
  assert.equal(big.status, 400);
  assert.match(big.data.error, /128/);
  assert.equal((await fetch(`${base}/instance/icon`)).status, 404);
  assert.equal((await call('POST', '/api/admin/instance/icon', { file: png(64, 64, 2000), mime: 'image/png' })).status, 200);
  const pub = await fetch(`${base}/instance/icon`);
  assert.equal(pub.status, 200);
  assert.equal(pub.headers.get('content-type'), 'image/png');
  assert.equal(pub.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await call('DELETE', '/api/admin/instance/icon')).status, 200);
  assert.equal((await fetch(`${base}/instance/icon`)).status, 404);
});

test('logo upload and removal', async () => {
  assert.equal((await call('POST', '/api/admin/instance/logo', { file: Buffer.from('<html>'), mime: 'image/png' })).status, 400);
  assert.equal((await call('POST', '/api/admin/instance/logo', { file: png(300, 100, 900), mime: 'image/png' })).data.hasLogo, true);
  assert.equal((await fetch(`${base}/instance/logo`)).status, 200);
  assert.equal((await call('DELETE', '/api/admin/instance/logo')).data.hasLogo, false);
});
