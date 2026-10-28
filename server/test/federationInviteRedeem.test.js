'use strict';
const test = require('node:test');
process.env.DISMESH_FEDERATION_ALLOW_LOOPBACK = '1'; // these tests talk to peers on 127.0.0.1
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;
const { db } = require('../db');
const federationApiRouter = require('../routes/federationApi');
const { inboxHandlers } = federationApiRouter;
const { getOrCreateKeypair } = require('../lib/federationCrypto');
const { ownDomain } = require('../lib/federationOutboxWorker');
const { DEFAULT_EVERYONE_PERMISSIONS } = require('../lib/permissions');

test.after(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

function makeUser(username) {
  return db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run(username, `${username}@test.local`, 'hash', username).lastInsertRowid;
}

test('redeem_invite adds the resolved remote user as a server member', () => {
  const owner = db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run('own2', 'own2@test.local', 'h', 'Own2').lastInsertRowid;
  const serverId = db.prepare(`INSERT INTO servers (name, owner_id, invite_code, visibility) VALUES ('Priv', ?, 'inv-code-1', 'private')`).run(owner).lastInsertRowid;
  db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, 0, 0, 1)').run(serverId, '@everyone');

  const peerId = db.prepare(`INSERT INTO federation_peers (domain, public_url, their_pubkey, status) VALUES ('l.example', 'https://l', 'PEM', 'active')`).run().lastInsertRowid;
  const peer = { id: peerId, domain: 'l.example' };

  const result = inboxHandlers.redeem_invite(peer, { code: 'inv-code-1', remoteId: 3, username: 'joiner', displayName: 'Joiner' });
  assert.equal(result.ok, true);
  const remote = db.prepare('SELECT id FROM users WHERE federated_uid = ?').get('joiner@l.example');
  assert.ok(db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(serverId, remote.id));

  const bad = inboxHandlers.redeem_invite(peer, { code: 'nonexistent', remoteId: 3, username: 'joiner' });
  assert.equal(bad.ok, false);
});

// @everyone needs the real DEFAULT_EVERYONE_PERMISSIONS (matching router.post('/')'s own server
// creation) so a 'public' channel stays visible via its role grant — channelAccess.js only strips
// VIEW_CHANNEL from a 'private'-type channel specifically (unless explicitly allowed or the viewer
// is mod+), it does not grant VIEW_CHANNEL to 'public' channels on its own. A 0-permission
// @everyone role would hide the public channel too, for an unrelated reason, and this test
// wouldn't actually prove the private-channel-specific filtering it's meant to prove.
test('redeem_invite only returns channels the resolved member can actually VIEW_CHANNEL, matching GET /:id', () => {
  const owner = makeUser('chanOwner');
  const serverId = db.prepare(`INSERT INTO servers (name, owner_id, invite_code, visibility) VALUES ('ChanSrv', ?, 'chan-code-1', 'public')`).run(owner).lastInsertRowid;
  db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 0, 1)').run(serverId, '@everyone', DEFAULT_EVERYONE_PERMISSIONS);
  db.prepare(`INSERT INTO channels (server_id, name, type, position) VALUES (?, 'general', 'public', 0)`).run(serverId);
  db.prepare(`INSERT INTO channels (server_id, name, type, position) VALUES (?, 'mods-only', 'private', 1)`).run(serverId);

  const peerId = db.prepare(`INSERT INTO federation_peers (domain, public_url, their_pubkey, status) VALUES ('chan.example', 'https://c', 'PEM', 'active')`).run().lastInsertRowid;
  const peer = { id: peerId, domain: 'chan.example' };

  const result = inboxHandlers.redeem_invite(peer, { code: 'chan-code-1', remoteId: 1, username: 'chanJoiner', displayName: 'ChanJoiner' });
  assert.equal(result.ok, true);
  const names = result.channels.map((c) => c.name);
  assert.deepEqual(names, ['general'], 'the private channel must not be named in the response to a member with no view grant on it');
});

