'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;
const { db } = require('../db');
const {
  isFederationAdminConfigured, setFederationAdminPassword,
  verifyFederationAdminPassword, createFederationAdminSession, getFederationAdminSession,
} = require('../lib/federationAdminAuth');

test.after(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

test('setup, login, and session lifecycle', () => {
  assert.equal(isFederationAdminConfigured(), false);
  setFederationAdminPassword('correct horse battery staple');
  assert.equal(isFederationAdminConfigured(), true);
  assert.equal(verifyFederationAdminPassword('wrong'), false);
  assert.equal(verifyFederationAdminPassword('correct horse battery staple'), true);

  const { token } = createFederationAdminSession();
  assert.ok(getFederationAdminSession(token));
  assert.equal(getFederationAdminSession('bogus'), null);
});

const express = require('express');
const http = require('node:http');
const { router } = require('../routes/federationAdmin');

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/federation/admin', router);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try { await fn(`http://127.0.0.1:${port}`); } finally { server.close(); }
}

test('login route rejects until setup, then issues a cookie', async () => {
  // Reset state left by the previous test — both tests share the one DatabaseSync
  // instance keyed off DISMESH_DATA_DIR, so this test needs a clean "not configured" slate.
  db.prepare("DELETE FROM meta WHERE key = 'federation_admin_password_hash'").run();
  db.prepare('DELETE FROM federation_admin_sessions').run();

  await withServer(async (base) => {
    const bad = await fetch(`${base}/federation/admin/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'x' }),
    });
    assert.equal(bad.status, 403); // not configured yet

    const setup = await fetch(`${base}/federation/admin/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'super-secret-federation-pass' }),
    });
    assert.equal(setup.status, 200);

    const wrongLogin = await fetch(`${base}/federation/admin/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'nope' }),
    });
    assert.equal(wrongLogin.status, 401);

    const login = await fetch(`${base}/federation/admin/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'super-secret-federation-pass' }),
    });
    assert.equal(login.status, 200);
    assert.match(login.headers.get('set-cookie') || '', /dismesh_federation_admin=/);
  });
});
