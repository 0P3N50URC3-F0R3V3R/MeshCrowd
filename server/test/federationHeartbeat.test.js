'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const http = require('node:http');
const crypto = require('node:crypto');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;
const { db } = require('../db');
const { pingOnce } = require('../lib/federationHeartbeat');
const federationApiRouter = require('../routes/federationApi');
const { canonicalize, getOrCreateKeypair } = require('../lib/federationCrypto');
const { ownDomain } = require('../lib/federationOutboxWorker');

test.after(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

test('a successful ping updates last_seen_at; a failed one leaves it stale', async () => {
  const okId = db.prepare(`INSERT INTO federation_peers (domain, public_url, their_pubkey, status, last_seen_at) VALUES ('m.example', 'https://m', 'PEM', 'active', '2000-01-01T00:00:00.000Z')`).run().lastInsertRowid;
  const failId = db.prepare(`INSERT INTO federation_peers (domain, public_url, their_pubkey, status, last_seen_at) VALUES ('n.example', 'https://n', 'PEM', 'active', '2000-01-01T00:00:00.000Z')`).run().lastInsertRowid;

  const fetchImpl = async (url) => (url.includes('m.example') || url.startsWith('https://m'))
    ? { ok: true, status: 200 } : { ok: false, status: 500 };

  await pingOnce(fetchImpl);
  const okPeer = db.prepare('SELECT last_seen_at FROM federation_peers WHERE id = ?').get(okId);
  const failPeer = db.prepare('SELECT last_seen_at FROM federation_peers WHERE id = ?').get(failId);
  assert.ok(new Date(okPeer.last_seen_at).getFullYear() > 2000);
  assert.equal(failPeer.last_seen_at, '2000-01-01T00:00:00.000Z');
});

test('pingOnce guards against overlapping invocations: a concurrent call is skipped, not queued', async () => {
  // Retire every peer from earlier tests first: pingOnce pings every 'active' row unconditionally
  // (unlike drainOnce, which only touches a peer with an actual pending outbox event), so leftover
  // active peers from prior tests in this shared DB would otherwise inflate the call count below.
  db.prepare(`UPDATE federation_peers SET status = 'revoked' WHERE status = 'active'`).run();
  const peerId = db.prepare(`INSERT INTO federation_peers (domain, public_url, their_pubkey, status, last_seen_at) VALUES ('o.example', 'https://o', 'PEM', 'active', '2000-01-01T00:00:00.000Z')`).run().lastInsertRowid;

  let calls = 0;
  let resolveFetch;
  const slowFetch = async () => {
    calls += 1;
    return new Promise((resolve) => { resolveFetch = resolve; });
  };

  const first = pingOnce(slowFetch); // not awaited: fetch is now pending
  try {
    await pingOnce(slowFetch); // concurrent call must return immediately without calling fetch again
    assert.equal(calls, 1);
  } finally {
    // Always settle the first call's pending fetch, even if the assertion above throws — otherwise
    // pingOnce's module-level `pinging` guard is left permanently stuck on `true` (the first call's
    // Promise.all never resolves), silently no-op-ing every later test's pingOnce() call.
    resolveFetch({ ok: true, status: 200 });
    await first;
  }
  assert.ok(new Date(db.prepare('SELECT last_seen_at FROM federation_peers WHERE id = ?').get(peerId).last_seen_at).getFullYear() > 2000);
});

test('GET /ping accepts a validly-signed request from a real registered peer', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubkeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  db.prepare(`INSERT INTO federation_peers (domain, public_url, their_pubkey, status) VALUES ('p.example', 'https://p', ?, 'active')`).run(pubkeyPem);

  const app = express();
  app.use(express.json());
  app.use('/federation/api', federationApiRouter);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ts = new Date().toISOString();
    const signature = crypto.sign(null, Buffer.from(canonicalize({ domain: 'p.example', timestamp: ts })), privateKey).toString('base64');
    const res = await fetch(`${base}/federation/api/ping?domain=p.example&timestamp=${encodeURIComponent(ts)}&signature=${encodeURIComponent(signature)}`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });

    const badRes = await fetch(`${base}/federation/api/ping?domain=p.example&timestamp=${encodeURIComponent(ts)}&signature=bogus`);
    assert.equal(badRes.status, 401);
  } finally {
    server.close();
  }
});

test('pingOnce signs the real GET /ping route end-to-end and the peer accepts it', async () => {
  // Round-trip the actual production envelope pingOnce builds against the actual
  // verifyFederationGet middleware, closing the gap the brief's own pure-fetchImpl unit test
  // leaves open: that test never exercises the real signature this instance produces against the
  // real route a peer runs. The "remote" peer registers *our* own stored keypair's public key
  // (pingOnce signs with getOrCreateKeypair()'s private key via signPayload, same DB/process
  // standing in for two instances, same pattern as federationInviteRedeem.test.js's round trip).
  db.prepare(`UPDATE federation_peers SET status = 'revoked' WHERE status = 'active'`).run();
  db.prepare(`INSERT INTO federation_peers (domain, public_url, their_pubkey, status) VALUES (?, 'https://unused', ?, 'active')`)
    .run(ownDomain(), getOrCreateKeypair().publicKeyPem);
  const remotePeerId = db.prepare(`INSERT INTO federation_peers (domain, public_url, their_pubkey, status, last_seen_at) VALUES ('q.example', ?, 'PEM', 'active', '2000-01-01T00:00:00.000Z')`)
    .run('PLACEHOLDER').lastInsertRowid; // overwritten with the real base URL below

  const app = express();
  app.use(express.json());
  app.use('/federation/api', federationApiRouter);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  db.prepare('UPDATE federation_peers SET public_url = ? WHERE id = ?').run(base, remotePeerId);

  try {
    await pingOnce(fetch);
    const row = db.prepare('SELECT last_seen_at FROM federation_peers WHERE id = ?').get(remotePeerId);
    assert.ok(new Date(row.last_seen_at).getFullYear() > 2000);
  } finally {
    server.close();
  }
});
