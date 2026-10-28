'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const { db } = require('../db');
const { serializeMessage } = require('../lib/messages');

function makeUser(username) {
  return db.prepare(
    'INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)'
  ).run(username, `${username}@test.local`, 'hash', username).lastInsertRowid;
}

test.after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('deleting a channel category ungroups its channels instead of deleting them', () => {
  const ownerId = makeUser('cat_owner1');
  const serverId = db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)')
    .run('CatServer', ownerId, 'catsrv1').lastInsertRowid;
  const categoryId = db.prepare('INSERT INTO channel_categories (server_id, name, position) VALUES (?, ?, 0)')
    .run(serverId, 'Text Channels').lastInsertRowid;
  const channelId = db.prepare('INSERT INTO channels (server_id, name, type, category_id) VALUES (?, ?, ?, ?)')
    .run(serverId, 'general', 'public', categoryId).lastInsertRowid;

  assert.equal(db.prepare('SELECT category_id FROM channels WHERE id = ?').get(channelId).category_id, categoryId);

  db.prepare('DELETE FROM channel_categories WHERE id = ?').run(categoryId);

  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  assert.ok(channel, 'channel itself must survive its category being deleted');
  assert.equal(channel.category_id, null);
});

test('a pinned message serializes with pinnedAt/pinnedBy, an unpinned one with both null', () => {
  const userId = makeUser('pin_user1');
  const serverId = db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)')
    .run('PinServer', userId, 'pinsrv1').lastInsertRowid;
  const channelId = db.prepare('INSERT INTO channels (server_id, name, type) VALUES (?, ?, ?)')
    .run(serverId, 'general', 'public').lastInsertRowid;
  const messageId = db.prepare(
    'INSERT INTO messages (scope_type, scope_id, author_id, content) VALUES (?, ?, ?, ?)'
  ).run('channel', channelId, userId, 'hello').lastInsertRowid;

  const beforePin = serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId));
  assert.equal(beforePin.pinnedAt, null);
  assert.equal(beforePin.pinnedBy, null);

  db.prepare("UPDATE messages SET pinned_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), pinned_by = ? WHERE id = ?")
    .run(userId, messageId);
  const pinned = serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId));
  assert.ok(pinned.pinnedAt, 'pinnedAt should be set after pinning');
  assert.equal(pinned.pinnedBy.id, userId);

  db.prepare('UPDATE messages SET pinned_at = NULL, pinned_by = NULL WHERE id = ?').run(messageId);
  const unpinned = serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId));
  assert.equal(unpinned.pinnedAt, null);
  assert.equal(unpinned.pinnedBy, null);
});

test('deleting a user who pinned a message clears pinned_by without deleting the message', () => {
  const authorId = makeUser('pin_author1');
  const pinnerId = makeUser('pin_pinner1');
  const serverId = db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)')
    .run('PinServer2', authorId, 'pinsrv2').lastInsertRowid;
  const channelId = db.prepare('INSERT INTO channels (server_id, name, type) VALUES (?, ?, ?)')
    .run(serverId, 'general', 'public').lastInsertRowid;
  const messageId = db.prepare(
    'INSERT INTO messages (scope_type, scope_id, author_id, content) VALUES (?, ?, ?, ?)'
  ).run('channel', channelId, authorId, 'hi').lastInsertRowid;
  db.prepare("UPDATE messages SET pinned_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), pinned_by = ? WHERE id = ?")
    .run(pinnerId, messageId);

  db.prepare('DELETE FROM users WHERE id = ?').run(pinnerId);

  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
  assert.ok(row, 'message must survive the pinning user being deleted');
  assert.equal(row.pinned_by, null);
  assert.ok(row.pinned_at, 'pinned_at itself is untouched by the pinner being deleted');
});
