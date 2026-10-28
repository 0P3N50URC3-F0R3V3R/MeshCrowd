'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const { db } = require('../db');
const secretBox = require('../lib/ai/secretBox');

test.after(async () => {
  db.close();
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('round trips and does not contain the plaintext', () => {
  const blob = secretBox.encrypt('sk-secret-123');
  assert.ok(blob.startsWith('v1.'));
  assert.ok(!blob.includes('sk-secret-123'));
  assert.equal(secretBox.decrypt(blob), 'sk-secret-123');
});

test('two encryptions of the same text differ', () => {
  assert.notEqual(secretBox.encrypt('same'), secretBox.encrypt('same'));
});

test('a tampered blob throws', () => {
  const [v, iv, tag, enc] = secretBox.encrypt('hello').split('.');
  const flipped = Buffer.from(enc, 'base64');
  flipped[0] ^= 0xff;
  assert.throws(() => secretBox.decrypt([v, iv, tag, flipped.toString('base64')].join('.')));
  assert.throws(() => secretBox.decrypt('garbage'));
});

test('the key file is created once with 32 bytes of hex and reused', () => {
  const keyPath = path.join(tmpDir, 'ai.key');
  assert.ok(fs.existsSync(keyPath));
  const hex = fs.readFileSync(keyPath, 'utf8').trim();
  assert.match(hex, /^[0-9a-f]{64}$/);
  const blob = secretBox.encrypt('persist');
  secretBox._resetKeyCache();
  assert.equal(secretBox.decrypt(blob), 'persist');
  assert.equal(fs.readFileSync(keyPath, 'utf8').trim(), hex);
});

test('a different key cannot decrypt', () => {
  const blob = secretBox.encrypt('private');
  fs.writeFileSync(path.join(tmpDir, 'ai.key'), crypto.randomBytes(32).toString('hex'));
  secretBox._resetKeyCache();
  assert.throws(() => secretBox.decrypt(blob));
});
