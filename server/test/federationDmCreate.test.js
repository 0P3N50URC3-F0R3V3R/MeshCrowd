'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;
const { db } = require('../db');
const { inboxHandlers } = require('../routes/federationApi');

test.after(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

function makeUser(username) {
  return db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run(username, `${username}@test.local`, 'hash', username).lastInsertRowid;
}

test('inbound dm_message_create writes a message visible to the local participant', () => {
  const localId = makeUser('localdave');
  const peerId = db.prepare(`INSERT INTO federation_peers (domain, public_url, their_pubkey, status) VALUES ('i.example', 'https://i', 'PEM', 'active')`).run().lastInsertRowid;
  const peer = { id: peerId, domain: 'i.example' };

  inboxHandlers.dm_message_create(peer, {
    fromRemoteId: 9, fromUsername: 'remoteEve', displayName: 'Eve',
    participants: ['localdave', 'remoteEve@i.example'], // local usernames as-is, remote as username@domain
    content: 'hi from another instance', attachments: [],
    dmMessageId: 'abc-123',
  });

  const remote = db.prepare('SELECT * FROM users WHERE federated_uid = ?').get('remoteEve@i.example');
  const dmChannel = db.prepare(
    `SELECT dc.* FROM dm_channels dc
       JOIN dm_members m1 ON m1.dm_channel_id = dc.id AND m1.user_id = ?
       JOIN dm_members m2 ON m2.dm_channel_id = dc.id AND m2.user_id = ?`
  ).get(localId, remote.id);
  assert.ok(dmChannel);
  const message = db.prepare(`SELECT * FROM messages WHERE scope_type = 'dm' AND scope_id = ?`).get(dmChannel.id);
  assert.equal(message.content, 'hi from another instance');
  assert.equal(message.author_id, remote.id);
  assert.equal(message.federation_message_id, 'abc-123');
});

// Covers the outbound side added to dms.js (server/routes/dms.js's relayDmMessageCreate /
// federatedDmParticipants) — not given verbatim in the brief, and substantially rewritten from the
// brief's literal code because of a critical bug: the brief qualified a genuinely-local member as
// bare and a remote-cached member with its OWN home domain regardless of destination, which is
// backwards from what the receiving inboxHandlers.dm_message_create's resolveParticipant expects
// (bare = local to the RECEIVER, "name@domain" = the domain of the SENDER). That made participants
// resolve to an empty list on the receiving end for every case, including the plain 2-party one.
const express = require('express');
const http = require('node:http');
const dmsRouter = require('../routes/dms');
const { ownDomain } = require('../lib/federationOutboxWorker');

async function withDmsServer(user, fn) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = user; next(); });
  app.use('/dms', dmsRouter);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${server.address().port}/dms`); } finally { server.close(); }
}

function makeRemoteCacheUser(peerId, placeholderUsername, realUsername, domain) {
  return db.prepare(
    `INSERT INTO users (username, email, password_hash, display_name, home_instance_id, remote_user_id, federated_uid)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(placeholderUsername, `${placeholderUsername}@remote.invalid`, 'x', realUsername, peerId, 99, `${realUsername}@${domain}`).lastInsertRowid;
}

test('outbound: posting a DM message relays dm_message_create with correctly-qualified participants and base64 attachments', async () => {
  const aliceId = makeUser('aliceDm');
  const alice = db.prepare('SELECT * FROM users WHERE id = ?').get(aliceId);
  const peerId = db.prepare(`INSERT INTO federation_peers (domain, public_url, their_pubkey, status) VALUES ('remote-dm.example', 'https://r', 'PEM', 'active')`).run().lastInsertRowid;
  const carolCacheId = makeRemoteCacheUser(peerId, 'remote_carolplaceholder', 'carolReal', 'remote-dm.example');

  const chInfo = db.prepare('INSERT INTO dm_channels (is_group, created_by) VALUES (0, ?)').run(aliceId);
  const dmId = chInfo.lastInsertRowid;
  db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?), (?, ?)').run(dmId, aliceId, dmId, carolCacheId);

  let messageId;
  await withDmsServer(alice, async (base) => {
    const form = new FormData();
    form.append('content', 'hello with attachment');
    form.append('files', new Blob([Buffer.from('hello-bytes')], { type: 'text/plain' }), 'note.txt');
    const res = await fetch(`${base}/${dmId}/messages`, { method: 'POST', body: form });
    assert.equal(res.status, 201);
    const body = await res.json();
    messageId = body.message.id;
  });

  const outboxRow = db.prepare(`SELECT * FROM federation_outbox WHERE peer_id = ? AND type = 'dm_message_create'`).get(peerId);
  assert.ok(outboxRow);
  const payload = JSON.parse(outboxRow.payload_json);
  assert.equal(payload.fromRemoteId, aliceId);
  assert.equal(payload.fromUsername, 'aliceDm');
  assert.equal(payload.content, 'hello with attachment');
  assert.equal(payload.dmMessageId, String(messageId));
  assert.deepEqual([...payload.participants].sort(), [`aliceDm@${ownDomain()}`, 'carolReal'].sort());
  assert.equal(payload.attachments.length, 1);
  assert.equal(payload.attachments[0].fileName, 'note.txt');
  assert.equal(payload.attachments[0].mimeType, 'text/plain');
  assert.equal(Buffer.from(payload.attachments[0].dataBase64, 'base64').toString('utf8'), 'hello-bytes');
});

