'use strict';

// Standalone process simulating a remote member's HOME instance, used only by
// server/test/federationChannelRelay.test.js (Task 17's original gap investigation, now the proof
// that the remote_channel_event fan-out closes it).
//
// Why a separate process at all: server/db/index.js's `db` is a true module-level singleton
// keyed off DISMESH_DATA_DIR, so two "instances" required in the same Node process would
// actually share one database — useless for proving that a remote member's own instance has
// NO local `channels` row for a server it doesn't own. Spawning this as a real child process
// with its own DISMESH_DATA_DIR gives it a genuinely separate, from-scratch SQLite database,
// exercised through the REAL federationApi router (not a stub), same as every other piece of
// this codebase would see it.
//
// Config via env:
//   DISMESH_DATA_DIR  - this instance's own fresh data dir (required)
//   OWNER_DOMAIN      - the "owning" instance's federation domain, as returned by its own
//                       lib/federationOutboxWorker.ownDomain() (required)
//   OWNER_PUBKEY_PEM  - the owning instance's real Ed25519 public key PEM, as produced by its
//                       own getOrCreateKeypair() (required)
//   OWNER_SERVER_ID   - id of the owner's server the seeded local users joined (required)
//
// Seeds two local users that both joined that remote server (remote_memberships rows), and records
// every websocket push in-memory (GET /debug/state -> pushed) so the parent can assert who was told.

// Pre-seeds a federation_peers row for the owner so this instance's verifyFederationRequest can
// actually verify a genuinely-signed inbound /inbox delivery from it, then listens on an
// OS-assigned port and prints `PORT <n>` on stdout once ready. Exposes GET /debug/state so the
// parent test process can inspect what, if anything, actually landed in THIS instance's own DB
// after the round trip — without needing any shared process/db with the "owning" side.

const express = require('express');
const http = require('node:http');

const ownerDomain = process.env.OWNER_DOMAIN;
const ownerPubkeyPem = process.env.OWNER_PUBKEY_PEM;
if (!ownerDomain || !ownerPubkeyPem) {
  console.error('remoteChannelInstance: missing OWNER_DOMAIN/OWNER_PUBKEY_PEM');
  process.exit(1);
}

const ownerServerId = Number(process.env.OWNER_SERVER_ID);

const { db } = require('../../db');
// Wrapped BEFORE federationApi.js is first required so its destructured notifyUser is the recorder.
const hub = require('../../socket/hub');
const pushed = [];
hub.notifyUser = (userId, payload) => {
  const user = db.prepare('SELECT username FROM users WHERE id = ?').get(userId);
  pushed.push({ username: user?.username, payload });
};
const federationApiRouter = require('../../routes/federationApi');

const ownerPeerId = db.prepare(`INSERT INTO federation_peers (domain, public_url, their_pubkey, status) VALUES (?, 'https://unused.invalid', ?, 'active')`)
  .run(ownerDomain, ownerPubkeyPem).lastInsertRowid;
for (const username of ['remoteJoiner', 'otherLocal']) {
  const uid = db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run(username, `${username}@local.test`, 'hash', username).lastInsertRowid;
  db.prepare('INSERT INTO remote_memberships (user_id, peer_id, remote_server_id, name) VALUES (?, ?, ?, ?)').run(uid, ownerPeerId, ownerServerId, 'Gap Server');
}

const app = express();
app.use(express.json());
app.use('/federation/api', federationApiRouter);

// Test-only introspection endpoint — not part of production code, exists solely so the parent
// test process can read this instance's own DB state without sharing a process/db with it.
app.get('/debug/state', (req, res) => {
  res.json({
    channels: db.prepare('SELECT COUNT(*) AS n FROM channels').get().n,
    servers: db.prepare('SELECT COUNT(*) AS n FROM servers').get().n,
    channelMessages: db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE scope_type = 'channel'`).get().n,
    pushed,
  });
});

const server = http.createServer(app);
server.listen(0, '127.0.0.1', () => {
  console.log(`PORT ${server.address().port}`);
});
