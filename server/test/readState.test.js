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

// Same upsert the PUT /:scopeType/:scopeId route runs.
function markRead(userId, scopeType, scopeId, messageId) {
  db.prepare(
    `INSERT INTO read_state (user_id, scope_type, scope_id, last_read_message_id, updated_at)
     VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(user_id, scope_type, scope_id) DO UPDATE SET
       last_read_message_id = MAX(last_read_message_id, excluded.last_read_message_id),
       updated_at = excluded.updated_at`
  ).run(userId, scopeType, scopeId, messageId);
}

test.after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('marking read stores the pointer, and re-marking bumps it forward', () => {
  const userId = makeUser('rs_user1');
  markRead(userId, 'channel', 1, 5);
  let row = db.prepare('SELECT last_read_message_id FROM read_state WHERE user_id = ? AND scope_type = ? AND scope_id = ?')
    .get(userId, 'channel', 1);
  assert.equal(row.last_read_message_id, 5);

  markRead(userId, 'channel', 1, 9);
  row = db.prepare('SELECT last_read_message_id FROM read_state WHERE user_id = ? AND scope_type = ? AND scope_id = ?')
    .get(userId, 'channel', 1);
  assert.equal(row.last_read_message_id, 9);
});

test('marking read with an older message id never rolls the pointer backward', () => {
  const userId = makeUser('rs_user2');
  markRead(userId, 'dm', 3, 10);
  markRead(userId, 'dm', 3, 4); // stale client, e.g. re-opening a conversation after scrolling up
  const row = db.prepare('SELECT last_read_message_id FROM read_state WHERE user_id = ? AND scope_type = ? AND scope_id = ?')
    .get(userId, 'dm', 3);
  assert.equal(row.last_read_message_id, 10, 'pointer must be monotonic');
});

test('read state is isolated per user and per scope', () => {
  const userA = makeUser('rs_user3');
  const userB = makeUser('rs_user4');
  markRead(userA, 'channel', 7, 20);
  markRead(userB, 'channel', 7, 2);
  markRead(userA, 'dm', 7, 99); // same scope_id, different scope_type

  assert.equal(db.prepare('SELECT last_read_message_id FROM read_state WHERE user_id = ? AND scope_type = ? AND scope_id = ?').get(userA, 'channel', 7).last_read_message_id, 20);
  assert.equal(db.prepare('SELECT last_read_message_id FROM read_state WHERE user_id = ? AND scope_type = ? AND scope_id = ?').get(userB, 'channel', 7).last_read_message_id, 2);
  assert.equal(db.prepare('SELECT last_read_message_id FROM read_state WHERE user_id = ? AND scope_type = ? AND scope_id = ?').get(userA, 'dm', 7).last_read_message_id, 99);
});
