'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const http = require('node:http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;
process.env.DISMESH_FEDERATION_PUBLIC_URL_OVERRIDE = ''; // reserved for future use, unused here
const { db } = require('../db');
const { router: adminRouter, requireFederationAdmin } = require('../routes/federationAdmin');
const federationApiRouter = require('../routes/federationApi');
const { setFederationAdminPassword, createFederationAdminSession } = require('../lib/federationAdminAuth');
const crypto = require('node:crypto');
const { getOrCreateKeypair, signPayload, canonicalize } = require('../lib/federationCrypto');

test.after(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/federation/admin', adminRouter);
  app.use('/federation/api', federationApiRouter);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try { await fn(`http://127.0.0.1:${port}`); } finally { server.close(); }
}

test('invite generation requires federation admin auth', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/federation/admin/invites`, { method: 'POST' });
    assert.equal(res.status, 401);
  });
});

test('handshake with a valid token creates a pending inbound peer, records their pubkey', async () => {
  setFederationAdminPassword('super-secret-federation-pass');
  const { token: adminToken } = createFederationAdminSession();

  await withServer(async (base) => {
    const inviteRes = await fetch(`${base}/federation/admin/invites`, {
      method: 'POST',
      headers: { cookie: `dismesh_federation_admin=${adminToken}` },
    });
    assert.equal(inviteRes.status, 201);
    const { token: inviteToken } = await inviteRes.json();

    const { publicKeyPem } = getOrCreateKeypair(); // stand-in "their" keypair reused for simplicity in this unit test
    const payload = { token: inviteToken, domain: '93.184.216.34', publicUrl: 'https://93.184.216.34/', pubkey: publicKeyPem };
    const signature = signPayload(payload);

    const res = await fetch(`${base}/federation/api/handshake`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, signature }),
    });
    assert.equal(res.status, 200);
    const peer = db.prepare('SELECT * FROM federation_peers WHERE domain = ?').get('93.184.216.34');
    assert.equal(peer.status, 'pending');
    assert.equal(peer.direction, 'inbound');
    assert.equal(peer.their_pubkey, publicKeyPem);

    // Replaying the same invite token must fail (single-use).
    const replay = await fetch(`${base}/federation/api/handshake`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, signature }),
    });
    assert.equal(replay.status, 400);
  });
});

test('re-pairing the same domain with a fresh invite upserts the existing peer row', async () => {
  setFederationAdminPassword('super-secret-federation-pass-2');
  const { token: adminToken } = createFederationAdminSession();

  await withServer(async (base) => {
    async function issueInvite() {
      const inviteRes = await fetch(`${base}/federation/admin/invites`, {
        method: 'POST',
        headers: { cookie: `dismesh_federation_admin=${adminToken}` },
      });
      assert.equal(inviteRes.status, 201);
      const { token } = await inviteRes.json();
      return token;
    }

    const { publicKeyPem: firstPubkey } = getOrCreateKeypair();
    const firstPayload = { token: await issueInvite(), domain: '93.184.216.40', publicUrl: 'https://93.184.216.40/', pubkey: firstPubkey };
    const firstRes = await fetch(`${base}/federation/api/handshake`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...firstPayload, signature: signPayload(firstPayload) }),
    });
    assert.equal(firstRes.status, 200);

    // A different key for an already-paired domain is refused (it would hand the old peer's cached
    // users to whoever holds the new key); the same key re-pairing with a fresh invite upserts.
    const { publicKey: otherKey, privateKey: otherPrivateKey } = crypto.generateKeyPairSync('ed25519');
    const otherPubkey = otherKey.export({ type: 'spki', format: 'pem' });
    const otherPayload = { token: await issueInvite(), domain: '93.184.216.40', publicUrl: 'https://93.184.216.40/', pubkey: otherPubkey };
    const otherRes = await fetch(`${base}/federation/api/handshake`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...otherPayload, signature: crypto.sign(null, Buffer.from(canonicalize(otherPayload)), otherPrivateKey).toString('base64') }),
    });
    assert.equal(otherRes.status, 409);

    const secondPayload = { token: await issueInvite(), domain: '93.184.216.40', publicUrl: 'https://93.184.216.40/', pubkey: firstPubkey };
    const secondRes = await fetch(`${base}/federation/api/handshake`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...secondPayload, signature: signPayload(secondPayload) }),
    });
    assert.equal(secondRes.status, 200);

    const rows = db.prepare('SELECT * FROM federation_peers WHERE domain = ?').all('93.184.216.40');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].their_pubkey, firstPubkey);
  });
});

test('handshake success audits with the real peer id, not a stale lastInsertRowid from the upsert', async () => {
  setFederationAdminPassword('super-secret-federation-pass-3');
  const { token: adminToken } = createFederationAdminSession();

  await withServer(async (base) => {
    async function issueInvite() {
      const inviteRes = await fetch(`${base}/federation/admin/invites`, {
        method: 'POST',
        headers: { cookie: `dismesh_federation_admin=${adminToken}` },
      });
      const { token } = await inviteRes.json();
      return token;
    }

    async function handshake(domain, keypair) {
      const payload = { token: await issueInvite(), domain, publicUrl: `https://${domain}/`, pubkey: keypair.pubkey };
      const signature = crypto.sign(null, Buffer.from(canonicalize(payload)), keypair.privateKey).toString('base64');
      return fetch(`${base}/federation/api/handshake`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...payload, signature }),
      });
    }

    function freshKeypair() {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
      return { pubkey: publicKey.export({ type: 'spki', format: 'pem' }), privateKey };
    }

    const startId = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM federation_audit_log').get().id;

    const peerAKeypair = freshKeypair();
    const resA1 = await handshake('93.184.216.51', peerAKeypair);
    assert.equal(resA1.status, 200);
    const peerA = db.prepare('SELECT id FROM federation_peers WHERE domain = ?').get('93.184.216.51');

    // Pairing a SECOND, later-numbered peer in between is what exposes a naive lastInsertRowid
    // read: in better-sqlite3/node:sqlite, lastInsertRowid reflects the most recent INSERT
    // anywhere in the connection, not necessarily the row this statement's ON CONFLICT touched.
    const peerBKeypair = freshKeypair();
    const resB = await handshake('93.184.216.52', peerBKeypair);
    assert.equal(resB.status, 200);
    const peerB = db.prepare('SELECT id FROM federation_peers WHERE domain = ?').get('93.184.216.52');
    assert.notEqual(peerA.id, peerB.id);

    // Re-handshake peer A (fresh keypair + fresh invite, same domain) — takes the ON CONFLICT
    // DO UPDATE branch. A naive `result.lastInsertRowid` here would wrongly report peer B's id
    // (the last genuine INSERT), not peer A's own id.
    const peerARekeypair = peerAKeypair;
    const resA2 = await handshake('93.184.216.51', peerARekeypair);
    assert.equal(resA2.status, 200);

    const successLogs = db.prepare(
      `SELECT * FROM federation_audit_log WHERE action = 'federation_handshake_success' AND id > ? ORDER BY id ASC`
    ).all(startId);
    assert.equal(successLogs.length, 3);
    assert.equal(successLogs[0].target_id, peerA.id);
    assert.equal(successLogs[1].target_id, peerB.id);
    // The re-handshake of peer A must log peer A's id again, not peer B's.
    assert.equal(successLogs[2].target_id, peerA.id);
    assert.equal(JSON.parse(successLogs[2].details).domain, '93.184.216.51');
  });
});

