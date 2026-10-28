'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { generateSecret, verifyToken, otpauthUrl, generateRecoveryCodes } = require('../lib/totp');

// Independent re-implementation of the RFC 6238 8-digit reference algorithm, used only to check
// our library's HMAC/base32 plumbing against the RFC's own published test vector — deliberately
// not sharing code with lib/totp.js so a bug there can't hide itself here too.
function base32Decode(str) {
  const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of str.toUpperCase()) { const i = ALPHA.indexOf(c); if (i >= 0) bits += i.toString(2).padStart(5, '0'); }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
function referenceHotp8(secretB32, counter) {
  const key = base32Decode(secretB32);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const off = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[off] & 0x7f) << 24) | ((hmac[off + 1] & 0xff) << 16) | ((hmac[off + 2] & 0xff) << 8) | (hmac[off + 3] & 0xff);
  return String(bin % 10 ** 8).padStart(8, '0');
}

test('matches the RFC 6238 published test vector (SHA1, T=59s -> 94287082)', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // base32 of ASCII "12345678901234567890"
  assert.equal(referenceHotp8(secret, Math.floor(59 / 30)), '94287082');
});

test('generateSecret produces a decodable base32 string a real code can be verified against', () => {
  const secret = generateSecret();
  assert.match(secret, /^[A-Z2-7]+$/);
  const counter = Math.floor(Date.now() / 1000 / 30);
  // Derive the current 6-digit code the same way an authenticator app would, independently of verifyToken.
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const off = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[off] & 0x7f) << 24) | ((hmac[off + 1] & 0xff) << 16) | ((hmac[off + 2] & 0xff) << 8) | (hmac[off + 3] & 0xff);
  const code = String(bin % 10 ** 6).padStart(6, '0');

  assert.equal(verifyToken(secret, code), true);
  assert.equal(verifyToken(secret, '000000'), code === '000000');
});

test('verifyToken rejects malformed input without throwing', () => {
  const secret = generateSecret();
  assert.equal(verifyToken(secret, 'abcdef'), false);
  assert.equal(verifyToken(secret, '12345'), false);
  assert.equal(verifyToken(secret, ''), false);
  assert.equal(verifyToken(secret, null), false);
});

test('otpauthUrl embeds the secret and a MeshCrowd issuer for authenticator apps to scan', () => {
  const secret = generateSecret();
  const url = otpauthUrl(secret, { label: 'alice' });
  assert.match(url, /^otpauth:\/\/totp\//);
  assert.match(url, new RegExp(`secret=${secret}`));
  assert.match(url, /issuer=MeshCrowd/);
});

test('generateRecoveryCodes returns the requested count, all unique', () => {
  const codes = generateRecoveryCodes(8);
  assert.equal(codes.length, 8);
  assert.equal(new Set(codes).size, 8);
});
