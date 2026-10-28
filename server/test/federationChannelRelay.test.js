'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const http = require('node:http');
const { spawn } = require('node:child_process');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;
const { db } = require('../db');

// Captured BEFORE federationApi.js/channelMessages.js are first required, so their destructured
// `broadcastToChannel` picks up this wrapped version — same technique
// federationDmEditDelete.test.js uses for broadcastToDm, lets tests assert on the exact wire
// shape sent to clients, not just resulting DB state.
const hub = require('../socket/hub');
const channelBroadcasts = [];
const realBroadcastToChannel = hub.broadcastToChannel;
hub.broadcastToChannel = (channel, payload, requiredFlag) => {
  channelBroadcasts.push({ channel, payload });
  return realBroadcastToChannel(channel, payload, requiredFlag);
};

const { inboxHandlers } = require('../routes/federationApi');
const channelMessagesRouter = require('../routes/channelMessages');
const { PERMISSIONS, DEFAULT_EVERYONE_PERMISSIONS } = require('../lib/permissions');
const { ownDomain } = require('../lib/federationOutboxWorker');
const { drainOnce } = require('../lib/federationOutboxWorker');
const { getOrCreateKeypair } = require('../lib/federationCrypto');

test.after(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

let uid = 0;
function makeUser(username) {
  uid += 1;
  return db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run(`${username}${uid}`, `${username}${uid}@test.local`, 'hash', username).lastInsertRowid;
}

function makePeer(domain) {
  return db.prepare(`INSERT INTO federation_peers (domain, public_url, their_pubkey, status) VALUES (?, ?, 'PEM', 'active')`)
    .run(domain, `https://${domain}`).lastInsertRowid;
}

function makeRemoteMember(peerId, username, domain, serverId) {
  const id = db.prepare(
    `INSERT INTO users (username, email, password_hash, display_name, home_instance_id, federated_uid) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(username, `${username}@remote.invalid`, 'x', username, peerId, `${username}@${domain}`).lastInsertRowid;
  if (serverId) db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(serverId, id);
  return id;
}

// ---------------------------------------------------------------------------
// The former architectural gap, now closed
// ---------------------------------------------------------------------------
//
// channels/servers/roles/server_members live only in a server's OWNING instance's database; a
// remote member's home instance never has a `channels` row for it. The owner->member direction
// therefore no longer reuses channel_message_create (which means "a remote member posts into a
// channel you own"): the owner fans out a remote_channel_event, and the member's home instance
// resolves it against its own remote_memberships ledger and pushes it to its local users. With two
// genuinely separate SQLite databases and a real signed HTTP delivery, this test proves the event
// lands (and only for the users the owner said may view the channel) while the home instance still
// stores no copy of the remote server's content.
test('a remote_channel_event fan-out reaches the member\'s home instance as a live push, storing nothing', async (t) => {
  const owner = makeUser('owner');
  const serverId = db.prepare(`INSERT INTO servers (name, owner_id, invite_code, visibility) VALUES ('Gap Server', ?, 'gap-code-1', 'public')`).run(owner).lastInsertRowid;
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(serverId, owner);
  db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 0, 1)').run(serverId, '@everyone', DEFAULT_EVERYONE_PERMISSIONS);
  const channelId = db.prepare(`INSERT INTO channels (server_id, name, type, position) VALUES (?, 'general', 'public', 0)`).run(serverId).lastInsertRowid;

  // Spawn the "remote member's home instance" R as a genuinely separate process with its OWN
  // fresh DISMESH_DATA_DIR — a real, from-scratch database distinct from O's.
  const remoteTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-remote-'));
  const ownerDomain = ownDomain();
  const ownerPubkeyPem = getOrCreateKeypair().publicKeyPem;
  const child = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'remoteChannelInstance.js')], {
    env: { ...process.env, DISMESH_DATA_DIR: remoteTmpDir, OWNER_DOMAIN: ownerDomain, OWNER_PUBKEY_PEM: ownerPubkeyPem, OWNER_SERVER_ID: String(serverId) },
  });
  t.after(async () => {
    await new Promise((resolve) => {
      child.once('exit', resolve);
      child.kill();
      setTimeout(resolve, 2000);
    });
    // Windows can briefly hold the dir's files locked for a moment after the process that opened
    // them exits; this cleanup is best-effort and not load-bearing for the test's own assertions.
    try { fs.rmSync(remoteTmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const remotePort = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
      const m = out.match(/PORT (\d+)/);
      if (m) resolve(Number(m[1]));
    });
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.on('exit', (code) => reject(new Error(`remote instance exited early with code ${code}`)));
  });
  const remoteBase = `http://127.0.0.1:${remotePort}`;

  // R's redeemed member, as redeemInvite creates it on O's own db: a server_members row on O whose
  // user row has home_instance_id = the peer representing R. Its R-side username is 'remoteJoiner'
  // (seeded as a local user with a ledger row on R); 'otherLocal' also joined this server on R but
  // is NOT a member on O, so O never lists it as a viewer.
  const remotePeerId = db.prepare(`INSERT INTO federation_peers (domain, public_url, their_pubkey, status) VALUES ('remote-member.example', ?, 'UNUSED', 'active')`)
    .run(remoteBase).lastInsertRowid;
  makeRemoteMember(remotePeerId, 'remoteJoiner', 'remote-member.example', serverId);

  const localAuthor = db.prepare('SELECT * FROM users WHERE id = ?').get(owner);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = localAuthor; next(); });
  app.use('/api/servers/:id/channels/:channelId/messages', channelMessagesRouter);
  const localServer = http.createServer(app);
  await new Promise((r) => localServer.listen(0, '127.0.0.1', r));
  t.after(() => localServer.close());
  const localBase = `http://127.0.0.1:${localServer.address().port}`;

  const postRes = await fetch(`${localBase}/api/servers/${serverId}/channels/${channelId}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'hello from the owning instance' }),
  });
  assert.equal(postRes.status, 201);

  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM federation_outbox WHERE peer_id = ? AND type = 'channel_message_create'`).get(remotePeerId).n, 0,
    'the owner->member direction must no longer reuse channel_message_create');
  const outboxRow = db.prepare(`SELECT * FROM federation_outbox WHERE peer_id = ? AND type = 'remote_channel_event'`).get(remotePeerId);
  assert.ok(outboxRow, 'the owner should have enqueued a remote_channel_event for the member\'s home instance');

  await drainOnce(fetch);
  assert.equal(db.prepare('SELECT status FROM federation_outbox WHERE id = ?').get(outboxRow.id).status, 'delivered');

  const state = await (await fetch(`${remoteBase}/debug/state`)).json();
  assert.equal(state.servers, 0, 'R still has no local servers row: nothing is mirrored');
  assert.equal(state.channels, 0, 'R still has no channels row: nothing is mirrored');
  assert.equal(state.channelMessages, 0, 'R stores no message content');
  assert.equal(state.pushed.length, 1, 'exactly one local user of R may see this channel');
  assert.equal(state.pushed[0].username, 'remoteJoiner');
  const event = state.pushed[0].payload;
  assert.equal(event.type, 'remote_channel_event');
  assert.equal(event.kind, 'message_create');
  assert.equal(event.serverId, serverId);
  assert.equal(event.channelId, channelId);
  assert.equal(event.message.content, 'hello from the owning instance');
  assert.equal(event.message.author.username, localAuthor.username);
});

