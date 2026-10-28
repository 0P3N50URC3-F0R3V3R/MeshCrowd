'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;
const { db } = require('../db');
const { enqueueEvent } = require('../lib/federationOutbox');

test.after(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

test('enqueue writes a pending row for an active peer, skips revoked peers', () => {
  const activeId = db.prepare(`INSERT INTO federation_peers (domain, public_url, their_pubkey, status) VALUES ('a.example', 'https://a', 'PEM', 'active')`).run().lastInsertRowid;
  const revokedId = db.prepare(`INSERT INTO federation_peers (domain, public_url, their_pubkey, status) VALUES ('b.example', 'https://b', 'PEM', 'revoked')`).run().lastInsertRowid;

  enqueueEvent(activeId, 'dm_message_create', { hello: 'world' });
  enqueueEvent(revokedId, 'dm_message_create', { hello: 'world' });

  const rows = db.prepare('SELECT * FROM federation_outbox').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].peer_id, activeId);
  assert.equal(rows[0].status, 'pending');
  assert.deepEqual(JSON.parse(rows[0].payload_json), { hello: 'world' });
  assert.match(rows[0].event_id, /^[0-9a-f-]{36}$/);
});
