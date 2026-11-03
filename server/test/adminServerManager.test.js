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
const { deleteDueServers } = require('../lib/serverDeletion');

const MANAGE = SITE_PERMISSIONS.VIEW_ADMIN_PANEL | SITE_PERMISSIONS.MANAGE_ANY_SERVER;
const mkUser = (n) => Number(db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
  .run(n, `${n}@t.local`, 'h', n).lastInsertRowid);
const mkServer = (name, owner) => Number(db.prepare('INSERT INTO servers (name, owner_id) VALUES (?, ?)').run(name, owner).lastInsertRowid);

let server; let base; let admin; let owner;
test.before(async () => {
  admin = mkUser('sm_admin'); owner = mkUser('sm_owner');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const uid = Number(req.headers['x-uid']);
    if (uid) { req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid); req.sitePermissions = Number(req.headers['x-perms'] || 0); }
    next();
  });
  app.use('/api/admin', require('../routes/admin'));
  await new Promise((r) => { server = http.createServer(app).listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.close(); db.close();
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function call(method, url, json, perms = MANAGE) {
  const headers = { 'x-uid': String(admin), 'x-perms': String(perms) };
  if (json !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(base + url, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('overview lists servers with owner and counts', async () => {
  const id = mkServer('Overview One', owner);
  const r = await call('GET', '/api/admin/servers-overview');
  const row = r.body.servers.find((s) => s.id === id);
  assert.equal(row.ownerName, 'sm_owner');
  assert.equal(row.deleteAt, null);
});

test('requires manage-any-server permission', async () => {
  const id = mkServer('Forbidden', owner);
  assert.equal((await call('PATCH', `/api/admin/servers/${id}/deletion`, { deleteAt: null }, SITE_PERMISSIONS.VIEW_ADMIN_PANEL)).status, 403);
});

test('schedule, cancel, reject past dates', async () => {
  const id = mkServer('Timed', owner);
  const future = new Date(Date.now() + 3600e3).toISOString();
  assert.equal((await call('PATCH', `/api/admin/servers/${id}/deletion`, { deleteAt: future })).body.deleteAt, future);
  assert.equal((await call('PATCH', `/api/admin/servers/${id}/deletion`, { deleteAt: new Date(Date.now() - 1000).toISOString() })).status, 400);
  assert.equal((await call('PATCH', `/api/admin/servers/${id}/deletion`, { deleteAt: 'junk' })).status, 400);
  assert.equal((await call('PATCH', `/api/admin/servers/${id}/deletion`, { deleteAt: null })).body.deleteAt, null);
  assert.ok(db.prepare('SELECT id FROM servers WHERE id = ?').get(id));
});

test('worker deletes only servers whose time has come', () => {
  const due = mkServer('Due', owner); const later = mkServer('Later', owner);
  db.prepare('UPDATE servers SET delete_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), due);
  db.prepare('UPDATE servers SET delete_at = ? WHERE id = ?').run(new Date(Date.now() + 3600e3).toISOString(), later);
  assert.equal(deleteDueServers(), 1);
  assert.equal(db.prepare('SELECT id FROM servers WHERE id = ?').get(due), undefined);
  assert.ok(db.prepare('SELECT id FROM servers WHERE id = ?').get(later));
});

test('permanent delete removes the server immediately', async () => {
  const id = mkServer('Gone', owner);
  assert.equal((await call('DELETE', `/api/admin/servers/${id}`)).status, 200);
  assert.equal(db.prepare('SELECT id FROM servers WHERE id = ?').get(id), undefined);
});