// ---------------------------------------------------------------------------
// Brief's given tests
// ---------------------------------------------------------------------------

test('a remote member with SEND_MESSAGES can post; one without it is rejected', () => {
  const owner = makeUser('own3');
  const serverId = db.prepare(`INSERT INTO servers (name, owner_id, invite_code, visibility) VALUES ('S', ?, 'ic', 'public')`).run(owner).lastInsertRowid;
  db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 0, 1)').run(serverId, '@everyone', PERMISSIONS.VIEW_CHANNEL); // no SEND_MESSAGES
  const channelId = db.prepare(`INSERT INTO channels (server_id, name, type) VALUES (?, 'general', 'public')`).run(serverId).lastInsertRowid;

  const peerId = makePeer('o.example');
  const peer = { id: peerId, domain: 'o.example' };
  makeRemoteMember(peerId, 'rm', 'o.example', serverId);

  const denied = inboxHandlers.channel_message_create(peer, { channelId, remoteId: 1, username: 'rm', content: 'hi', channelMessageId: 'cm-1' });
  assert.equal(denied.ok, false);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE scope_type = 'channel' AND scope_id = ?`).get(channelId).n, 0);

  db.prepare('UPDATE roles SET permissions = ? WHERE server_id = ?').run(PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.SEND_MESSAGES, serverId);
  const allowed = inboxHandlers.channel_message_create(peer, { channelId, remoteId: 1, username: 'rm', content: 'hi', channelMessageId: 'cm-1' });
  assert.equal(allowed.ok, true);
  assert.equal(db.prepare(`SELECT content FROM messages WHERE scope_type = 'channel' AND scope_id = ?`).get(channelId).content, 'hi');
});

test('channel edit/delete/reaction target the message via (peer, federation_message_id)', () => {
  const owner = makeUser('own4');
  const serverId = db.prepare(`INSERT INTO servers (name, owner_id, invite_code, visibility) VALUES ('S2', ?, 'ic2', 'public')`).run(owner).lastInsertRowid;
  db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 0, 1)').run(serverId, '@everyone', PERMISSIONS.VIEW_CHANNEL);
  const channelId = db.prepare(`INSERT INTO channels (server_id, name, type) VALUES (?, 'general', 'public')`).run(serverId).lastInsertRowid;
  const peerId = makePeer('p2.example');
  const peer = { id: peerId, domain: 'p2.example' };
  const remoteAuthor = makeRemoteMember(peerId, 'rp', 'p2.example', serverId);
  const msgId = db.prepare(`INSERT INTO messages (scope_type, scope_id, author_id, content, federation_peer_id, federation_message_id) VALUES ('channel', ?, ?, 'orig', ?, 'cmsg-1')`)
    .run(channelId, remoteAuthor, peerId).lastInsertRowid;

  inboxHandlers.channel_message_edit(peer, { originMessageId: 'cmsg-1', content: 'edited' });
  assert.equal(db.prepare('SELECT content FROM messages WHERE id = ?').get(msgId).content, 'edited');

  inboxHandlers.channel_reaction_add(peer, { originMessageId: 'cmsg-1', userUsername: 'rp', emoji: '\u{1F525}' });
  assert.ok(db.prepare('SELECT 1 FROM message_reactions WHERE message_id = ? AND emoji = ?').get(msgId, '\u{1F525}'));

  inboxHandlers.channel_message_delete(peer, { originMessageId: 'cmsg-1' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE id = ?').get(msgId).n, 0);
});

test('a remote author who was removed from the server can no longer edit or delete old channel messages', () => {
  const owner = makeUser('ownKicked');
  const serverId = db.prepare(`INSERT INTO servers (name, owner_id, invite_code, visibility) VALUES ('Kicked', ?, 'kicked-code', 'public')`).run(owner).lastInsertRowid;
  db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 0, 1)').run(serverId, '@everyone', PERMISSIONS.VIEW_CHANNEL);
  const channelId = db.prepare(`INSERT INTO channels (server_id, name, type) VALUES (?, 'general', 'public')`).run(serverId).lastInsertRowid;
  const peerId = makePeer('kicked.example');
  const peer = { id: peerId, domain: 'kicked.example' };
  const remoteAuthor = makeRemoteMember(peerId, 'kickedUser', 'kicked.example', serverId);
  const msgId = db.prepare(`INSERT INTO messages (scope_type, scope_id, author_id, content, federation_peer_id, federation_message_id) VALUES ('channel', ?, ?, 'orig', ?, 'kicked-msg')`)
    .run(channelId, remoteAuthor, peerId).lastInsertRowid;
  inboxHandlers.channel_message_edit(peer, { originMessageId: 'kicked-msg', content: 'while-member' });
  assert.equal(db.prepare('SELECT content FROM messages WHERE id = ?').get(msgId).content, 'while-member');
  db.prepare('DELETE FROM server_members WHERE server_id = ? AND user_id = ?').run(serverId, remoteAuthor);

  inboxHandlers.channel_message_edit(peer, { originMessageId: 'kicked-msg', content: 'rewritten' });
  assert.equal(db.prepare('SELECT content FROM messages WHERE id = ?').get(msgId).content, 'while-member');
  inboxHandlers.channel_message_delete(peer, { originMessageId: 'kicked-msg' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE id = ?').get(msgId).n, 1);
});

// ---------------------------------------------------------------------------
// Secondary findings: content/emoji caps, missing-id rejection, broadcast shape, dedupe
// ---------------------------------------------------------------------------

test('inbound channel_message_create rejects a payload with no channelMessageId instead of inventing one', () => {
  const owner = makeUser('ownNoId');
  const serverId = db.prepare(`INSERT INTO servers (name, owner_id, invite_code, visibility) VALUES ('NoId', ?, 'noid-code', 'public')`).run(owner).lastInsertRowid;
  db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 0, 1)').run(serverId, '@everyone', PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.SEND_MESSAGES);
  const channelId = db.prepare(`INSERT INTO channels (server_id, name, type) VALUES (?, 'general', 'public')`).run(serverId).lastInsertRowid;
  const peerId = makePeer('noid.example');
  const peer = { id: peerId, domain: 'noid.example' };
  makeRemoteMember(peerId, 'noidUser', 'noid.example', serverId);

  const result = inboxHandlers.channel_message_create(peer, { channelId, remoteId: 1, username: 'noidUser', content: 'hi' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'missing channelMessageId');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE scope_type = 'channel' AND scope_id = ?`).get(channelId).n, 0);
});