test('outbound: a purely local DM never touches the federation outbox', async () => {
  const danId = makeUser('danDm');
  const dan = db.prepare('SELECT * FROM users WHERE id = ?').get(danId);
  const eveId = makeUser('eveDm');

  const chInfo = db.prepare('INSERT INTO dm_channels (is_group, created_by) VALUES (0, ?)').run(danId);
  const dmId = chInfo.lastInsertRowid;
  db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?), (?, ?)').run(dmId, danId, dmId, eveId);

  const before = db.prepare('SELECT COUNT(*) AS n FROM federation_outbox').get().n;
  await withDmsServer(dan, async (base) => {
    const res = await fetch(`${base}/${dmId}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'just between us' }),
    });
    assert.equal(res.status, 201);
  });
  const after = db.prepare('SELECT COUNT(*) AS n FROM federation_outbox').get().n;
  assert.equal(after, before);
});

test('full relay round trip: the outbox payload, fed into the receiving inbox handler, creates a message visible to both sides', async () => {
  const finId = makeUser('finnDm');
  const fin = db.prepare('SELECT * FROM users WHERE id = ?').get(finId);
  const peerId = db.prepare(`INSERT INTO federation_peers (domain, public_url, their_pubkey, status) VALUES ('round-dm.example', 'https://rd', 'PEM', 'active')`).run().lastInsertRowid;
  const graceCacheId = makeRemoteCacheUser(peerId, 'remote_graceplaceholder', 'graceReal', 'round-dm.example');
  // graceReal's genuine local account on "round-dm.example" (the far side of this relay) — this is
  // who should actually resolve when the outbox payload's bare 'graceReal' participant is delivered.
  makeUser('graceReal');

  const chInfo = db.prepare('INSERT INTO dm_channels (is_group, created_by) VALUES (0, ?)').run(finId);
  const dmId = chInfo.lastInsertRowid;
  db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?), (?, ?)').run(dmId, finId, dmId, graceCacheId);

  await withDmsServer(fin, async (base) => {
    const res = await fetch(`${base}/${dmId}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'round trip hello' }),
    });
    assert.equal(res.status, 201);
  });
  const outboxRow = db.prepare(`SELECT * FROM federation_outbox WHERE peer_id = ? AND type = 'dm_message_create' ORDER BY id DESC LIMIT 1`).get(peerId);
  const payload = JSON.parse(outboxRow.payload_json);

  // Delivered as the real receiver would see it: `peer.domain` is OUR domain, since that's how we
  // registered ourselves with them (see middleware/federationVerify.js: looked up by origin_domain).
  inboxHandlers.dm_message_create({ id: peerId, domain: ownDomain() }, payload);

  const finCache = db.prepare('SELECT * FROM users WHERE federated_uid = ?').get(`finnDm@${ownDomain()}`);
  assert.ok(finCache, 'fin should now exist as a remote-cache user on the receiving side');
  const graceReal = db.prepare('SELECT * FROM users WHERE username = ?').get('graceReal');
  const farDmChannel = db.prepare(
    `SELECT dc.* FROM dm_channels dc
       JOIN dm_members m1 ON m1.dm_channel_id = dc.id AND m1.user_id = ?
       JOIN dm_members m2 ON m2.dm_channel_id = dc.id AND m2.user_id = ?`
  ).get(finCache.id, graceReal.id);
  assert.ok(farDmChannel, 'both participants must have resolved — this is exactly what the backwards bare/qualified logic broke');
  const farMessage = db.prepare(`SELECT * FROM messages WHERE scope_type = 'dm' AND scope_id = ?`).get(farDmChannel.id);
  assert.equal(farMessage.content, 'round trip hello');
  assert.equal(farMessage.author_id, finCache.id);
});

