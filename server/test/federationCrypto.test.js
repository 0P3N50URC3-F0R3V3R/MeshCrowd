'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;
const { db } = require('../db');
const { getOrCreateKeypair, canonicalize, signPayload, verifyPayload } = require('../lib/federationCrypto');

test.after(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

test('keypair is generated once and persisted', () => {
  const a = getOrCreateKeypair();
  const b = getOrCreateKeypair();
  assert.equal(a.publicKeyPem, b.publicKeyPem);
  assert.equal(a.privateKeyPem, b.privateKeyPem);
});

test('canonicalize is stable under key order', () => {
  assert.equal(canonicalize({ b: 1, a: 2 }), canonicalize({ a: 2, b: 1 }));
});

test('sign/verify roundtrip succeeds, tampering fails', () => {
  const { publicKeyPem } = getOrCreateKeypair();
  const payload = { type: 'ping', foo: 'bar' };
  const sig = signPayload(payload);
  assert.equal(verifyPayload(payload, sig, publicKeyPem), true);
  assert.equal(verifyPayload({ ...payload, foo: 'tampered' }, sig, publicKeyPem), false);
  assert.equal(verifyPayload(payload, sig, publicKeyPem.replace('A', 'B')), false);
});
