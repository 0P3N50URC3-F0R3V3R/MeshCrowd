'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const { db } = require('../db');
const { toPublicUser } = require('../lib/publicUser');

function makeUser(username) {
  return db.prepare(
    'INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)'
  ).run(username, `${username}@test.local`, 'hash', username).lastInsertRowid;
}

test.after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('toPublicUser exposes e2eePublicKey as null when unset', () => {
  const userId = makeUser('e2ee_pub1');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const shaped = toPublicUser(user, {});
  assert.equal(shaped.e2eePublicKey, null);
});

test('toPublicUser exposes e2eePublicKey once set, visible to anyone (not gated by viewerIsSelf)', () => {
  const userId = makeUser('e2ee_pub2');
  db.prepare('UPDATE users SET e2ee_public_key = ? WHERE id = ?').run('fake-base64-key', userId);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const shapedForOther = toPublicUser(user, { viewerIsSelf: false });
  const shapedForSelf = toPublicUser(user, { viewerIsSelf: true });
  assert.equal(shapedForOther.e2eePublicKey, 'fake-base64-key');
  assert.equal(shapedForSelf.e2eePublicKey, 'fake-base64-key');
});
