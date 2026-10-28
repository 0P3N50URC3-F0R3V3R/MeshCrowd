'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const { db } = require('../db');
const { listMessages, serializeMessage } = require('../lib/messages');
const { searchMessages } = require('../lib/search');
const { PERMISSIONS } = require('../lib/permissions');
const { getChannelPermissionBits } = require('../lib/channelAccess');

function makeUser(username) {
  return db.prepare(
    'INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)'
  ).run(username, `${username}@test.local`, 'hash', username).lastInsertRowid;
}

test.after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('a thread reuses the generic messages pipeline: list, edit-reindex, and search all work against scope_type=thread', () => {
  const ownerId = makeUser('thread_owner1');
  const serverId = db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)')
    .run('S1', ownerId, 'inv1').lastInsertRowid;
  const channelId = db.prepare('INSERT INTO channels (server_id, name, type) VALUES (?, ?, ?)')
    .run(serverId, 'general', 'public').lastInsertRowid;
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(serverId, ownerId);

  const parentMsgId = db.prepare('INSERT INTO messages (scope_type, scope_id, author_id, content) VALUES (?, ?, ?, ?)')
    .run('channel', channelId, ownerId, 'the message a thread gets spawned from').lastInsertRowid;

  const threadId = db.prepare('INSERT INTO threads (channel_id, parent_message_id, title, created_by) VALUES (?, ?, ?, ?)')
    .run(channelId, parentMsgId, 'Discussion thread', ownerId).lastInsertRowid;

  const m1 = db.prepare('INSERT INTO messages (scope_type, scope_id, author_id, content) VALUES (?, ?, ?, ?)')
    .run('thread', threadId, ownerId, 'first reply in the thread').lastInsertRowid;
  db.prepare('INSERT INTO messages (scope_type, scope_id, author_id, content) VALUES (?, ?, ?, ?)')
    .run('thread', threadId, ownerId, 'second reply, mentions widget');

  const listed = listMessages('thread', threadId);
  assert.equal(listed.length, 2);
  assert.equal(listed[0].scopeType, 'thread');
  assert.equal(listed[0].scopeId, threadId);

  const found = searchMessages('thread', [threadId], 'widget');
  assert.equal(found.length, 1);
  assert.match(found[0].content, /widget/);

  // Editing re-indexes (via the same FTS triggers channel/dm messages use) and a plain channel
  // message with the same word must never leak into a thread-scoped search.
  db.prepare('INSERT INTO messages (scope_type, scope_id, author_id, content) VALUES (?, ?, ?, ?)')
    .run('channel', channelId, ownerId, 'widget mentioned at the top level too');
  assert.equal(searchMessages('thread', [threadId], 'widget').length, 1, 'thread search must stay scoped to the thread, not the whole channel');

  db.prepare("UPDATE messages SET content = 'no longer about that gadget' WHERE id = ?").run(m1);
  assert.equal(searchMessages('thread', [threadId], 'widget').length, 1, 'the OTHER thread message still matches widget');
  assert.equal(serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(m1)).content, 'no longer about that gadget');
});

test('a forum channel type is a normal channel permission-wise: VIEW_CHANNEL/SEND_MESSAGES are not stripped', () => {
  const ownerId = makeUser('thread_owner2');
  const memberId = makeUser('thread_member2');
  const serverId = db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)')
    .run('S2', ownerId, 'inv2').lastInsertRowid;
  db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 0, 1)')
    .run(serverId, '@everyone', PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.SEND_MESSAGES);
  const channelId = db.prepare('INSERT INTO channels (server_id, name, type) VALUES (?, ?, ?)')
    .run(serverId, 'showcase', 'forum').lastInsertRowid;
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(serverId, memberId);

  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  const bits = getChannelPermissionBits(channel, memberId);
  assert.equal(bits & PERMISSIONS.VIEW_CHANNEL, PERMISSIONS.VIEW_CHANNEL);
  assert.equal(bits & PERMISSIONS.SEND_MESSAGES, PERMISSIONS.SEND_MESSAGES);
});

