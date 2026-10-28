'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  passportIdFromPublicKey, ID_RE, decodePublicKey, buildChallengeMessage, verifyChallenge, isValidBackup,
} = require('../lib/passportCrypto');
const { isWeakPublicKey } = require('../lib/passportCrypto');

function makeKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { privateKey, raw: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32) };
}
const sign = (privateKey, fields) => crypto.sign(null, Buffer.from(buildChallengeMessage(fields)), privateKey).toString('base64');

test('passportIdFromPublicKey matches the vectors shared with the browser implementation', () => {
  assert.equal(passportIdFromPublicKey(Buffer.alloc(32)), `mc1${'a'.repeat(52)}`);
  assert.equal(passportIdFromPublicKey(Buffer.alloc(32, 255)), `mc1${'7'.repeat(51)}q`);
  assert.match(passportIdFromPublicKey(makeKey().raw), ID_RE);
});

test('decodePublicKey accepts exactly one canonical 32-byte base64 key', () => {
  const raw = makeKey().raw;
  assert.deepEqual(decodePublicKey(raw.toString('base64')), raw);
  for (const bad of [null, 42, '', 'AAAA', Buffer.alloc(31).toString('base64'), Buffer.alloc(33).toString('base64'), `${raw.toString('base64')}\n`, 'not base64!!']) {
    assert.equal(decodePublicKey(bad), null, String(bad));
  }
});

test('verifyChallenge accepts a valid signature and rejects any altered field', () => {
  const { privateKey, raw } = makeKey();
  const f = { purpose: 'login', origin: 'https://a.example', nonce: 'n1', issuedAt: '2026-09-30T12:00:00.000Z' };
  const signature = sign(privateKey, f);
  assert.equal(verifyChallenge({ publicKey: raw, ...f, signature }), true);
  for (const [k, v] of [['purpose', 'recover'], ['origin', 'https://evil.example'], ['nonce', 'n2'], ['issuedAt', '2026-09-30T12:00:01.000Z']]) {
    assert.equal(verifyChallenge({ publicKey: raw, ...f, [k]: v, signature }), false, k);
  }
});

test('verifyChallenge rejects a signature from another key and never throws on garbage', () => {
  const a = makeKey();
  const b = makeKey();
  const f = { purpose: 'login', origin: 'https://a.example', nonce: 'n1', issuedAt: 'x' };
  assert.equal(verifyChallenge({ publicKey: b.raw, ...f, signature: sign(a.privateKey, f) }), false);
  assert.equal(verifyChallenge({ publicKey: a.raw, ...f, signature: 'garbage' }), false);
  assert.equal(verifyChallenge({ publicKey: a.raw, ...f, signature: 12345 }), false);
  assert.equal(verifyChallenge({ publicKey: Buffer.alloc(5), ...f, signature: 'AAAA' }), false);
});

test('isValidBackup requires three bounded base64 strings', () => {
  assert.equal(isValidBackup({ encryptedKey: 'AAAA', salt: 'AAAA', nonce: 'AAAA' }), true);
  for (const bad of [null, {}, { encryptedKey: 'AAAA', salt: 'AAAA' }, { encryptedKey: 5, salt: 'a', nonce: 'a' }, { encryptedKey: 'A'.repeat(5000), salt: 'a', nonce: 'a' }]) {
    assert.equal(isValidBackup(bad), false);
  }
});

test('decodePublicKey rejects small-order and non-canonical keys but accepts a normal one', () => {
  const { decodePublicKey } = require('../lib/passportCrypto');
  const weak = [
    '01' + '00'.repeat(31), '01' + '00'.repeat(30) + '80',
    'ec' + 'ff'.repeat(30) + '7f', 'ec' + 'ff'.repeat(31),
    '00'.repeat(32), '00'.repeat(31) + '80',
    '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
    '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85',
    'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
    'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa',
    // y >= p: p, p+1 (aliases of y=0 and y=1), and all-ones
    'ed' + 'ff'.repeat(30) + '7f', 'ee' + 'ff'.repeat(30) + '7f', 'ff'.repeat(32),
  ];
  for (const h of weak) assert.equal(decodePublicKey(Buffer.from(h, 'hex').toString('base64')), null, h);
  assert.equal(isWeakPublicKey(Buffer.from(weak[0], 'hex')), true);
  const raw = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  assert.ok(decodePublicKey(raw.toString('base64')));
});

const { isValidBackupFor, SPLIT_BACKUP_TAG } = require('../lib/passportCrypto');

test('isValidBackupFor ties the split:v1 tag to the account mode', () => {
  const tagged = { encryptedKey: 'e', salt: 'split:v1', nonce: 'n' };
  const legacy = { encryptedKey: 'e', salt: 'AAAA', nonce: 'n' };
  assert.equal(SPLIT_BACKUP_TAG, 'split:v1');
  assert.equal(isValidBackupFor('split', tagged), true);
  assert.equal(isValidBackupFor('split', legacy), false);
  assert.equal(isValidBackupFor('password', legacy), true);
  assert.equal(isValidBackupFor('password', tagged), false);
  assert.equal(isValidBackupFor('split', { salt: 'split:v1' }), false);
  assert.equal(isValidBackupFor('split', undefined), false);
});
