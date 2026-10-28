'use strict';

const crypto = require('node:crypto');

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
const ID_RE = /^mc1[a-z2-7]{52}$/;
// DER prefix that wraps a raw 32-byte Ed25519 public key into an SPKI structure node:crypto accepts.
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const MSG_PREFIX = 'meshcrowd-passport-v1';

// Small-order Ed25519 points (identity, order 2, order 4, order 8, with both sign bits). Node's
// verify accepts a trivial signature for these under any message, so they must never be a Passport.
const SMALL_ORDER = new Set([
  '0100000000000000000000000000000000000000000000000000000000000000',
  '0100000000000000000000000000000000000000000000000000000000000080',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0000000000000000000000000000000000000000000000000000000000000080',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa',
]);
const P = (1n << 255n) - 19n;

function isWeakPublicKey(buf) {
  if (SMALL_ORDER.has(buf.toString('hex'))) return true;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? buf[i] & 0x7f : buf[i]);
  return y >= P;
}

function passportIdFromPublicKey(publicKey) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of publicKey) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return `mc1${out}`;
}

// Only the canonical padded base64 of exactly 32 bytes - anything else (whitespace, wrong length,
// non-canonical encodings) is refused so one key has exactly one textual form.
function decodePublicKey(b64) {
  if (typeof b64 !== 'string') return null;
  const buf = Buffer.from(b64, 'base64');
  return buf.length === 32 && buf.toString('base64') === b64 && !isWeakPublicKey(buf) ? buf : null;
}

function buildChallengeMessage({ purpose, origin, nonce, issuedAt }) {
  return [MSG_PREFIX, purpose, origin, nonce, issuedAt].join('|');
}

function verifyChallenge({ publicKey, purpose, origin, nonce, issuedAt, signature }) {
  try {
    if (!Buffer.isBuffer(publicKey) || publicKey.length !== 32 || typeof signature !== 'string') return false;
    const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, publicKey]), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(buildChallengeMessage({ purpose, origin, nonce, issuedAt })), key, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

function isValidBackup(b) {
  if (!b || typeof b !== 'object') return false;
  return ['encryptedKey', 'salt', 'nonce'].every((k) => typeof b[k] === 'string' && b[k].length > 0 && b[k].length <= 4096);
}

// Split accounts' backups are wrapped with the browser-only wrapKey and carry this tag in `salt`
// (their Argon2 salt is users.auth_salt); legacy backups carry their own Argon2 salt there. A
// backup is only accepted when its tag matches the account mode, so the client knows how to open it.
const SPLIT_BACKUP_TAG = 'split:v1';

function isValidBackupFor(authMode, b) {
  return isValidBackup(b) && (authMode === 'split') === (b.salt === SPLIT_BACKUP_TAG);
}

module.exports = {
  isWeakPublicKey, passportIdFromPublicKey, ID_RE, decodePublicKey, buildChallengeMessage, verifyChallenge, isValidBackup,
  SPLIT_BACKUP_TAG, isValidBackupFor,
};