test('inbound channel_message_create content is capped at 15000 chars, matching the local POST / route', () => {
  const owner = makeUser('ownCap');
  const serverId = db.prepare(`INSERT INTO servers (name, owner_id, invite_code, visibility) VALUES ('Cap', ?, 'cap-code', 'public')`).run(owner).lastInsertRowid;
  db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 0, 1)').run(serverId, '@everyone', PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.SEND_MESSAGES);
  const channelId = db.prepare(`INSERT INTO channels (server_id, name, type) VALUES (?, 'general', 'public')`).run(serverId).lastInsertRowid;
  const peerId = makePeer('cap.example');
  const peer = { id: peerId, domain: 'cap.example' };
  makeRemoteMember(peerId, 'capUser', 'cap.example', serverId);

  const longContent = 'x'.repeat(20000);
  const result = inboxHandlers.channel_message_create(peer, { channelId, remoteId: 1, username: 'capUser', content: longContent, channelMessageId: 'cap-1' });
  assert.equal(result.ok, true);
  assert.equal(result.message.content.length, 15000);
});

test('inbound channel_message_edit content is capped at 15000 and an empty-after-trim edit is dropped', () => {
  const owner = makeUser('ownEditCap');
  const serverId = db.prepare(`INSERT INTO servers (name, owner_id, invite_code, visibility) VALUES ('EditCap', ?, 'editcap-code', 'public')`).run(owner).lastInsertRowid;
  db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 0, 1)').run(serverId, '@everyone', PERMISSIONS.VIEW_CHANNEL);
  const channelId = db.prepare(`INSERT INTO channels (server_id, name, type) VALUES (?, 'general', 'public')`).run(serverId).lastInsertRowid;
  const peerId = makePeer('editcap.example');
  const peer = { id: peerId, domain: 'editcap.example' };
  const remoteAuthor = makeRemoteMember(peerId, 'editCapUser', 'editcap.example', serverId);
  const msgId = db.prepare(`INSERT INTO messages (scope_type, scope_id, author_id, content, federation_peer_id, federation_message_id) VALUES ('channel', ?, ?, 'keep-me', ?, 'editcap-msg')`)
    .run(channelId, remoteAuthor, peerId).lastInsertRowid;

  inboxHandlers.channel_message_edit(peer, { originMessageId: 'editcap-msg', content: 'y'.repeat(20000) });
  assert.equal(db.prepare('SELECT content FROM messages WHERE id = ?').get(msgId).content.length, 15000);

  inboxHandlers.channel_message_edit(peer, { originMessageId: 'editcap-msg', content: '   ' });
  assert.equal(db.prepare('SELECT content FROM messages WHERE id = ?').get(msgId).content.length, 15000, 'blank-after-trim edit must be dropped, not applied');
});

