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

test('inbound friend_request creates a pending friendship against the resolved remote user', () => {
  const localUserId = makeUser('localbob');
  const peerId = db.prepare(`INSERT INTO federation_peers (domain, public_url, their_pubkey, status) VALUES ('g.example', 'https://g', 'PEM', 'active')`).run().lastInsertRowid;
  const peer = { id: peerId, domain: 'g.example' };

  inboxHandlers.friend_request({ ...peer }, { fromRemoteId: 7, fromUsername: 'remoteAlice', displayName: 'Alice', toUsername: 'localbob' });

  const remote = db.prepare('SELECT * FROM users WHERE federated_uid = ?').get('remoteAlice@g.example');
  assert.ok(remote);
  const friendship = db.prepare('SELECT * FROM friendships WHERE (user_a = ? AND user_b = ?) OR (user_a = ? AND user_b = ?)')
    .get(localUserId, remote.id, remote.id, localUserId);
  assert.ok(friendship);
  assert.equal(friendship.status, 'pending');
  assert.equal(friendship.requested_by, remote.id);
});

// append to server/test/federationFriends.test.js
const { enqueueEvent } = require('../lib/federationOutbox');

test('requesting user@domain enqueues a friend_request instead of 404ing', () => {
  // This exercises the branch added to friends.js: a username containing "@" is treated as
  // federated and, if the domain matches an active peer, enqueues rather than looking up locally.
  const peerId = db.prepare(`INSERT INTO federation_peers (domain, public_url, their_pubkey, status) VALUES ('h.example', 'https://h', 'PEM', 'active')`).run().lastInsertRowid;
  const { isFederatedTarget, sendFriendRequestEvent } = require('../lib/federationFriendsOutbound');
  const parsed = isFederatedTarget('carol@h.example');
  assert.deepEqual(parsed, { username: 'carol', domain: 'h.example', peerId });

  sendFriendRequestEvent(peerId, { fromRemoteId: 1, fromUsername: 'me', toUsername: 'carol' });
  const row = db.prepare(`SELECT * FROM federation_outbox WHERE peer_id = ? AND type = 'friend_request'`).get(peerId);
  assert.ok(row);
});

// Covers the accept/remove branches added to friends.js — not spelled out verbatim in the brief,
// so exercised here via the real routes to confirm the local row still updates AND the peer gets
// notified when the other party in the friendship is a federated cache row.
const express = require('express');
const http = require('node:http');
const friendsRouter = require('../routes/friends');

async function withFriendsServer(user, fn) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = user; next(); });
  app.use('/friends', friendsRouter);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}

function makeRemoteCacheUser(peerId, remoteUsername, domain) {
  return db.prepare(
    `INSERT INTO users (username, email, password_hash, display_name, home_instance_id, remote_user_id, federated_uid)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(`remote_${remoteUsername}`, `remote_${remoteUsername}@remote.invalid`, 'x', remoteUsername, peerId, 99, `${remoteUsername}@${domain}`).lastInsertRowid;
}

test('accepting a pending request from a federated cache user updates locally and enqueues friend_accept to their peer', async () => {
  const localId = makeUser('dana');
  const local = db.prepare('SELECT * FROM users WHERE id = ?').get(localId);
  const peerId = db.prepare(`INSERT INTO federation_peers (domain, public_url, their_pubkey, status) VALUES ('i.example', 'https://i', 'PEM', 'active')`).run().lastInsertRowid;
  const remoteId = makeRemoteCacheUser(peerId, 'carol', 'i.example');
  const [a, b] = remoteId < localId ? [remoteId, localId] : [localId, remoteId];
  db.prepare('INSERT INTO friendships (user_a, user_b, status, requested_by) VALUES (?, ?, ?, ?)').run(a, b, 'pending', remoteId);

  await withFriendsServer(local, async (base) => {
    const res = await fetch(`${base}/friends/${remoteId}/accept`, { method: 'POST' });
    assert.equal(res.status, 200);
  });

  const friendship = db.prepare('SELECT * FROM friendships WHERE user_a = ? AND user_b = ?').get(a, b);
  assert.equal(friendship.status, 'accepted');
  const outboxRow = db.prepare(`SELECT * FROM federation_outbox WHERE peer_id = ? AND type = 'friend_accept'`).get(peerId);
  assert.ok(outboxRow);
  assert.deepEqual(JSON.parse(outboxRow.payload_json), { fromRemoteId: localId, fromUsername: 'dana', toUsername: 'carol' });
});

test('removing a friendship with a federated cache user deletes locally and enqueues friend_remove to their peer', async () => {
  const localId = makeUser('erin');
  const local = db.prepare('SELECT * FROM users WHERE id = ?').get(localId);
  const peerId = db.prepare(`INSERT INTO federation_peers (domain, public_url, their_pubkey, status) VALUES ('j.example', 'https://j', 'PEM', 'active')`).run().lastInsertRowid;
  const remoteId = makeRemoteCacheUser(peerId, 'frank', 'j.example');
  const [a, b] = remoteId < localId ? [remoteId, localId] : [localId, remoteId];
  db.prepare('INSERT INTO friendships (user_a, user_b, status, requested_by) VALUES (?, ?, ?, ?)').run(a, b, 'accepted', localId);

  await withFriendsServer(local, async (base) => {
    const res = await fetch(`${base}/friends/${remoteId}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
  });

  const friendship = db.prepare('SELECT * FROM friendships WHERE user_a = ? AND user_b = ?').get(a, b);
  assert.equal(friendship, undefined);
  const outboxRow = db.prepare(`SELECT * FROM federation_outbox WHERE peer_id = ? AND type = 'friend_remove'`).get(peerId);
  assert.ok(outboxRow);
  assert.deepEqual(JSON.parse(outboxRow.payload_json), { fromRemoteId: localId, fromUsername: 'erin', toUsername: 'frank' });
});