test('each handshake rejection branch audits a distinct reason before returning', async () => {
  setFederationAdminPassword('super-secret-federation-pass-4');
  const { token: adminToken } = createFederationAdminSession();

  await withServer(async (base) => {
    async function issueInvite() {
      const inviteRes = await fetch(`${base}/federation/admin/invites`, {
        method: 'POST',
        headers: { cookie: `dismesh_federation_admin=${adminToken}` },
      });
      const { token } = await inviteRes.json();
      return token;
    }

    const startId = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM federation_audit_log').get().id;

    // 1. missing fields
    const missingRes = await fetch(`${base}/federation/api/handshake`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ domain: 'reject-missing.example' }),
    });
    assert.equal(missingRes.status, 400);

    // 2. invalid/expired invite (well-formed but bogus token)
    const { publicKeyPem } = getOrCreateKeypair();
    const badInvitePayload = { token: 'not-a-real-token', domain: '93.184.216.60', publicUrl: 'https://93.184.216.60/', pubkey: publicKeyPem };
    const badInviteRes = await fetch(`${base}/federation/api/handshake`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...badInvitePayload, signature: signPayload(badInvitePayload) }),
    });
    assert.equal(badInviteRes.status, 400);

    // 3. signature verification failed (valid invite, wrong signature)
    const sigToken = await issueInvite();
    const sigPayload = { token: sigToken, domain: '93.184.216.61', publicUrl: 'https://93.184.216.61/', pubkey: publicKeyPem };
    const sigRes = await fetch(`${base}/federation/api/handshake`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...sigPayload, signature: 'bm90LWEtcmVhbC1zaWduYXR1cmU=' }),
    });
    assert.equal(sigRes.status, 401);

    // 4. unsafe public URL (valid invite + valid signature, loopback publicUrl)
    const unsafeToken = await issueInvite();
    const { publicKey: unsafeKey, privateKey: unsafePrivateKey } = crypto.generateKeyPairSync('ed25519');
    const unsafePubkey = unsafeKey.export({ type: 'spki', format: 'pem' });
    const unsafePayload = { token: unsafeToken, domain: '127.0.0.1', publicUrl: 'https://127.0.0.1/', pubkey: unsafePubkey };
    const unsafeSignature = crypto.sign(null, Buffer.from(canonicalize(unsafePayload)), unsafePrivateKey).toString('base64');
    const unsafeRes = await fetch(`${base}/federation/api/handshake`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...unsafePayload, signature: unsafeSignature }),
    });
    assert.equal(unsafeRes.status, 400);

    // 1b. missing fields, where domain itself is one of the missing fields — must not crash,
    // and must still reach the audit call (domain comes through as null/undefined in details).
    const missingDomainRes = await fetch(`${base}/federation/api/handshake`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'x' }),
    });
    assert.equal(missingDomainRes.status, 400);

    const failureLogs = db.prepare(
      `SELECT * FROM federation_audit_log WHERE action = 'federation_handshake_failure' AND id > ? ORDER BY id ASC`
    ).all(startId);
    const reasons = failureLogs.map((l) => JSON.parse(l.details).reason);
    assert.deepEqual(reasons, [
      'missing_fields',
      'invalid_or_expired_invite',
      'signature_verification_failed',
      'unsafe_public_url',
      'missing_fields',
    ]);
    // domain must be captured on the missing-fields branch too, even when domain itself is one
    // of the missing fields (here it's present but token/publicUrl/pubkey/signature are not).
    assert.equal(JSON.parse(failureLogs[0].details).domain, 'reject-missing.example');
    assert.equal(JSON.parse(failureLogs[1].details).domain, '93.184.216.60');
    assert.equal(JSON.parse(failureLogs[2].details).domain, '93.184.216.61');
    // ...and when domain is ITSELF the missing field, the audit call must not crash the request.
    assert.equal(JSON.parse(failureLogs[4].details).domain, undefined);
    assert.equal(JSON.parse(failureLogs[3].details).domain, '127.0.0.1');
    failureLogs.forEach((l) => assert.equal(l.target_id, null));
  });
});
