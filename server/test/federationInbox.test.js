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
const { db } = require('../db');
const federationApiRouter = require('../routes/federationApi');
const { signPayload } = require('../lib/federationCrypto');

test.after(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/federation/api', federationApiRouter);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}

function makePeer(domain, pubkeyPem) {
  return db.prepare(`INSERT INTO federation_peers (domain, public_url, their_pubkey, status) VALUES (?, 'https://x', ?, 'active')`)
    .run(domain, pubkeyPem).lastInsertRowid;
}

test('rejects unsigned/unknown-peer/replayed requests, accepts and dedupes a valid one', async () => {
  const crypto = require('node:crypto');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubkeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  makePeer('e.example', pubkeyPem);

  const { canonicalize } = require('../lib/federationCrypto');
  function signAs(payload) {
    const sig = crypto.sign(null, Buffer.from(canonicalize(payload)), privateKey);
    return sig.toString('base64');
  }

  await withServer(async (base) => {
    const badSig = await fetch(`${base}/federation/api/inbox`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event_id: 'x', type: 'noop', origin_domain: 'e.example', created_at: new Date().toISOString(), payload: {}, signature: 'bogus' }),
    });
    assert.equal(badSig.status, 401);

    const unknownPeer = { event_id: 'y', type: 'noop', origin_domain: 'unknown.example', created_at: new Date().toISOString(), payload: {} };
    const res2 = await fetch(`${base}/federation/api/inbox`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...unknownPeer, signature: signAs(unknownPeer) }),
    });
    assert.equal(res2.status, 401);

    const good = { event_id: 'z1', type: 'noop', origin_domain: 'e.example', created_at: new Date().toISOString(), payload: {} };
    const res3 = await fetch(`${base}/federation/api/inbox`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...good, signature: signAs(good) }),
    });
    assert.equal(res3.status, 200);

    // Replay of the same event_id: still 200 (idempotent no-op), but must not double-apply —
    // verified here just by confirming a single row in federation_inbox_seen.
    await fetch(`${base}/federation/api/inbox`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...good, signature: signAs(good) }),
    });
    const seen = db.prepare('SELECT COUNT(*) AS n FROM federation_inbox_seen WHERE event_id = ?').get('z1');
    assert.equal(seen.n, 1);

    const stale = { event_id: 'z2', type: 'noop', origin_domain: 'e.example', created_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(), payload: {} };
    const res4 = await fetch(`${base}/federation/api/inbox`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...stale, signature: signAs(stale) }),
    });
    assert.equal(res4.status, 401); // outside the 5-minute replay window
  });
});