test('redeem_invite rejects a user already banned from the server', () => {
  const owner = makeUser('banOwner');
  const serverId = db.prepare(`INSERT INTO servers (name, owner_id, invite_code, visibility) VALUES ('BanSrv', ?, 'ban-code-1', 'private')`).run(owner).lastInsertRowid;
  db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, 0, 0, 1)').run(serverId, '@everyone');

  const peerId = db.prepare(`INSERT INTO federation_peers (domain, public_url, their_pubkey, status) VALUES ('ban.example', 'https://b', 'PEM', 'active')`).run().lastInsertRowid;
  const peer = { id: peerId, domain: 'ban.example' };

  // Pre-seed the remote-cache row and ban it, simulating "banned after a previous visit".
  const bannedId = db.prepare(
    `INSERT INTO users (username, email, password_hash, display_name, home_instance_id, remote_user_id, federated_uid)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('remote_bannedph', 'remote_bannedph@remote.invalid', 'x', 'BannedJoiner', peerId, 7, 'bannedJoiner@ban.example').lastInsertRowid;
  db.prepare('INSERT INTO server_bans (server_id, user_id, banned_by) VALUES (?, ?, ?)').run(serverId, bannedId, owner);

  const result = inboxHandlers.redeem_invite(peer, { code: 'ban-code-1', remoteId: 7, username: 'bannedJoiner', displayName: 'BannedJoiner' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'banned');
  assert.equal(db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(serverId, bannedId), undefined);
});

const express = require('express');
const http = require('node:http');

// Step 5b (brief): confirms the HTTP-forwarding call actually fires and the client-facing shape
// is right (status 200, federated: true, server passed through). It stubs the "remote" side with
// a hand-rolled route that echoes success unconditionally — it cannot catch a shape mismatch
// between what forwardInviteToOwner signs/sends and what the real route expects, which is exactly
// why the next test below runs the REAL federationApi router instead. Kept because it's still the
// simplest test that isolates "does /join actually make the outbound HTTP call and relay the
// response" from "is the signed envelope itself valid" — a failure here points at servers.js's
// forwarding logic, a failure in the round-trip test below points at the envelope/signature shape.
test('POST /join forwards a domain-qualified code to the owning peer', async () => {
  const requester = db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run('reqUser', 'req@test.local', 'h', 'ReqUser').lastInsertRowid;

  const remoteApp = express();
  remoteApp.use(express.json());
  remoteApp.post('/federation/api/redeem-invite', (req, res) => res.json({ ok: true, server: { id: 999, name: 'Remote Server' }, channels: [] }));
  const remoteServer = http.createServer(remoteApp);
  await new Promise((r) => remoteServer.listen(0, '127.0.0.1', r));
  const remotePort = remoteServer.address().port;

  db.prepare(`INSERT INTO federation_peers (domain, public_url, their_pubkey, status) VALUES ('remote.example', ?, 'PEM', 'active')`)
    .run(`http://127.0.0.1:${remotePort}`);

  const serversRouter = require('../routes/servers');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: requester, username: 'reqUser', display_name: 'ReqUser' }; next(); });
  app.use('/api/servers', serversRouter);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const res = await fetch(`${base}/api/servers/join`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inviteCode: 'abc123@remote.example' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.federated, true);
    assert.equal(body.server.name, 'Remote Server');
  } finally {
    server.close();
    remoteServer.close();
  }
});

