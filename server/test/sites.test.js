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
const hub = require('../socket/hub');
const siteFiles = require('../lib/siteFiles');
const { SITE_PERMISSIONS } = require('../lib/permissions');
const { canManageSites } = require('../lib/siteAuth');

const makeUser = (n) => db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
  .run(n, `${n}@t.local`, 'h', n).lastInsertRowid;

const STAFF = SITE_PERMISSIONS.MANAGE_ANY_SERVER;
let sent = [];
const realNotify = hub.notifyUserIds;
let server; let base;

test.before(async () => {
  hub.notifyUserIds = (ids, payload) => sent.push({ ids, payload });
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const uid = Number(req.headers['x-uid']);
    if (uid) { req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid); req.sitePermissions = Number(req.headers['x-perms'] || 0); }
    next();
  });
  app.use('/api/sites', require('../routes/sites'));
  app.use('/api/servers', require('../routes/servers'));
  await new Promise((r) => { server = http.createServer(app).listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.beforeEach(() => { sent = []; });
test.after(() => { hub.notifyUserIds = realNotify; server.close(); db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

async function call(method, url, { uid, perms = 0, json, raw } = {}) {
  const headers = {};
  if (uid) { headers['x-uid'] = String(uid); headers['x-perms'] = String(perms); }
  let body;
  if (json !== undefined && method !== 'GET') { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
  if (raw !== undefined) { headers['content-type'] = 'application/octet-stream'; body = raw; }
  const res = await fetch(base + url, { method, headers, body });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, data };
}

async function makeSite(staffId, name = 'Intranet') {
  const r = await call('POST', '/api/sites', { uid: staffId, perms: STAFF, json: { name } });
  assert.equal(r.status, 201);
  return r.data.server;
}

test('only site staff can create a Site; it is public, auto-join, kind site, with every user a member', async () => {
  const staff = makeUser('st_staff'); const plain = makeUser('st_plain');
  assert.equal((await call('POST', '/api/sites', { uid: plain, perms: 0, json: { name: 'X' } })).status, 403);
  assert.equal((await call('POST', '/api/sites', { json: { name: 'X' } })).status, 401);
  const s = await makeSite(staff);
  assert.equal(s.kind, 'site'); assert.equal(s.visibility, 'public'); assert.equal(s.auto_join, 1);
  const members = db.prepare('SELECT user_id FROM server_members WHERE server_id = ?').all(s.id).map((m) => m.user_id);
  assert.ok(members.includes(staff) && members.includes(plain));
  assert.ok(!members.includes(db.prepare("SELECT id FROM users WHERE username = '__webhook__'").get()?.id ?? -1));
  assert.ok(fs.existsSync(path.join(siteFiles.siteDir(s.id), 'index.php')));
  assert.equal(sent.at(-1).payload.type, 'server_update');
  assert.equal(canManageSites(staff), false); // no site role in DB: staff here come from the request header
});

test('GET /:id reports canEdit for the owner and staff but not for other members; non-members are refused', async () => {
  const staff = makeUser('st_g1'); const plain = makeUser('st_g2');
  const s = await makeSite(staff);
  assert.equal((await call('GET', `/api/sites/${s.id}`, { uid: staff, perms: STAFF })).data.canEdit, true);
  assert.equal((await call('GET', `/api/sites/${s.id}`, { uid: plain })).data.canEdit, false);
  const outsider = makeUser('st_g3');
  db.prepare('DELETE FROM server_members WHERE server_id = ? AND user_id = ?').run(s.id, outsider);
  assert.equal((await call('GET', `/api/sites/${s.id}`, { uid: outsider })).status, 403);
});

test('file API: editors only, path-safe, conflict-aware', async () => {
  const staff = makeUser('st_f1'); const plain = makeUser('st_f2');
  const s = await makeSite(staff);
  const q = (p, extra = '') => `/api/sites/${s.id}/files/content?path=${encodeURIComponent(p)}${extra}`;
  assert.equal((await call('PUT', q('a.html'), { uid: plain, raw: '<p>x</p>' })).status, 403);
  const w = await call('PUT', q('árak lista.html'), { uid: staff, perms: STAFF, raw: '<p>x</p>' });
  assert.equal(w.status, 200);
  const r = await call('GET', q('árak lista.html'), { uid: staff, perms: STAFF });
  assert.equal(r.data.content, '<p>x</p>');
  assert.equal((await call('PUT', q('../evil.php'), { uid: staff, perms: STAFF, raw: 'x' })).status, 400);
  assert.equal((await call('PUT', q('árak lista.html', `&mtime=${w.data.mtimeMs - 9000}`), { uid: staff, perms: STAFF, raw: 'y' })).status, 409);
  assert.equal((await call('PUT', q('árak lista.html', `&mtime=${w.data.mtimeMs - 9000}&force=1`), { uid: staff, perms: STAFF, raw: 'y' })).status, 200);
  const list = await call('GET', `/api/sites/${s.id}/files`, { uid: staff, perms: STAFF });
  assert.ok(list.data.files.some((f) => f.path === 'árak lista.html'));
  assert.equal((await call('POST', `/api/sites/${s.id}/files/mkdir`, { uid: staff, perms: STAFF, json: { path: 'docs' } })).status, 200);
  assert.equal((await call('POST', `/api/sites/${s.id}/files/rename`, { uid: staff, perms: STAFF, json: { from: 'árak lista.html', to: 'docs/arak.html' } })).status, 200);
  assert.equal((await call('DELETE', `/api/sites/${s.id}/files?path=docs`, { uid: staff, perms: STAFF })).status, 200);
});

test('PATCH validates and normalises origins, requires an editor, and notifies members', async () => {
  const staff = makeUser('st_p1'); const plain = makeUser('st_p2');
  const s = await makeSite(staff);
  assert.equal((await call('PATCH', `/api/sites/${s.id}`, { uid: plain, json: { name: 'Z' } })).status, 403);
  assert.equal((await call('PATCH', `/api/sites/${s.id}`, { uid: staff, perms: STAFF, json: { origins: ['http://x.com'] } })).status, 400);
  const ok = await call('PATCH', `/api/sites/${s.id}`, { uid: staff, perms: STAFF, json: { name: 'Renamed', origins: ['https://CDN.example.com/'] } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.server.name, 'Renamed');
  assert.deepEqual(JSON.parse(ok.data.server.site_csp_origins), ['https://cdn.example.com']);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE server_id = ? AND action = 'site_origins_change'").get(s.id));
  assert.equal(sent.at(-1).payload.type, 'server_update');
});

test('DELETE removes the row and folder for the owner or staff only', async () => {
  const staff = makeUser('st_d1'); const plain = makeUser('st_d2');
  const s = await makeSite(staff);
  assert.equal((await call('DELETE', `/api/sites/${s.id}`, { uid: plain })).status, 403);
  assert.equal((await call('DELETE', `/api/sites/${s.id}`, { uid: staff, perms: STAFF })).status, 200);
  assert.equal(db.prepare('SELECT 1 FROM servers WHERE id = ?').get(s.id), undefined);
  assert.equal(fs.existsSync(siteFiles.siteDir(s.id)), false);
  assert.equal(sent.at(-1).payload.type, 'server_delete');
});

test('GET /runtime is staff-only', async () => {
  const plain = makeUser('st_r1');
  assert.equal((await call('GET', '/api/sites/runtime', { uid: plain })).status, 403);
  const r = await call('GET', '/api/sites/runtime', { uid: plain, perms: STAFF });
  assert.equal(r.status, 200);
  assert.equal(typeof r.data.ok, 'boolean');
});

test('chat routes refuse site servers; GET detail still works; a chat server is unaffected', async () => {
  const staff = makeUser('st_c1');
  const s = await makeSite(staff);
  assert.equal((await call('GET', `/api/servers/${s.id}`, { uid: staff })).status, 200);
  for (const [m, p] of [['PATCH', ''], ['DELETE', ''], ['POST', '/leave'], ['POST', '/channels'], ['GET', '/search?q=x'], ['POST', '/roles']]) {
    assert.equal((await call(m, `/api/servers/${s.id}${p}`, { uid: staff, perms: STAFF, json: {} })).status, 404, `${m} ${p}`);
  }
  const list = await call('GET', '/api/servers', { uid: staff });
  assert.ok(list.data.servers.some((x) => x.id === s.id && x.kind === 'site'));
  const created = await call('POST', '/api/servers', { uid: staff, json: { name: 'Chatty' } });
  assert.equal(created.status, 201);
  assert.equal((await call('GET', `/api/servers/${created.data.server.id}`, { uid: staff })).status, 200);
});
