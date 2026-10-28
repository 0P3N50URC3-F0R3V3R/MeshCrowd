'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const { db, DATA_DIR } = require('../db');
const prune = require('../lib/prune');

function makeUser(username) {
  return db.prepare(
    'INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)'
  ).run(username, `${username}@test.local`, 'hash', username).lastInsertRowid;
}
function makeServer(ownerId, inviteCode) {
  return db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)')
    .run('PruneServer', ownerId, inviteCode).lastInsertRowid;
}
function makeChannel(serverId, name = 'general') {
  return db.prepare('INSERT INTO channels (server_id, name, type) VALUES (?, ?, ?)').run(serverId, name, 'public').lastInsertRowid;
}
function makeMessage(scopeType, scopeId, authorId, content, createdAt) {
  const id = db.prepare('INSERT INTO messages (scope_type, scope_id, author_id, content, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(scopeType, scopeId, authorId, content, createdAt).lastInsertRowid;
  return id;
}

test.after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('prune deletes only messages before the cutoff, in scope', () => {
  const userId = makeUser('prune_u1');
  const serverId = makeServer(userId, 'prunesrv1');
  const channelId = makeChannel(serverId);
  const oldId = makeMessage('channel', channelId, userId, 'old', '2024-01-01T00:00:00.000Z');
  const newId = makeMessage('channel', channelId, userId, 'new', '2026-01-01T00:00:00.000Z');

  const pairs = prune.resolveScopePairs('channels', [channelId]);
  const before = prune.previewPrune(pairs, '2025-01-01T00:00:00.000Z', true);
  assert.equal(before.messageCount, 1);

  const result = prune.executePrune({
    scopeKind: 'channels', ids: [channelId], cutoffAt: '2025-01-01T00:00:00.000Z',
    purgeAttachments: true, notify: 'immediate', requestedBy: userId, serverId,
  });
  assert.equal(result.status, 'done');
  assert.equal(result.messageCount, 1);
  assert.equal(db.prepare('SELECT 1 FROM messages WHERE id = ?').get(oldId), undefined);
  assert.ok(db.prepare('SELECT 1 FROM messages WHERE id = ?').get(newId), 'message after cutoff must survive');
});

test('unchecked "delete attachments" leaves attachment-bearing messages untouched regardless of date', () => {
  const userId = makeUser('prune_u2');
  const serverId = makeServer(userId, 'prunesrv2');
  const channelId = makeChannel(serverId);
  const plainOldId = makeMessage('channel', channelId, userId, 'plain old', '2024-01-01T00:00:00.000Z');
  const attachedOldId = makeMessage('channel', channelId, userId, 'has file', '2024-01-01T00:00:00.000Z');
  db.prepare('INSERT INTO attachments (message_id, file_path, file_name, mime_type, size_bytes) VALUES (?, ?, ?, ?, ?)')
    .run(attachedOldId, '/uploads/attachments/channel-x/f.png', 'f.png', 'image/png', 100);

  prune.executePrune({
    scopeKind: 'channels', ids: [channelId], cutoffAt: '2025-01-01T00:00:00.000Z',
    purgeAttachments: false, notify: 'immediate', requestedBy: userId, serverId,
  });

  assert.equal(db.prepare('SELECT 1 FROM messages WHERE id = ?').get(plainOldId), undefined, 'attachment-free message should be pruned');
  assert.ok(db.prepare('SELECT 1 FROM messages WHERE id = ?').get(attachedOldId), 'attachment-bearing message must survive when the checkbox is off');
});

test('pruning a channel also removes old messages in its threads', () => {
  const userId = makeUser('prune_u3');
  const serverId = makeServer(userId, 'prunesrv3');
  const channelId = makeChannel(serverId);
  const threadId = db.prepare('INSERT INTO threads (channel_id, title, created_by) VALUES (?, ?, ?)')
    .run(channelId, 'a thread', userId).lastInsertRowid;
  const threadMsgId = makeMessage('thread', threadId, userId, 'old thread reply', '2024-01-01T00:00:00.000Z');

  prune.executePrune({
    scopeKind: 'channels', ids: [channelId], cutoffAt: '2025-01-01T00:00:00.000Z',
    purgeAttachments: true, notify: 'immediate', requestedBy: userId, serverId,
  });

  assert.equal(db.prepare('SELECT 1 FROM messages WHERE id = ?').get(threadMsgId), undefined);
  assert.ok(db.prepare('SELECT 1 FROM threads WHERE id = ?').get(threadId), 'the thread row itself is not deleted, only its old messages');
});

test('purging attachments unlinks the file from disk, cascades the DB row, and syncs the FTS index', () => {
  const userId = makeUser('prune_u4');
  const serverId = makeServer(userId, 'prunesrv4');
  const channelId = makeChannel(serverId);
  const msgId = makeMessage('channel', channelId, userId, 'searchable old text', '2024-01-01T00:00:00.000Z');
  const relPath = '/uploads/attachments/channel-test/keepme.png';
  const diskPath = path.join(DATA_DIR, 'attachments', 'channel-test', 'keepme.png');
  fs.mkdirSync(path.dirname(diskPath), { recursive: true });
  fs.writeFileSync(diskPath, 'fake image bytes');
  db.prepare('INSERT INTO attachments (message_id, file_path, file_name, mime_type, size_bytes) VALUES (?, ?, ?, ?, ?)')
    .run(msgId, relPath, 'keepme.png', 'image/png', 17);

  prune.executePrune({
    scopeKind: 'channels', ids: [channelId], cutoffAt: '2025-01-01T00:00:00.000Z',
    purgeAttachments: true, notify: 'immediate', requestedBy: userId, serverId,
  });

  assert.equal(fs.existsSync(diskPath), false, 'attachment file must be unlinked from disk');
  assert.equal(db.prepare('SELECT 1 FROM attachments WHERE message_id = ?').get(msgId), undefined, 'attachment row cascades away');
  const ftsHit = db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'searchable'").all();
  assert.ok(!ftsHit.some((r) => r.rowid === msgId), 'FTS index must drop the pruned message too');
});

test('grace-period prune posts a notice immediately but only deletes once the worker finds it due', () => {
  const userId = makeUser('prune_u5');
  const serverId = makeServer(userId, 'prunesrv5');
  const channelId = makeChannel(serverId);
  const oldId = makeMessage('channel', channelId, userId, 'old', '2024-01-01T00:00:00.000Z');

  const result = prune.executePrune({
    scopeKind: 'channels', ids: [channelId], cutoffAt: '2025-01-01T00:00:00.000Z',
    purgeAttachments: true, notify: 'grace', requestedBy: userId, serverId,
  });
  assert.equal(result.status, 'scheduled');

  // The notice message (event_type=data_prune) is posted right away.
  const notice = db.prepare("SELECT * FROM messages WHERE scope_type = 'channel' AND scope_id = ? AND event_type = 'data_prune'").get(channelId);
  assert.ok(notice, 'a heads-up notice must be posted immediately, even though deletion is deferred');

  // Not due yet — the worker must not touch it.
  prune.runDuePrunes();
  assert.ok(db.prepare('SELECT 1 FROM messages WHERE id = ?').get(oldId), 'message must survive until the grace period elapses');

  // Force it due, then the worker executes it.
  db.prepare("UPDATE pending_prunes SET execute_at = '2000-01-01T00:00:00.000Z' WHERE server_id = ? AND status = 'pending'").run(serverId);
  prune.runDuePrunes();
  assert.equal(db.prepare('SELECT 1 FROM messages WHERE id = ?').get(oldId), undefined, 'worker must delete once due');
  assert.equal(db.prepare("SELECT status FROM pending_prunes WHERE server_id = ?").get(serverId).status, 'done');
});

test('wipeScope fully removes a scope\'s messages, unlinks attachment files, and syncs FTS', () => {
  const userId = makeUser('wipe_u1');
  const dmId = db.prepare('INSERT INTO dm_channels (is_group, created_by) VALUES (0, ?)').run(userId).lastInsertRowid;
  const keptMsgId = makeMessage('channel', makeChannel(makeServer(userId, 'wipesrv1')), userId, 'unrelated, must survive', '2024-01-01T00:00:00.000Z');
  const msgId = makeMessage('dm', dmId, userId, 'searchable secret', '2026-01-01T00:00:00.000Z');
  const relPath = '/uploads/attachments/dm-test/file.png';
  const diskPath = path.join(DATA_DIR, 'attachments', 'dm-test', 'file.png');
  fs.mkdirSync(path.dirname(diskPath), { recursive: true });
  fs.writeFileSync(diskPath, 'bytes');
  db.prepare('INSERT INTO attachments (message_id, file_path, file_name, mime_type, size_bytes) VALUES (?, ?, ?, ?, ?)')
    .run(msgId, relPath, 'file.png', 'image/png', 5);

  prune.wipeScope('dm', dmId);

  assert.equal(db.prepare('SELECT 1 FROM messages WHERE id = ?').get(msgId), undefined, 'the dm message must be gone, no cutoff needed');
  assert.equal(fs.existsSync(diskPath), false, 'its attachment file must be unlinked');
  const ftsHit = db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'searchable'").all();
  assert.ok(!ftsHit.some((r) => r.rowid === msgId), 'FTS index must drop the wiped message');
  assert.ok(db.prepare('SELECT 1 FROM messages WHERE id = ?').get(keptMsgId), 'a message in an unrelated scope must be untouched');
});

test('the DM/group listing query never needs to touch message content, only counts and bytes', () => {
  const u1 = makeUser('prune_dm1');
  const u2 = makeUser('prune_dm2');
  const dmId = db.prepare('INSERT INTO dm_channels (is_group, created_by) VALUES (0, ?)').run(u1).lastInsertRowid;
  db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?), (?, ?)').run(dmId, u1, dmId, u2);
  makeMessage('dm', dmId, u1, 'a private secret nobody but the two of them should see', '2024-01-01T00:00:00.000Z');

  const pairs = prune.resolveScopePairs('dm', [dmId]);
  const preview = prune.previewPrune(pairs, '2025-01-01T00:00:00.000Z', true);
  assert.equal(preview.messageCount, 1);
  // previewPrune's return shape is counts only — no content field exists to leak.
  assert.deepEqual(Object.keys(preview).sort(), ['attachmentBytes', 'attachmentCount', 'messageCount']);
});

test('prunePassportAudit deletes rows older than 90 days and keeps newer ones', () => {
  const ins = db.prepare("INSERT INTO passport_audit (action, ok, created_at) VALUES ('login', 1, ?)");
  const day = 24 * 60 * 60 * 1000;
  ins.run(new Date(Date.now() - 91 * day).toISOString());
  ins.run(new Date(Date.now() - 89 * day).toISOString());
  ins.run(new Date().toISOString());
  assert.equal(prune.prunePassportAudit(), 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM passport_audit').get().c, 2);
});
