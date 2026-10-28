'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const http = require('node:http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;
const { db } = require('../db');
const { router: adminRouter } = require('../routes/federationAdmin');
const { setFederationAdminPassword, createFederationAdminSession } = require('../lib/federationAdminAuth');

test.after(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

test('revoking a peer sets status to revoked', async () => {
  setFederationAdminPassword('super-secret-federation-pass');
  const { token } = createFederationAdminSession();
  const peerId = db.prepare(`INSERT INTO federation_peers (domain, public_url, their_pubkey, status) VALUES (?, ?, ?, 'active')`)
    .run('peer2.example', 'https://93.184.216.34/', 'PEM').lastInsertRowid;

  const app = express();
  app.use(express.json());
  app.use('/federation/admin', adminRouter);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const res = await fetch(`${base}/federation/admin/peers/${peerId}`, {
    method: 'DELETE', headers: { cookie: `dismesh_federation_admin=${token}` },
  });
  assert.equal(res.status, 200);
  assert.equal(db.prepare('SELECT status FROM federation_peers WHERE id = ?').get(peerId).status, 'revoked');
  server.close();
});
