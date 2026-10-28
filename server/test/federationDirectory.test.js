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
const federationApiRouter = require('../routes/federationApi');
const { canonicalize } = require('../lib/federationCrypto');

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

test('directory returns only public servers, requires a valid peer signature', async () => {
  const owner = db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run('own', 'own@test.local', 'h', 'Own').lastInsertRowid;
  db.prepare(`INSERT INTO servers (name, owner_id, invite_code, visibility, auto_join) VALUES ('Public One', ?, 'ic1', 'public', 1)`).run(owner);
  db.prepare(`INSERT INTO servers (name, owner_id, invite_code, visibility) VALUES ('Private One', ?, 'ic2', 'private')`).run(owner);

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubkeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  db.prepare(`INSERT INTO federation_peers (domain, public_url, their_pubkey, status) VALUES ('k.example', 'https://k', ?, 'active')`).run(pubkeyPem);

  const app = express();
  app.use(express.json());
  app.use('/federation/api', federationApiRouter);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ts = new Date().toISOString();
    const authPayload = { domain: 'k.example', timestamp: ts };
    const signature = crypto.sign(null, Buffer.from(canonicalize(authPayload)), privateKey).toString('base64');

    const res = await fetch(`${base}/federation/api/servers?domain=k.example&timestamp=${encodeURIComponent(ts)}&signature=${encodeURIComponent(signature)}`);
    assert.equal(res.status, 200);
    const { servers } = await res.json();
    assert.equal(servers.length, 1);
    assert.equal(servers[0].name, 'Public One');
    assert.equal(servers[0].autoJoin, true);
  } finally {
    server.close();
  }
});

test('missing query params, bad signature, unknown peer, and a stale timestamp are all rejected with the same generic error', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubkeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  makePeer('g.example', pubkeyPem);
  function signAs(payload) {
    return crypto.sign(null, Buffer.from(canonicalize(payload)), privateKey).toString('base64');
  }

  await withServer(async (base) => {
    const missing = await fetch(`${base}/federation/api/servers?domain=g.example`);
    assert.equal(missing.status, 401);
    assert.deepEqual(await missing.json(), { error: 'invalid request' });

    const ts = new Date().toISOString();
    const badSig = await fetch(`${base}/federation/api/servers?domain=g.example&timestamp=${encodeURIComponent(ts)}&signature=bogus`);
    assert.equal(badSig.status, 401);
    assert.deepEqual(await badSig.json(), { error: 'invalid request' });

    const unknownPayload = { domain: 'unknown.example', timestamp: ts };
    const unknownPeer = await fetch(`${base}/federation/api/servers?domain=unknown.example&timestamp=${encodeURIComponent(ts)}&signature=${encodeURIComponent(signAs(unknownPayload))}`);
    assert.equal(unknownPeer.status, 401);
    assert.deepEqual(await unknownPeer.json(), { error: 'invalid request' });

    const staleTs = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const stalePayload = { domain: 'g.example', timestamp: staleTs };
    const stale = await fetch(`${base}/federation/api/servers?domain=g.example&timestamp=${encodeURIComponent(staleTs)}&signature=${encodeURIComponent(signAs(stalePayload))}`);
    assert.equal(stale.status, 401);
    assert.deepEqual(await stale.json(), { error: 'invalid request' });
  });
});

test('a signature for a different domain than the one requested is rejected (no cross-domain signature reuse)', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubkeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  makePeer('h.example', pubkeyPem);
  function signAs(payload) {
    return crypto.sign(null, Buffer.from(canonicalize(payload)), privateKey).toString('base64');
  }

  await withServer(async (base) => {
    const ts = new Date().toISOString();
    // signature is valid for 'h.example' but the query claims a different domain string
    const sig = signAs({ domain: 'h.example', timestamp: ts });
    const res = await fetch(`${base}/federation/api/servers?domain=h.example.evil&timestamp=${encodeURIComponent(ts)}&signature=${encodeURIComponent(sig)}`);
    assert.equal(res.status, 401);
  });
});

test('a repeated query param (array instead of string) is rejected, not a 500 crash', async () => {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const pubkeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  makePeer('arr.example', pubkeyPem);

  await withServer(async (base) => {
    const ts = new Date().toISOString();
    const res = await fetch(`${base}/federation/api/servers?domain=arr.example&domain=evil&timestamp=${encodeURIComponent(ts)}&signature=bogus`);
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'invalid request' });
  });
});

test('no servers exist yet returns an empty list, not an error', async () => {
  db.prepare('DELETE FROM servers').run(); // isolate from servers inserted by earlier tests in this file
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubkeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  makePeer('empty.example', pubkeyPem);

  await withServer(async (base) => {
    const ts = new Date().toISOString();
    const sig = crypto.sign(null, Buffer.from(canonicalize({ domain: 'empty.example', timestamp: ts })), privateKey).toString('base64');
    const res = await fetch(`${base}/federation/api/servers?domain=empty.example&timestamp=${encodeURIComponent(ts)}&signature=${encodeURIComponent(sig)}`);
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).servers, []);
  });
});
