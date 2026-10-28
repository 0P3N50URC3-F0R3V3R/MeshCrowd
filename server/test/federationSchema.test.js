'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;
const { db } = require('../db');

test.after(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

test('federation tables and columns exist', () => {
  for (const table of ['federation_peers', 'federation_invites', 'federation_outbox', 'federation_inbox_seen']) {
    assert.ok(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table), `${table} missing`);
  }
  const userCols = db.prepare(`PRAGMA table_info(users)`).all().map((c) => c.name);
  for (const col of ['home_instance_id', 'remote_user_id', 'federated_uid']) {
    assert.ok(userCols.includes(col), `users.${col} missing`);
  }
  const msgCols = db.prepare(`PRAGMA table_info(messages)`).all().map((c) => c.name);
  for (const col of ['federation_peer_id', 'federation_message_id']) {
    assert.ok(msgCols.includes(col), `messages.${col} missing`);
  }
  // federated_uid must be unique
  db.prepare('INSERT INTO users (username, email, password_hash, display_name, federated_uid) VALUES (?, ?, ?, ?, ?)')
    .run('u1', 'u1@test.local', 'h', 'U1', 'u1@peer.example');
  assert.throws(() => {
    db.prepare('INSERT INTO users (username, email, password_hash, display_name, federated_uid) VALUES (?, ?, ?, ?, ?)')
      .run('u2', 'u2@test.local', 'h', 'U2', 'u1@peer.example');
  }, /UNIQUE/);
});