// The real round trip: mounts the REAL federationApi router (not a stub) as the "remote owning
// instance", so the actual verifyFederationRequest middleware and the actual redeemInvite handler
// run against a signature forwardInviteToOwner really produced with signPayload. Both "sides" share
// one process/db in this test, so the single instance's own keypair (getOrCreateKeypair) stands in
// for both "our private key, used to sign" and "the pubkey a peer recognizes us by" — that's why a
// second federation_peers row is seeded below, keyed by our OWN domain with OUR OWN pubkey as
// their_pubkey, exactly what a genuine remote instance would have stored for us after a real
// handshake. This is the coverage the brief's Step 5b test (above) cannot provide: proof that the
// envelope forwardInviteToOwner builds is actually ACCEPTED by real verification, not just that an
// HTTP call fires.
test('full relay round trip: a real signed redeem_invite envelope is verified and redeems a real invite on the "remote" owning instance', async () => {
  const requesterId = db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run('rtJoiner', 'rtjoiner@test.local', 'h', 'RtJoiner').lastInsertRowid;

  // "Remote" owning instance: the real federationApi router, mounted exactly like production
  // (server/index.js: app.use('/federation/api', require('./routes/federationApi'))).
  const remoteApp = express();
  remoteApp.use(express.json());
  remoteApp.use('/federation/api', federationApiRouter);
  const remoteServer = http.createServer(remoteApp);
  await new Promise((r) => remoteServer.listen(0, '127.0.0.1', r));
  const remoteBase = `http://127.0.0.1:${remoteServer.address().port}`;

  const owner = makeUser('rtOwner');
  const serverId = db.prepare(`INSERT INTO servers (name, owner_id, invite_code, visibility) VALUES ('RT Server', ?, 'rt-code-1', 'private')`).run(owner).lastInsertRowid;
  db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, 0, 0, 1)').run(serverId, '@everyone');

  // Row #1: how the LOCAL /join route finds the remote owning peer to forward to (keyed by the
  // domain embedded in the invite code).
  db.prepare(`INSERT INTO federation_peers (domain, public_url, their_pubkey, status) VALUES ('rt-remote.example', ?, 'UNUSED', 'active')`)
    .run(remoteBase);

  // Row #2: how the "REMOTE" side's verifyFederationRequest recognizes the inbound request as
  // genuinely from us — looked up by origin_domain (our ownDomain()), verified against our own
  // public key, since forwardInviteToOwner signs with our own private key via signPayload.
  const { publicKeyPem } = getOrCreateKeypair();
  db.prepare(`INSERT INTO federation_peers (domain, public_url, their_pubkey, status) VALUES (?, 'https://unused.invalid', ?, 'active')`)
    .run(ownDomain(), publicKeyPem);

  const serversRouter = require('../routes/servers');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: requesterId, username: 'rtJoiner', display_name: 'RtJoiner' }; next(); });
  app.use('/api/servers', serversRouter);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const res = await fetch(`${base}/api/servers/join`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inviteCode: 'rt-code-1@rt-remote.example' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.federated, true);
    assert.equal(body.server.name, 'RT Server');
    assert.deepEqual(body.channels, []);

    // Confirm this really happened on the "remote" side's own data, not just a 200 from a stub.
    const remoteMember = db.prepare('SELECT id FROM users WHERE federated_uid = ?').get(`rtJoiner@${ownDomain()}`);
    assert.ok(remoteMember, 'the requester should now exist as a remote-cache user on the "remote" side');
    assert.ok(
      db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(serverId, remoteMember.id),
      'the real redeemInvite handler on the "remote" side should have inserted a real server_members row'
    );
  } finally {
    server.close();
    remoteServer.close();
  }
});

test('POST /join maps a remote "banned" response to 403, matching the local banned-from-server status', async () => {
  const requesterId = db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run('bannedReq', 'bannedreq@test.local', 'h', 'BannedReq').lastInsertRowid;

  const remoteApp = express();
  remoteApp.use(express.json());
  remoteApp.post('/federation/api/redeem-invite', (req, res) => res.json({ ok: false, error: 'banned' }));
  const remoteServer = http.createServer(remoteApp);
  await new Promise((r) => remoteServer.listen(0, '127.0.0.1', r));
  const remotePort = remoteServer.address().port;

  db.prepare(`INSERT INTO federation_peers (domain, public_url, their_pubkey, status) VALUES ('banned-remote.example', ?, 'PEM', 'active')`)
    .run(`http://127.0.0.1:${remotePort}`);

  const serversRouter = require('../routes/servers');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: requesterId, username: 'bannedReq', display_name: 'BannedReq' }; next(); });
  app.use('/api/servers', serversRouter);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const res = await fetch(`${base}/api/servers/join`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inviteCode: 'whatever@banned-remote.example' }),
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, 'banned');
  } finally {
    server.close();
    remoteServer.close();
  }
});

test('POST /join with a domain-qualified code for an unregistered peer returns 404, not a crash', async () => {
  const requesterId = db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run('noPeerReq', 'nopeerreq@test.local', 'h', 'NoPeerReq').lastInsertRowid;

  const serversRouter = require('../routes/servers');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: requesterId, username: 'noPeerReq', display_name: 'NoPeerReq' }; next(); });
  app.use('/api/servers', serversRouter);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const res = await fetch(`${base}/api/servers/join`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inviteCode: 'code@never-registered.example' }),
    });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});