test('inbound channel_reaction_add/remove emoji is capped at 34 chars', () => {
  const owner = makeUser('ownEmojiCap');
  const serverId = db.prepare(`INSERT INTO servers (name, owner_id, invite_code, visibility) VALUES ('EmojiCap', ?, 'emojicap-code', 'public')`).run(owner).lastInsertRowid;
  const channelId = db.prepare(`INSERT INTO channels (server_id, name, type) VALUES (?, 'general', 'public')`).run(serverId).lastInsertRowid;
  const peerId = makePeer('emojicap.example');
  const peer = { id: peerId, domain: 'emojicap.example' };
  const remoteAuthor = makeRemoteMember(peerId, 'emojiCapUser', 'emojicap.example', null);
  const msgId = db.prepare(`INSERT INTO messages (scope_type, scope_id, author_id, content, federation_peer_id, federation_message_id) VALUES ('channel', ?, ?, 'x', ?, 'emojicap-msg')`)
    .run(channelId, remoteAuthor, peerId).lastInsertRowid;

  inboxHandlers.channel_reaction_add(peer, { originMessageId: 'emojicap-msg', userUsername: 'emojiCapUser', emoji: 'z'.repeat(100) });
  const stored = db.prepare('SELECT emoji FROM message_reactions WHERE message_id = ?').get(msgId);
  assert.equal(stored.emoji.length, 34);

  inboxHandlers.channel_reaction_remove(peer, { originMessageId: 'emojicap-msg', userUsername: 'emojiCapUser', emoji: 'z'.repeat(100) });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM message_reactions WHERE message_id = ?').get(msgId).n, 0);
});

