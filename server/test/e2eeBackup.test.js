'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const { db } = require('../db');

function makeUser(username) {
  return db.prepare(
    'INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)'
  ).run(username, `${username}@test.local`, 'hash', username).lastInsertRowid;
}

test.after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('a fresh user has no key backup row', () => {
  const userId = makeUser('e2ee_bk1');
  const row = db.prepare('SELECT * FROM e2ee_key_backups WHERE user_id = ?').get(userId);
  assert.equal(row, undefined);
});

test('upserting a backup twice replaces it rather than erroring on the PK', () => {
  const userId = makeUser('e2ee_bk2');
  const upsert = (encryptedKey) => db.prepare(
    `INSERT INTO e2ee_key_backups (user_id, encrypted_key, salt, nonce) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET encrypted_key = excluded.encrypted_key, salt = excluded.salt, nonce = excluded.nonce, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).run(userId, encryptedKey, 'salt', 'nonce');
  upsert('first-version');
  upsert('second-version');
  const row = db.prepare('SELECT * FROM e2ee_key_backups WHERE user_id = ?').get(userId);
  assert.equal(row.encrypted_key, 'second-version');
});

test('deleting the user cascades away their key backup', () => {
  const userId = makeUser('e2ee_bk3');
  db.prepare('INSERT INTO e2ee_key_backups (user_id, encrypted_key, salt, nonce) VALUES (?, ?, ?, ?)')
    .run(userId, 'enc', 'salt', 'nonce');
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  const row = db.prepare('SELECT * FROM e2ee_key_backups WHERE user_id = ?').get(userId);
  assert.equal(row, undefined);
});
