'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;
const { db, DATA_DIR } = require('../db');

// Captured BEFORE federationApi.js is first required, so its `const { broadcastToDm } =
// require('../socket/hub')` destructure picks up this wrapped version — lets tests assert on the
// exact wire shape broadcast to clients, not just the resulting DB state.
const hub = require('../socket/hub');
const broadcasts = [];
const realBroadcastToDm = hub.broadcastToDm;
hub.broadcastToDm = (dmChannelId, payload) => {
  broadcasts.push({ dmChannelId, payload });
  return realBroadcastToDm(dmChannelId, payload);
};

const { inboxHandlers } = require('../routes/federationApi');

test.after(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

function makeUser(username) {
  return db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run(username, `${username}@test.local`, 'hash', username).lastInsertRowid;
}

function makePeer(domain) {
  return db.prepare(`INSERT INTO federation_peers (domain, public_url, their_pubkey, status) VALUES (?, ?, 'PEM', 'active')`)
    .run(domain, `https://${domain}`).lastInsertRowid;
}

function makeRemoteUser(peerId, username, domain) {
  return db.prepare(
    `INSERT INTO users (username, email, password_hash, display_name, home_instance_id, federated_uid) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(username, `${username}@remote.invalid`, 'x', username, peerId, `${username}@${domain}`).lastInsertRowid;
}

test('edit/delete/reaction target the message via (peer, federation_message_id)', () => {
  const localId = makeUser('localfay');
  const peerId = makePeer('j.example');
  const peer = { id: peerId, domain: 'j.example' };
  const dmChannelId = db.prepare('INSERT INTO dm_channels (is_group, created_by) VALUES (0, ?)').run(localId).lastInsertRowid;
  db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?)').run(dmChannelId, localId);
  const remoteAuthor = makeRemoteUser(peerId, 'rg', 'j.example');
  const msgId = db.prepare(`INSERT INTO messages (scope_type, scope_id, author_id, content, federation_peer_id, federation_message_id) VALUES ('dm', ?, ?, 'orig', ?, 'msg-1')`)
    .run(dmChannelId, remoteAuthor, peerId).lastInsertRowid;

  inboxHandlers.dm_message_edit(peer, { originMessageId: 'msg-1', content: 'edited' });
  assert.equal(db.prepare('SELECT content FROM messages WHERE id = ?').get(msgId).content, 'edited');

  inboxHandlers.dm_reaction_add(peer, { originMessageId: 'msg-1', userUsername: 'rg', emoji: '👍' });
  assert.ok(db.prepare('SELECT 1 FROM message_reactions WHERE message_id = ? AND emoji = ?').get(msgId, '👍'));

  inboxHandlers.dm_message_delete(peer, { originMessageId: 'msg-1' });
  // Hard delete, matching the local DELETE /:id route: deleted_at is a dead column nothing in this
  // codebase reads or filters on, so setting it (the brief's literal behavior) would leave the
  // message fully visible, content and all, the next time any client re-fetches history.
  assert.equal(db.prepare('SELECT 1 FROM messages WHERE id = ?').get(msgId), undefined);
});

test('a peer cannot edit or delete a message that originated from a different peer', () => {
  const localId = makeUser('localgus');
  const peerAId = makePeer('a.example');
  const peerBId = makePeer('b.example');
  const peerA = { id: peerAId, domain: 'a.example' };
  const peerB = { id: peerBId, domain: 'b.example' };
  const dmChannelId = db.prepare('INSERT INTO dm_channels (is_group, created_by) VALUES (0, ?)').run(localId).lastInsertRowid;
  db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?)').run(dmChannelId, localId);
  const remoteAuthor = makeRemoteUser(peerAId, 'authorA', 'a.example');
  const msgId = db.prepare(`INSERT INTO messages (scope_type, scope_id, author_id, content, federation_peer_id, federation_message_id) VALUES ('dm', ?, ?, 'from-a', ?, 'shared-id')`)
    .run(dmChannelId, remoteAuthor, peerAId).lastInsertRowid;

  inboxHandlers.dm_message_edit(peerB, { originMessageId: 'shared-id', content: 'tampered by B' });
  assert.equal(db.prepare('SELECT content FROM messages WHERE id = ?').get(msgId).content, 'from-a', 'peer B must not touch a message that originated from peer A');

  inboxHandlers.dm_message_delete(peerB, { originMessageId: 'shared-id' });
  assert.ok(db.prepare('SELECT 1 FROM messages WHERE id = ?').get(msgId), 'peer B must not be able to delete peer A-origin message');
});

test('inbound edit content is capped at 15000 chars, same as the local PATCH route', () => {
  const localId = makeUser('localhal');
  const peerId = makePeer('cap1.example');
  const peer = { id: peerId, domain: 'cap1.example' };
  const dmChannelId = db.prepare('INSERT INTO dm_channels (is_group, created_by) VALUES (0, ?)').run(localId).lastInsertRowid;
  db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?)').run(dmChannelId, localId);
  const remoteAuthor = makeRemoteUser(peerId, 'capauthor', 'cap1.example');
  const msgId = db.prepare(`INSERT INTO messages (scope_type, scope_id, author_id, content, federation_peer_id, federation_message_id) VALUES ('dm', ?, ?, 'orig', ?, 'cap-msg')`)
    .run(dmChannelId, remoteAuthor, peerId).lastInsertRowid;

  const huge = 'x'.repeat(20000);
  inboxHandlers.dm_message_edit(peer, { originMessageId: 'cap-msg', content: huge });
  const stored = db.prepare('SELECT content FROM messages WHERE id = ?').get(msgId).content;
  assert.equal(stored.length, 15000);
});

test('inbound edit with empty-after-trim content is dropped, not applied', () => {
  const localId = makeUser('localivy');
  const peerId = makePeer('empty1.example');
  const peer = { id: peerId, domain: 'empty1.example' };
  const dmChannelId = db.prepare('INSERT INTO dm_channels (is_group, created_by) VALUES (0, ?)').run(localId).lastInsertRowid;
  db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?)').run(dmChannelId, localId);
  const remoteAuthor = makeRemoteUser(peerId, 'emptyauthor', 'empty1.example');
  const msgId = db.prepare(`INSERT INTO messages (scope_type, scope_id, author_id, content, federation_peer_id, federation_message_id) VALUES ('dm', ?, ?, 'keep-me', ?, 'empty-msg')`)
    .run(dmChannelId, remoteAuthor, peerId).lastInsertRowid;

  inboxHandlers.dm_message_edit(peer, { originMessageId: 'empty-msg', content: '   ' });
  assert.equal(db.prepare('SELECT content FROM messages WHERE id = ?').get(msgId).content, 'keep-me');
});

test('inbound reaction emoji is capped at 34 chars, same as the local PUT reactions route', () => {
  const localId = makeUser('localjan');
  const peerId = makePeer('cap2.example');
  const peer = { id: peerId, domain: 'cap2.example' };
  const dmChannelId = db.prepare('INSERT INTO dm_channels (is_group, created_by) VALUES (0, ?)').run(localId).lastInsertRowid;
  db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?)').run(dmChannelId, localId);
  const remoteAuthor = makeRemoteUser(peerId, 'reactorjan', 'cap2.example');
  const msgId = db.prepare(`INSERT INTO messages (scope_type, scope_id, author_id, content, federation_peer_id, federation_message_id) VALUES ('dm', ?, ?, 'orig', ?, 'cap-react')`)
    .run(dmChannelId, remoteAuthor, peerId).lastInsertRowid;

  const hugeEmoji = ':'.repeat(100);
  inboxHandlers.dm_reaction_add(peer, { originMessageId: 'cap-react', userUsername: 'reactorjan', emoji: hugeEmoji });
  const row = db.prepare('SELECT emoji FROM message_reactions WHERE message_id = ?').get(msgId);
  assert.ok(row);
  assert.ok(row.emoji.length <= 34);
});

test('hard delete removes attachment files from disk, not just the DB rows', () => {
  const localId = makeUser('localken');
  const peerId = makePeer('att1.example');
  const peer = { id: peerId, domain: 'att1.example' };
  const dmChannelId = db.prepare('INSERT INTO dm_channels (is_group, created_by) VALUES (0, ?)').run(localId).lastInsertRowid;
  db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?)').run(dmChannelId, localId);
  const remoteAuthor = makeRemoteUser(peerId, 'kenauthor', 'att1.example');
  const msgId = db.prepare(`INSERT INTO messages (scope_type, scope_id, author_id, content, federation_peer_id, federation_message_id) VALUES ('dm', ?, ?, 'orig', ?, 'att-msg')`)
    .run(dmChannelId, remoteAuthor, peerId).lastInsertRowid;

  const dir = path.join(DATA_DIR, 'attachments', `dm-${dmChannelId}`);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'file.txt');
  fs.writeFileSync(filePath, 'hello');
  db.prepare('INSERT INTO attachments (message_id, file_path, file_name, mime_type, size_bytes) VALUES (?, ?, ?, ?, ?)')
    .run(msgId, `/uploads/attachments/dm-${dmChannelId}/file.txt`, 'file.txt', 'text/plain', 5);

  inboxHandlers.dm_message_delete(peer, { originMessageId: 'att-msg' });
  assert.equal(db.prepare('SELECT 1 FROM attachments WHERE message_id = ?').get(msgId), undefined);
  // best-effort unlink is async (fs.unlink callback-style) — give it a tick to land.
  return new Promise((resolve) => setImmediate(() => {
    assert.equal(fs.existsSync(filePath), false);
    resolve();
  }));
});

test('a reaction from a non-origin instance is applied to the true origin\'s own local copy of the message', () => {
  // The author is LOCAL here (this instance IS the true origin) — federation_peer_id is NULL on
  // this row, so the plain findFederatedMessage(peer, id) lookup (keyed on federation_peer_id =
  // peer.id) can never match it, no matter which peer sends the reaction. Without a same-origin
  // fallback, every reaction added by a remote participant would silently vanish for the author.
  const authorId = makeUser('trueorigin');
  const peerId = makePeer('echo1.example');
  const peer = { id: peerId, domain: 'echo1.example' };
  const dmChannelId = db.prepare('INSERT INTO dm_channels (is_group, created_by) VALUES (0, ?)').run(authorId).lastInsertRowid;
  const remoteMember = makeRemoteUser(peerId, 'remoteReactor', 'echo1.example');
  db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?), (?, ?)').run(dmChannelId, authorId, dmChannelId, remoteMember);
  const msgId = db.prepare(`INSERT INTO messages (scope_type, scope_id, author_id, content) VALUES ('dm', ?, ?, 'my own message')`)
    .run(dmChannelId, authorId).lastInsertRowid;

  inboxHandlers.dm_reaction_add(peer, { originMessageId: String(msgId), userUsername: 'remoteReactor', emoji: '🔥' });
  assert.ok(db.prepare('SELECT 1 FROM message_reactions WHERE message_id = ? AND emoji = ?').get(msgId, '🔥'));

  inboxHandlers.dm_reaction_remove(peer, { originMessageId: String(msgId), userUsername: 'remoteReactor', emoji: '🔥' });
  assert.equal(db.prepare('SELECT 1 FROM message_reactions WHERE message_id = ? AND emoji = ?').get(msgId, '🔥'), undefined);
});

test('the same-origin reaction fallback cannot be used by a peer who is not actually a member of that DM', () => {
  const authorId = makeUser('guardedauthor');
  const dmChannelId = db.prepare('INSERT INTO dm_channels (is_group, created_by) VALUES (0, ?)').run(authorId).lastInsertRowid;
  db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?)').run(dmChannelId, authorId);
  const msgId = db.prepare(`INSERT INTO messages (scope_type, scope_id, author_id, content) VALUES ('dm', ?, ?, 'private message')`)
    .run(dmChannelId, authorId).lastInsertRowid;

  const outsiderPeerId = makePeer('outsider.example');
  const outsiderPeer = { id: outsiderPeerId, domain: 'outsider.example' };
  inboxHandlers.dm_reaction_add(outsiderPeer, { originMessageId: String(msgId), userUsername: 'nobody', emoji: '👀' });
  assert.equal(db.prepare('SELECT 1 FROM message_reactions WHERE message_id = ?').get(msgId), undefined, 'an unrelated peer must not be able to react to an arbitrary local message id');
});

test('broadcast shapes match what the client listens for (serialized message, not a raw row or an unused event type)', () => {
  const localId = makeUser('localshape');
  const peerId = makePeer('shape1.example');
  const peer = { id: peerId, domain: 'shape1.example' };
  const dmChannelId = db.prepare('INSERT INTO dm_channels (is_group, created_by) VALUES (0, ?)').run(localId).lastInsertRowid;
  db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?)').run(dmChannelId, localId);
  const remoteAuthor = makeRemoteUser(peerId, 'shapeauthor', 'shape1.example');
  const msgId = db.prepare(`INSERT INTO messages (scope_type, scope_id, author_id, content, federation_peer_id, federation_message_id) VALUES ('dm', ?, ?, 'orig', ?, 'shape-msg')`)
    .run(dmChannelId, remoteAuthor, peerId).lastInsertRowid;

  broadcasts.length = 0;
  inboxHandlers.dm_message_edit(peer, { originMessageId: 'shape-msg', content: 'edited for shape' });
  let last = broadcasts.at(-1).payload;
  // onWsUpdate (web/js/views/chat.js) does `belongsToScope(message)` (message.scopeType/scopeId,
  // camelCase) then `messages[idx] = message` — a raw DB row (scope_type, no attachments[]/
  // reactions[]) fails belongsToScope and would never even reach that replacement.
  assert.equal(last.type, 'message_update');
  assert.equal(last.message.scopeType, 'dm');
  assert.equal(last.message.content, 'edited for shape');
  assert.ok(Array.isArray(last.message.reactions));

  broadcasts.length = 0;
  inboxHandlers.dm_reaction_add(peer, { originMessageId: 'shape-msg', userUsername: 'shapeauthor', emoji: '✅' });
  last = broadcasts.at(-1).payload;
  // onWsDelete/onWsCreate/onWsUpdate are the only three event types the client's ws bus dispatches
  // for messages — there is no 'reaction_add' listener anywhere, so that shape would silently never
  // render until the next full reload.
  assert.equal(last.type, 'message_update');
  assert.ok(last.message.reactions.some((r) => r.emoji === '✅'));

  broadcasts.length = 0;
  inboxHandlers.dm_reaction_remove(peer, { originMessageId: 'shape-msg', userUsername: 'shapeauthor', emoji: '✅' });
  last = broadcasts.at(-1).payload;
  assert.equal(last.type, 'message_update');
  assert.equal(last.message.reactions.some((r) => r.emoji === '✅'), false);

  broadcasts.length = 0;
  inboxHandlers.dm_message_delete(peer, { originMessageId: 'shape-msg' });
  last = broadcasts.at(-1).payload;
  // onWsDelete requires payload.scopeType === scopeType and String(payload.scopeId) === scopeId —
  // the brief's literal payload only carried dmChannelId/messageId, so this check would always fail
  // and the message would never disappear from an open client's view.
  assert.equal(last.type, 'message_delete');
  assert.equal(last.scopeType, 'dm');
  assert.equal(last.scopeId, dmChannelId);
  assert.equal(last.messageId, msgId);
});

// Outbound side: server/routes/messages.js's relayMessageMutation + the four call sites added to
// PATCH/DELETE/PUT-reactions/DELETE-reactions.
const express = require('express');
const http = require('node:http');
const messagesRouter = require('../routes/messages');

async function withMessagesServer(user, fn) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = user; next(); });
  app.use('/', messagesRouter);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}

function latestOutboxPayload(peerId, type) {
  const row = db.prepare('SELECT * FROM federation_outbox WHERE peer_id = ? AND type = ? ORDER BY id DESC LIMIT 1').get(peerId, type);
  return row ? JSON.parse(row.payload_json) : null;
}

test('outbound: editing a locally-authored DM message relays dm_message_edit with the already-capped content', async () => {
  const aliceId = makeUser('aliceEdit');
  const alice = db.prepare('SELECT * FROM users WHERE id = ?').get(aliceId);
  const peerId = makePeer('out1.example');
  const remoteMemberId = makeRemoteUser(peerId, 'remoteOut1', 'out1.example');
  const dmChannelId = db.prepare('INSERT INTO dm_channels (is_group, created_by) VALUES (0, ?)').run(aliceId).lastInsertRowid;
  db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?), (?, ?)').run(dmChannelId, aliceId, dmChannelId, remoteMemberId);
  const msgId = db.prepare(`INSERT INTO messages (scope_type, scope_id, author_id, content) VALUES ('dm', ?, ?, 'before')`).run(dmChannelId, aliceId).lastInsertRowid;

  await withMessagesServer(alice, async (base) => {
    const res = await fetch(`${base}/${msgId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'x'.repeat(20000) }),
    });
    assert.equal(res.status, 200);
  });

  const payload = latestOutboxPayload(peerId, 'dm_message_edit');
  assert.ok(payload);
  assert.equal(payload.originMessageId, String(msgId));
  assert.equal(payload.content.length, 15000);
});

