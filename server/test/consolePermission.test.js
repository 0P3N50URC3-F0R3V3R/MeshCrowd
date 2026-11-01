'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const express = require('express');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const { db, migrateOwnerConsoleBit } = require('../db');
const accounts = require('../lib/accounts');
const { SITE_PERMISSIONS, OWNER_SITE_PERMISSIONS, hasSite, hasSiteStrict } = require('../lib/permissions');
const { canUseConsole } = require('../lib/siteAuth');

const S = SITE_PERMISSIONS;
const mkUser = (n) => Number(db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
  .run(n, `${n}@t.local`, 'h', n).lastInsertRowid);
const mkRole = (name, perms) => Number(db.prepare('INSERT INTO site_roles (name, color, permissions, position) VALUES (?, ?, ?, ?)')
  .run(name, '#000000', perms, 1).lastInsertRowid);
const assign = (uid, rid) => db.prepare('INSERT INTO user_site_roles (user_id, role_id) VALUES (?, ?)').run(uid, rid);

let server; let base; let ownerId;
test.before(async () => {
  ownerId = (await accounts.createAccount({ username: 'first_owner', email: 'fo@t.local', password: 'password123' })).userId;
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const uid = Number(req.headers['x-uid']);
    if (uid) { req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid); req.sitePermissions = Number(req.headers['x-perms'] || 0); }
    next();
  });
  app.use('/api/admin', require('../routes/admin'));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.close(); db.close();
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function call(method, url, { uid, perms = 0, json } = {}) {
  const headers = {};
  if (uid) { headers['x-uid'] = String(uid); headers['x-perms'] = String(perms); }
  if (json !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(base + url, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  return { status: res.status, data: await res.json().catch(() => null) };
}

test('flag value and hasSiteStrict ignores the SITE_ADMINISTRATOR bypass', () => {
  assert.equal(S.MANAGE_CONSOLE, 1 << 9);
  assert.equal(hasSite(S.SITE_ADMINISTRATOR, S.MANAGE_CONSOLE), true);
  assert.equal(hasSiteStrict(S.SITE_ADMINISTRATOR, S.MANAGE_CONSOLE), false);
  assert.equal(hasSiteStrict(S.MANAGE_CONSOLE, S.MANAGE_CONSOLE), true);
  assert.ok(OWNER_SITE_PERMISSIONS & S.MANAGE_CONSOLE);
});

test('canUseConsole: Owner yes, SITE_ADMINISTRATOR-only no, nobody no, holder yes', () => {
  assert.equal(canUseConsole(ownerId), true);
  const admin = mkUser('c_admin'); assign(admin, mkRole('Adm', S.SITE_ADMINISTRATOR));
  assert.equal(canUseConsole(admin), false);
  assert.equal(canUseConsole(mkUser('c_none')), false);
  const holder = mkUser('c_holder'); assign(holder, mkRole('Con', S.MANAGE_CONSOLE));
  assert.equal(canUseConsole(holder), true);
});

test('PATCH /site-roles/:id adding MANAGE_CONSOLE needs the flag itself', async () => {
  const actor = mkUser('p_actor');
  const role = mkRole('Target', S.VIEW_ADMIN_PANEL);
  const adminBits = S.SITE_ADMINISTRATOR | S.MANAGE_SITE_ROLES | S.VIEW_ADMIN_PANEL;
  const denied = await call('PATCH', `/api/admin/site-roles/${role}`, { uid: actor, perms: adminBits, json: { permissions: S.VIEW_ADMIN_PANEL | S.MANAGE_CONSOLE } });
  assert.equal(denied.status, 403);
  assert.equal(db.prepare('SELECT permissions FROM site_roles WHERE id = ?').get(role).permissions, S.VIEW_ADMIN_PANEL);
  const ok = await call('PATCH', `/api/admin/site-roles/${role}`, { uid: actor, perms: adminBits | S.MANAGE_CONSOLE, json: { permissions: S.VIEW_ADMIN_PANEL | S.MANAGE_CONSOLE } });
  assert.equal(ok.status, 200);
  assert.equal(db.prepare('SELECT permissions FROM site_roles WHERE id = ?').get(role).permissions, S.VIEW_ADMIN_PANEL | S.MANAGE_CONSOLE);
});

test('PUT /users/:id/site-roles/:roleId assigning a console role needs the flag', async () => {
  const actor = mkUser('a_actor'); const target = mkUser('a_target');
  const role = mkRole('ConsoleRole', S.MANAGE_CONSOLE);
  const adminBits = S.SITE_ADMINISTRATOR | S.MANAGE_SITE_ROLES | S.VIEW_ADMIN_PANEL;
  assert.equal((await call('PUT', `/api/admin/users/${target}/site-roles/${role}`, { uid: actor, perms: adminBits })).status, 403);
  assert.equal(canUseConsole(target), false);
  assert.equal((await call('PUT', `/api/admin/users/${target}/site-roles/${role}`, { uid: actor, perms: adminBits | S.MANAGE_CONSOLE })).status, 200);
  assert.equal(canUseConsole(target), true);
});

test('non-console permission grants by SITE_ADMINISTRATOR still work', async () => {
  const actor = mkUser('n_actor');
  const role = mkRole('Plain', S.VIEW_ADMIN_PANEL);
  const r = await call('PATCH', `/api/admin/site-roles/${role}`, { uid: actor, perms: S.SITE_ADMINISTRATOR | S.MANAGE_SITE_ROLES | S.VIEW_ADMIN_PANEL, json: { permissions: S.VIEW_ADMIN_PANEL | S.MANAGE_AI } });
  assert.equal(r.status, 200);
});

test('migration repairs the first Owner role (even at 255), once, and never an imposter', () => {
  const owner = db.prepare("SELECT id FROM site_roles WHERE name = 'Owner'").get().id;
  const get = (id) => db.prepare('SELECT permissions FROM site_roles WHERE id = ?').get(id).permissions;
  const rerun = () => { db.prepare("DELETE FROM meta WHERE key = 'owner_console_bit_migrated'").run(); migrateOwnerConsoleBit(); };
  assert.ok(db.prepare("SELECT 1 FROM meta WHERE key = 'owner_console_bit_migrated'").get(), 'marker set on a fresh db');
  db.prepare('UPDATE site_roles SET permissions = 255 WHERE id = ?').run(owner);
  migrateOwnerConsoleBit();
  assert.equal(get(owner), 255, 'marker present: not upgraded');

  rerun();
  assert.equal(get(owner), OWNER_SITE_PERMISSIONS, 'legacy 255 Owner gets every flag including MANAGE_CONSOLE');
  assert.ok(get(owner) & S.MANAGE_CONSOLE);

  db.prepare("UPDATE site_roles SET name = 'Founder', permissions = 255 WHERE id = ?").run(owner);
  const imposter = mkRole('Owner', 511);
  assign(mkUser('imposter_holder'), imposter);
  rerun();
  assert.equal(get(imposter), 511, 'a role named Owner that is not the first holder is not upgraded');
  assert.equal(get(owner), 255, 'the first holder role is only recognised while it is named Owner');
  db.prepare('DELETE FROM user_site_roles WHERE role_id = ?').run(imposter);
  db.prepare('DELETE FROM site_roles WHERE id = ?').run(imposter);
  db.prepare("UPDATE site_roles SET name = 'Owner' WHERE id = ?").run(owner);

  db.prepare('UPDATE site_roles SET permissions = 255 WHERE id = ?').run(owner);
  migrateOwnerConsoleBit();
  assert.equal(get(owner), 255, 'second run is a no-op');

  db.prepare('UPDATE site_roles SET permissions = ? WHERE id = ?').run(S.VIEW_ADMIN_PANEL, owner);
  rerun();
  assert.equal(get(owner), S.VIEW_ADMIN_PANEL, 'an Owner role without SITE_ADMINISTRATOR is left alone');
  db.prepare('UPDATE site_roles SET permissions = ? WHERE id = ?').run(OWNER_SITE_PERMISSIONS, owner);
});

test('POST /site-roles ignores permissions in the body', async () => {
  const actor = mkUser('po_actor');
  const r = await call('POST', '/api/admin/site-roles', { uid: actor, perms: S.SITE_ADMINISTRATOR | S.MANAGE_SITE_ROLES | S.VIEW_ADMIN_PANEL, json: { name: 'Sneaky', permissions: S.MANAGE_CONSOLE } });
  assert.equal(r.status, 201);
  assert.equal(r.data.role.permissions, 0);
});

test('a non-holder cannot PATCH or unassign a role that already holds the flag', async () => {
  const actor = mkUser('np_actor'); const target = mkUser('np_target');
  const role = mkRole('HasConsole', S.MANAGE_CONSOLE | S.VIEW_ADMIN_PANEL);
  assign(target, role);
  const adminBits = S.SITE_ADMINISTRATOR | S.MANAGE_SITE_ROLES | S.VIEW_ADMIN_PANEL;
  assert.equal((await call('PATCH', `/api/admin/site-roles/${role}`, { uid: actor, perms: adminBits, json: { name: 'x' } })).status, 403);
  assert.equal((await call('DELETE', `/api/admin/users/${target}/site-roles/${role}`, { uid: actor, perms: adminBits })).status, 403);
  assert.equal(canUseConsole(target), true);
});