// Post-review fixes: inbound dm_message_create previously created a brand-new dm_channels/
// dm_members row for any resolvable participant set with no privacy/consent gate at all, and
// applied none of the local POST path's content/attachment bounds. Regression tests below.
function pairKeyLocal(a, b) { return a < b ? [a, b] : [b, a]; }
const siteSettings = require('../lib/siteSettings');

test('a local user with dm_privacy "none" is never enrolled in a brand-new federated DM, and the message is dropped when they are the only local recipient', () => {
  const quietId = makeUser('quietLocal');
  db.prepare(`UPDATE users SET dm_privacy = 'none' WHERE id = ?`).run(quietId);
  const peerId = db.prepare(`INSERT INTO federation_peers (domain, public_url, their_pubkey, status) VALUES ('privacy1.example', 'https://p1', 'PEM', 'active')`).run().lastInsertRowid;
  const peer = { id: peerId, domain: 'privacy1.example' };

  const messagesBefore = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
  inboxHandlers.dm_message_create(peer, {
    fromRemoteId: 1, fromUsername: 'pushyRemote', displayName: 'Pushy',
    participants: ['quietLocal', 'pushyRemote@privacy1.example'],
    content: 'let me in', attachments: [], dmMessageId: 'priv-1',
  });

  const remote = db.prepare('SELECT * FROM users WHERE federated_uid = ?').get('pushyRemote@privacy1.example');
  const channel = db.prepare(
    `SELECT dc.* FROM dm_channels dc JOIN dm_members m ON m.dm_channel_id = dc.id AND m.user_id = ?`
  ).get(remote.id);
  assert.equal(channel, undefined, 'no channel should have been created at all');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, messagesBefore, 'no message should have been written');
  assert.equal(db.prepare('SELECT 1 FROM dm_members WHERE user_id = ?').get(quietId), undefined, 'the private user must never be enrolled as a dm_member');
});

test('a local user who has blocked the remote author is dropped from a new federated DM, not silently enrolled', () => {
  const blockerId = makeUser('blockerLocal');
  const peerId = db.prepare(`INSERT INTO federation_peers (domain, public_url, their_pubkey, status) VALUES ('privacy2.example', 'https://p2', 'PEM', 'active')`).run().lastInsertRowid;
  // Pre-create the remote author's cache row so we can establish a 'blocked' friendship with it
  // before the event arrives (resolveOrCreateRemoteUser will find and reuse this exact row).
  const remoteCacheId = makeRemoteCacheUser(peerId, 'remote_blockedplaceholder', 'blockedRemote', 'privacy2.example');
  const [a, b] = pairKeyLocal(blockerId, remoteCacheId);
  db.prepare('INSERT INTO friendships (user_a, user_b, status, requested_by) VALUES (?, ?, ?, ?)').run(a, b, 'blocked', blockerId);

  inboxHandlers.dm_message_create({ id: peerId, domain: 'privacy2.example' }, {
    fromRemoteId: 1, fromUsername: 'blockedRemote', displayName: 'Blocked',
    participants: ['blockerLocal', 'blockedRemote@privacy2.example'],
    content: 'still trying', attachments: [], dmMessageId: 'priv-2',
  });

  assert.equal(db.prepare('SELECT 1 FROM dm_members WHERE user_id = ?').get(blockerId), undefined, 'the blocking user must never be enrolled');
  assert.equal(
    db.prepare(`SELECT * FROM messages WHERE federation_message_id = 'priv-2'`).get(),
    undefined,
    'no message should have been written — the only local recipient was dropped',
  );
});