test('outbound: deleting a locally-authored DM message relays dm_message_delete', async () => {
  const bobId = makeUser('bobDelete');
  const bob = db.prepare('SELECT * FROM users WHERE id = ?').get(bobId);
  const peerId = makePeer('out2.example');
  const remoteMemberId = makeRemoteUser(peerId, 'remoteOut2', 'out2.example');
  const dmChannelId = db.prepare('INSERT INTO dm_channels (is_group, created_by) VALUES (0, ?)').run(bobId).lastInsertRowid;
  db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?), (?, ?)').run(dmChannelId, bobId, dmChannelId, remoteMemberId);
  const msgId = db.prepare(`INSERT INTO messages (scope_type, scope_id, author_id, content) VALUES ('dm', ?, ?, 'bye')`).run(dmChannelId, bobId).lastInsertRowid;

  await withMessagesServer(bob, async (base) => {
    const res = await fetch(`${base}/${msgId}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
  });

  const payload = latestOutboxPayload(peerId, 'dm_message_delete');
  assert.ok(payload);
  assert.equal(payload.originMessageId, String(msgId));
});

test('outbound: reacting to a DM message relays dm_reaction_add with the reactor\'s username and already-capped emoji', async () => {
  const carlId = makeUser('carlReact');
  const carl = db.prepare('SELECT * FROM users WHERE id = ?').get(carlId);
  const peerId = makePeer('out3.example');
  const remoteMemberId = makeRemoteUser(peerId, 'remoteOut3', 'out3.example');
  const dmChannelId = db.prepare('INSERT INTO dm_channels (is_group, created_by) VALUES (0, ?)').run(carlId).lastInsertRowid;
  db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?), (?, ?)').run(dmChannelId, carlId, dmChannelId, remoteMemberId);
  const msgId = db.prepare(`INSERT INTO messages (scope_type, scope_id, author_id, content) VALUES ('dm', ?, ?, 'react to me')`).run(dmChannelId, remoteMemberId).lastInsertRowid;

  const longEmoji = encodeURIComponent(':'.repeat(100));
  await withMessagesServer(carl, async (base) => {
    const res = await fetch(`${base}/${msgId}/reactions/${longEmoji}`, { method: 'PUT' });
    assert.equal(res.status, 200);
  });

  const payload = latestOutboxPayload(peerId, 'dm_reaction_add');
  assert.ok(payload);
  assert.equal(payload.userUsername, 'carlReact');
  assert.ok(payload.emoji.length <= 34);
});

test('outbound: removing a reaction relays dm_reaction_remove with a capped emoji', async () => {
  const danaId = makeUser('danaUnreact');
  const dana = db.prepare('SELECT * FROM users WHERE id = ?').get(danaId);
  const peerId = makePeer('out4.example');
  const remoteMemberId = makeRemoteUser(peerId, 'remoteOut4', 'out4.example');
  const dmChannelId = db.prepare('INSERT INTO dm_channels (is_group, created_by) VALUES (0, ?)').run(danaId).lastInsertRowid;
  db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?), (?, ?)').run(dmChannelId, danaId, dmChannelId, remoteMemberId);
  const msgId = db.prepare(`INSERT INTO messages (scope_type, scope_id, author_id, content) VALUES ('dm', ?, ?, 'react to me too')`).run(dmChannelId, remoteMemberId).lastInsertRowid;
  db.prepare('INSERT INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)').run(msgId, danaId, '👍');

  const longEmoji = encodeURIComponent(':'.repeat(100));
  await withMessagesServer(dana, async (base) => {
    const res = await fetch(`${base}/${msgId}/reactions/${longEmoji}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
  });

  const payload = latestOutboxPayload(peerId, 'dm_reaction_remove');
  assert.ok(payload);
  assert.equal(payload.userUsername, 'danaUnreact');
  assert.ok(payload.emoji.length <= 34);
});

test('outbound: a purely local DM mutation never touches the federation outbox', async () => {
  const eveId = makeUser('eveLocalOnly');
  const eve = db.prepare('SELECT * FROM users WHERE id = ?').get(eveId);
  const frankId = makeUser('frankLocalOnly');
  const dmChannelId = db.prepare('INSERT INTO dm_channels (is_group, created_by) VALUES (0, ?)').run(eveId).lastInsertRowid;
  db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?), (?, ?)').run(dmChannelId, eveId, dmChannelId, frankId);
  const msgId = db.prepare(`INSERT INTO messages (scope_type, scope_id, author_id, content) VALUES ('dm', ?, ?, 'just us')`).run(dmChannelId, eveId).lastInsertRowid;

  const before = db.prepare('SELECT COUNT(*) AS n FROM federation_outbox').get().n;
  await withMessagesServer(eve, async (base) => {
    const res = await fetch(`${base}/${msgId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'edited locally' }),
    });
    assert.equal(res.status, 200);
  });
  const after = db.prepare('SELECT COUNT(*) AS n FROM federation_outbox').get().n;
  assert.equal(after, before);
});