test('local (non-federated) accept/remove branches are unaffected', async () => {
  const aliceId = makeUser('alice2');
  const bobId = makeUser('bob2');
  const alice = db.prepare('SELECT * FROM users WHERE id = ?').get(aliceId);
  const [x, y] = pairKeyLocal(aliceId, bobId);
  db.prepare('INSERT INTO friendships (user_a, user_b, status, requested_by) VALUES (?, ?, ?, ?)').run(x, y, 'pending', bobId);

  await withFriendsServer(alice, async (base) => {
    const res = await fetch(`${base}/friends/${bobId}/accept`, { method: 'POST' });
    assert.equal(res.status, 200);
  });
  const friendship = db.prepare('SELECT * FROM friendships WHERE user_a = ? AND user_b = ?').get(x, y);
  assert.equal(friendship.status, 'accepted');

  await withFriendsServer(alice, async (base) => {
    const res = await fetch(`${base}/friends/${bobId}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
  });
  assert.equal(db.prepare('SELECT * FROM friendships WHERE user_a = ? AND user_b = ?').get(x, y), undefined);
});

function pairKeyLocal(a, b) { return a < b ? [a, b] : [b, a]; }

// Full round trip across two simulated instances (A and H) sharing this one test DB, distinguished
// only by which federation_peers row stands for "the other side" from each perspective. Regression
// test for the bug where friend_accept's plain UPDATE silently no-op'd on the requester's instance
// because that instance never had a local friendship row to update (POST /request's federated
// branch is fire-and-forget) — it must upsert instead.
test('friend request/accept round trip closes the loop: the requesting instance ends up with an accepted row', async () => {
  // From A's point of view, H is a peer; from H's point of view, A is a peer. Same underlying
  // federation_peers table, two rows, one per direction.
  const peerAtoH = db.prepare(`INSERT INTO federation_peers (domain, public_url, their_pubkey, status) VALUES ('round-h.example', 'https://h', 'PEM', 'active')`).run().lastInsertRowid;
  const peerHtoA = db.prepare(`INSERT INTO federation_peers (domain, public_url, their_pubkey, status) VALUES ('round-a.example', 'https://a', 'PEM', 'active')`).run().lastInsertRowid;

  const aaronId = makeUser('aaron'); // local user on instance A
  const aaron = db.prepare('SELECT * FROM users WHERE id = ?').get(aaronId);
  const harrietId = makeUser('harriet'); // local user on instance H

  // Step 1 (on A): aaron requests harriet@round-h.example via the real route. Fire-and-forget —
  // no local row on A yet.
  let requestPayload;
  await withFriendsServer(aaron, async (base) => {
    const res = await fetch(`${base}/friends/request`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'harriet@round-h.example' }),
    });
    assert.equal(res.status, 202);
  });
  const requestOutboxRow = db.prepare(
    `SELECT * FROM federation_outbox WHERE peer_id = ? AND type = 'friend_request' ORDER BY id DESC LIMIT 1`
  ).get(peerAtoH);
  assert.ok(requestOutboxRow);
  requestPayload = JSON.parse(requestOutboxRow.payload_json);
  assert.deepEqual(requestPayload, { fromRemoteId: aaronId, fromUsername: 'aaron', toUsername: 'harriet' });

  // Step 2 (on H): that event is delivered — feed it straight into H's inbound handler.
  inboxHandlers.friend_request(db.prepare('SELECT * FROM federation_peers WHERE id = ?').get(peerHtoA), requestPayload);
  const aaronCache = db.prepare('SELECT * FROM users WHERE federated_uid = ?').get('aaron@round-a.example');
  assert.ok(aaronCache);
  const hSidePending = db.prepare('SELECT * FROM friendships WHERE (user_a = ? AND user_b = ?) OR (user_a = ? AND user_b = ?)')
    .get(harrietId, aaronCache.id, aaronCache.id, harrietId);
  assert.equal(hSidePending.status, 'pending');

  // Step 3 (on H): harriet accepts via the real route, which enqueues friend_accept back to A.
  const harriet = db.prepare('SELECT * FROM users WHERE id = ?').get(harrietId);
  await withFriendsServer(harriet, async (base) => {
    const res = await fetch(`${base}/friends/${aaronCache.id}/accept`, { method: 'POST' });
    assert.equal(res.status, 200);
  });
  const acceptOutboxRow = db.prepare(
    `SELECT * FROM federation_outbox WHERE peer_id = ? AND type = 'friend_accept' ORDER BY id DESC LIMIT 1`
  ).get(peerHtoA);
  assert.ok(acceptOutboxRow);
  const acceptPayload = JSON.parse(acceptOutboxRow.payload_json);
  assert.deepEqual(acceptPayload, { fromRemoteId: harrietId, fromUsername: 'harriet', toUsername: 'aaron' });

  // Step 4 (back on A): that friend_accept event is delivered. Before the fix this UPDATE matched
  // zero rows (A never had a friendships row for this pair) and silently did nothing.
  inboxHandlers.friend_accept(db.prepare('SELECT * FROM federation_peers WHERE id = ?').get(peerAtoH), acceptPayload);

  const harrietCache = db.prepare('SELECT * FROM users WHERE federated_uid = ?').get('harriet@round-h.example');
  assert.ok(harrietCache);
  const [x, y] = aaronId < harrietCache.id ? [aaronId, harrietCache.id] : [harrietCache.id, aaronId];
  const rows = db.prepare('SELECT * FROM friendships WHERE user_a = ? AND user_b = ?').all(x, y);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'accepted');
});