test('wipeScope on a thread removes its messages and the thread row can then be deleted', () => {
  const { wipeScope } = require('../lib/prune');
  const ownerId = makeUser('thread_owner_del');
  const serverId = db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)')
    .run('S-del', ownerId, 'inv-del').lastInsertRowid;
  const channelId = db.prepare('INSERT INTO channels (server_id, name, type) VALUES (?, ?, ?)')
    .run(serverId, 'forum', 'forum').lastInsertRowid;
  const threadId = db.prepare('INSERT INTO threads (channel_id, title, created_by) VALUES (?, ?, ?)')
    .run(channelId, 'to delete', ownerId).lastInsertRowid;
  db.prepare('INSERT INTO messages (scope_type, scope_id, author_id, content) VALUES (?, ?, ?, ?)')
    .run('thread', threadId, ownerId, 'bye');

  wipeScope('thread', threadId);
  db.prepare('DELETE FROM threads WHERE id = ?').run(threadId);

  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM messages WHERE scope_type = ? AND scope_id = ?').get('thread', threadId).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM threads WHERE id = ?').get(threadId).c, 0);
});

test('shapeThread-style card data: first message preview, image thumbnail and reaction totals come from the first thread message', () => {
  const owner = makeUser('thread_card_owner');
  const serverId = db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)').run('S2', owner, 'inv-card').lastInsertRowid;
  const channelId = db.prepare('INSERT INTO channels (server_id, name, type) VALUES (?, ?, ?)').run(serverId, 'forum', 'forum').lastInsertRowid;
  const threadId = db.prepare('INSERT INTO threads (channel_id, title, created_by) VALUES (?, ?, ?)').run(channelId, 'Card', owner).lastInsertRowid;
  const first = db.prepare('INSERT INTO messages (scope_type, scope_id, author_id, content) VALUES (?, ?, ?, ?)').run('thread', threadId, owner, 'opening text').lastInsertRowid;
  db.prepare('INSERT INTO attachments (message_id, file_path, file_name, mime_type, size_bytes) VALUES (?, ?, ?, ?, ?)').run(first, '/a/x.png', 'x.png', 'image/png', 10);
  db.prepare('INSERT INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)').run(first, owner, '👍');
  const { shapeThread } = require('../routes/threads');
  const card = shapeThread(db.prepare('SELECT * FROM threads WHERE id = ?').get(threadId));
  assert.equal(card.preview.content, 'opening text');
  assert.equal(card.thumbnail, '/a/x.png');
  assert.equal(card.reactionCount, 1);
  assert.equal(card.topEmoji, '👍');
});

test('shapeThread exposes pinned and the first-post author id', () => {
  const { shapeThread } = require('../routes/threads');
  const uid = makeUser('thread_pin_user');
  const sid = db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)').run('SP', uid, 'invpin').lastInsertRowid;
  const cid = db.prepare('INSERT INTO channels (server_id, name, type) VALUES (?, ?, ?)').run(sid, 'f', 'forum').lastInsertRowid;
  const tid = db.prepare('INSERT INTO threads (channel_id, title, created_by) VALUES (?, ?, ?)').run(cid, 'P', uid).lastInsertRowid;
  db.prepare('INSERT INTO messages (scope_type, scope_id, author_id, content) VALUES (?, ?, ?, ?)').run('thread', tid, uid, 'hi');
  assert.equal(shapeThread(db.prepare('SELECT * FROM threads WHERE id = ?').get(tid)).pinned, false);
  db.prepare('UPDATE threads SET pinned = 1 WHERE id = ?').run(tid);
  const shaped = shapeThread(db.prepare('SELECT * FROM threads WHERE id = ?').get(tid));
  assert.equal(shaped.pinned, true);
  assert.equal(shaped.preview.authorId, uid);
});
