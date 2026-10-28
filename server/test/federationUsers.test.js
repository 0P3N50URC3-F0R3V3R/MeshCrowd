'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;
const { db } = require('../db');
const { resolveOrCreateRemoteUser } = require('../lib/federationUsers');

test.after(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

test('creates a cached row on first sight, updates profile fields on re-sight, never touches local users', () => {
  const peerId = db.prepare(`INSERT INTO federation_peers (domain, public_url, their_pubkey, status) VALUES ('f.example', 'https://f', 'PEM', 'active')`).run().lastInsertRowid;
  const peer = { id: peerId, domain: 'f.example' };

  // Baseline, not a hardcoded 0: server/db/index.js seeds one local system user
  // (__webhook__, home_instance_id IS NULL) on every fresh DB.
  const baselineLocalCount = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE home_instance_id IS NULL`).get().n;

  const created = resolveOrCreateRemoteUser(peer, { remoteId: 42, username: 'alex', displayName: 'Alex' });
  assert.equal(created.federated_uid, 'alex@f.example');
  assert.equal(created.home_instance_id, peerId);
  assert.equal(created.remote_user_id, 42);

  const updated = resolveOrCreateRemoteUser(peer, { remoteId: 42, username: 'alex', displayName: 'Alex Renamed' });
  assert.equal(updated.id, created.id); // same cached row, not a duplicate
  assert.equal(updated.display_name, 'Alex Renamed');

  const localCount = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE home_instance_id IS NULL`).get().n;
  assert.equal(localCount, baselineLocalCount); // no local users were created in this test
});