test('in a group DM, a blocked local member is dropped while another local member still receives the channel and message', () => {
  const blockerId = makeUser('groupBlocker');
  const openId = makeUser('groupOpen');
  const peerId = db.prepare(`INSERT INTO federation_peers (domain, public_url, their_pubkey, status) VALUES ('privacy3.example', 'https://p3', 'PEM', 'active')`).run().lastInsertRowid;
  const remoteCacheId = makeRemoteCacheUser(peerId, 'remote_groupplaceholder', 'groupRemote', 'privacy3.example');
  const [a, b] = pairKeyLocal(blockerId, remoteCacheId);
  db.prepare('INSERT INTO friendships (user_a, user_b, status, requested_by) VALUES (?, ?, ?, ?)').run(a, b, 'blocked', blockerId);

  inboxHandlers.dm_message_create({ id: peerId, domain: 'privacy3.example' }, {
    fromRemoteId: 1, fromUsername: 'groupRemote', displayName: 'Group',
    participants: ['groupBlocker', 'groupOpen', 'groupRemote@privacy3.example'],
    content: 'hi group', attachments: [], dmMessageId: 'priv-3',
  });

  const remote = db.prepare('SELECT * FROM users WHERE federated_uid = ?').get('groupRemote@privacy3.example');
  const channel = db.prepare(
    `SELECT dc.* FROM dm_channels dc
       JOIN dm_members m1 ON m1.dm_channel_id = dc.id AND m1.user_id = ?
       JOIN dm_members m2 ON m2.dm_channel_id = dc.id AND m2.user_id = ?`
  ).get(openId, remote.id);
  assert.ok(channel, 'the non-blocking local member should still get the channel');
  assert.equal(db.prepare('SELECT 1 FROM dm_members WHERE dm_channel_id = ? AND user_id = ?').get(channel.id, blockerId), undefined, 'the blocking member must be excluded from it');
  const message = db.prepare(`SELECT * FROM messages WHERE federation_message_id = 'priv-3'`).get();
  assert.ok(message);
  assert.equal(message.scope_id, channel.id);
});

test('inbound content longer than 15000 chars is truncated, matching the local POST path cap', () => {
  const localId = makeUser('capLocal');
  const peerId = db.prepare(`INSERT INTO federation_peers (domain, public_url, their_pubkey, status) VALUES ('bounds1.example', 'https://b1', 'PEM', 'active')`).run().lastInsertRowid;

  inboxHandlers.dm_message_create({ id: peerId, domain: 'bounds1.example' }, {
    fromRemoteId: 1, fromUsername: 'longWriter', displayName: 'Long',
    participants: ['capLocal', 'longWriter@bounds1.example'],
    content: 'x'.repeat(20000), attachments: [], dmMessageId: 'bounds-1',
  });

  const message = db.prepare(`SELECT * FROM messages WHERE federation_message_id = 'bounds-1'`).get();
  assert.ok(message);
  assert.equal(message.content.length, 15000);
});

test('an attachment with a blocked extension is dropped, not written to disk or the DB', () => {
  const localId = makeUser('extLocal');
  const peerId = db.prepare(`INSERT INTO federation_peers (domain, public_url, their_pubkey, status) VALUES ('bounds2.example', 'https://b2', 'PEM', 'active')`).run().lastInsertRowid;

  inboxHandlers.dm_message_create({ id: peerId, domain: 'bounds2.example' }, {
    fromRemoteId: 1, fromUsername: 'exeSender', displayName: 'Exe',
    participants: ['extLocal', 'exeSender@bounds2.example'],
    content: 'see attached', attachments: [{ fileName: 'virus.exe', mimeType: 'application/octet-stream', dataBase64: Buffer.from('payload').toString('base64') }],
    dmMessageId: 'bounds-2',
  });

  const message = db.prepare(`SELECT * FROM messages WHERE federation_message_id = 'bounds-2'`).get();
  assert.ok(message, 'the text content should still be written');
  const attachments = db.prepare('SELECT * FROM attachments WHERE message_id = ?').all(message.id);
  assert.equal(attachments.length, 0);
});

test('an attachment over the effective max upload size is dropped', () => {
  const localId = makeUser('sizeLocal');
  const peerId = db.prepare(`INSERT INTO federation_peers (domain, public_url, their_pubkey, status) VALUES ('bounds3.example', 'https://b3', 'PEM', 'active')`).run().lastInsertRowid;
  const previousCap = siteSettings.getMaxUploadMb();
  siteSettings.setMaxUploadMb(0.0001); // ~105 bytes
  try {
    inboxHandlers.dm_message_create({ id: peerId, domain: 'bounds3.example' }, {
      fromRemoteId: 1, fromUsername: 'bigSender', displayName: 'Big',
      participants: ['sizeLocal', 'bigSender@bounds3.example'],
      content: 'see attached', attachments: [{ fileName: 'big.txt', mimeType: 'text/plain', dataBase64: Buffer.from('a'.repeat(1000)).toString('base64') }],
      dmMessageId: 'bounds-3',
    });
  } finally {
    siteSettings.setMaxUploadMb(previousCap);
  }

  const message = db.prepare(`SELECT * FROM messages WHERE federation_message_id = 'bounds-3'`).get();
  assert.ok(message);
  const attachments = db.prepare('SELECT * FROM attachments WHERE message_id = ?').all(message.id);
  assert.equal(attachments.length, 0);
});