test('broadcast shapes for channel create/edit/reaction/delete all use serializeMessage, matching what the client listens for', () => {
  channelBroadcasts.length = 0;
  const owner = makeUser('ownShape');
  const serverId = db.prepare(`INSERT INTO servers (name, owner_id, invite_code, visibility) VALUES ('Shape', ?, 'shape-code', 'public')`).run(owner).lastInsertRowid;
  db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 0, 1)').run(serverId, '@everyone', PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.SEND_MESSAGES);
  const channelId = db.prepare(`INSERT INTO channels (server_id, name, type) VALUES (?, 'general', 'public')`).run(serverId).lastInsertRowid;
  const peerId = makePeer('shape.example');
  const peer = { id: peerId, domain: 'shape.example' };
  makeRemoteMember(peerId, 'shapeUser', 'shape.example', serverId);

  const created = inboxHandlers.channel_message_create(peer, { channelId, remoteId: 1, username: 'shapeUser', content: 'hi', channelMessageId: 'shape-1' });
  assert.equal(created.ok, true);
  let last = channelBroadcasts[channelBroadcasts.length - 1];
  assert.equal(last.payload.type, 'message_create');
  assert.equal(last.payload.message.scopeType, 'channel');
  assert.equal(last.payload.message.scopeId, channelId);

  inboxHandlers.channel_message_edit(peer, { originMessageId: 'shape-1', content: 'edited' });
  last = channelBroadcasts[channelBroadcasts.length - 1];
  assert.equal(last.payload.type, 'message_update');
  assert.equal(last.payload.message.scopeType, 'channel');

  inboxHandlers.channel_reaction_add(peer, { originMessageId: 'shape-1', userUsername: 'shapeUser', emoji: '\u{1F44D}' });
  last = channelBroadcasts[channelBroadcasts.length - 1];
  assert.equal(last.payload.type, 'message_update');
  assert.ok(last.payload.message.reactions.some((r) => r.emoji === '\u{1F44D}'));

  inboxHandlers.channel_reaction_remove(peer, { originMessageId: 'shape-1', userUsername: 'shapeUser', emoji: '\u{1F44D}' });

  inboxHandlers.channel_message_delete(peer, { originMessageId: 'shape-1' });
  last = channelBroadcasts[channelBroadcasts.length - 1];
  assert.equal(last.payload.type, 'message_delete');
  assert.equal(last.payload.scopeType, 'channel');
  assert.equal(last.payload.scopeId, channelId);
});

test('outbound: a local channel post enqueues remote_channel_event once per distinct remote home instance, content capped', async () => {
  const owner = makeUser('ownOut');
  const localAuthor = db.prepare('SELECT * FROM users WHERE id = ?').get(owner);
  const serverId = db.prepare(`INSERT INTO servers (name, owner_id, invite_code, visibility) VALUES ('Out', ?, 'out-code', 'public')`).run(owner).lastInsertRowid;
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(serverId, owner);
  db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 0, 1)').run(serverId, '@everyone', DEFAULT_EVERYONE_PERMISSIONS);
  const channelId = db.prepare(`INSERT INTO channels (server_id, name, type, position) VALUES (?, 'general', 'public', 0)`).run(serverId).lastInsertRowid;

  const peerId = makePeer('out.example');
  // Two remote members, SAME remote home instance: must still produce only one outbox row.
  makeRemoteMember(peerId, 'outUserA', 'out.example', serverId);
  makeRemoteMember(peerId, 'outUserB', 'out.example', serverId);

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = localAuthor; next(); });
  app.use('/api/servers/:id/channels/:channelId/messages', channelMessagesRouter);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/servers/${serverId}/channels/${channelId}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'x'.repeat(20000) }),
    });
    assert.equal(res.status, 201);
    const rows = db.prepare(`SELECT * FROM federation_outbox WHERE peer_id = ? AND type = 'remote_channel_event'`).all(peerId);
    assert.equal(rows.length, 1, 'one outbox row per distinct remote home instance, not per remote member');
    const payload = JSON.parse(rows[0].payload_json);
    assert.equal(payload.kind, 'message_create');
    assert.equal(payload.message.content.length, 15000);
    assert.equal(payload.channelId, channelId);
    assert.equal(payload.serverId, serverId);
    assert.equal(payload.message.id, (await res.json()).message.id);
    assert.deepEqual([...payload.viewers].sort(), ['outUserA', 'outUserB']);
  } finally {
    server.close();
  }
});
