// Pure crypto primitives for E2EE identity keys — no DOM, no network, no storage. Every exported
// function is safe to call from a browser or under plain `node --test`; libsodium-wrappers-sumo resolves
// via the import map in web/index.html in the browser, and via normal node_modules in tests.
import sodium from 'libsodium-wrappers-sumo';

export async function generateIdentityKeypair() {
  await sodium.ready;
  const kp = sodium.crypto_box_keypair();
  return { publicKey: kp.publicKey, privateKey: kp.privateKey };
}

// Encrypts privateKey under a key derived from `password` via Argon2id, with a fresh random salt
// and nonce every call. The three returned fields are what gets uploaded to the server — it can
// never derive the wrapping key without the password, which it never sees.
export async function wrapPrivateKey(privateKey, password) {
  await sodium.ready;
  const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
  const wrappingKey = sodium.crypto_pwhash(
    sodium.crypto_secretbox_KEYBYTES,
    normalizeSecret(password),
    salt,
    sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const encrypted = sodium.crypto_secretbox_easy(privateKey, nonce, wrappingKey);
  return {
    encryptedKey: sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL),
    salt: sodium.to_base64(salt, sodium.base64_variants.ORIGINAL),
    nonce: sodium.to_base64(nonce, sodium.base64_variants.ORIGINAL),
  };
}

// Throws (never returns null/garbage) if the password is wrong or the backup is corrupted —
// libsodium throws on auth failure; normalise that into a stable, user-presentable error.
export async function unwrapPrivateKey({ encryptedKey, salt, nonce }, password) {
  await sodium.ready;
  const saltBytes = sodium.from_base64(salt, sodium.base64_variants.ORIGINAL);
  const nonceBytes = sodium.from_base64(nonce, sodium.base64_variants.ORIGINAL);
  const encryptedBytes = sodium.from_base64(encryptedKey, sodium.base64_variants.ORIGINAL);
  const wrappingKey = sodium.crypto_pwhash(
    sodium.crypto_secretbox_KEYBYTES,
    normalizeSecret(password),
    saltBytes,
    sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
  try {
    return sodium.crypto_secretbox_open_easy(encryptedBytes, nonceBytes, wrappingKey);
  } catch {
    throw new Error('wrong password or corrupted backup');
  }
}

export async function bytesToBase64(bytes) {
  await sodium.ready;
  return sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);
}

export async function bytesFromBase64(b64) {
  await sodium.ready;
  return sodium.from_base64(b64, sodium.base64_variants.ORIGINAL);
}

export const MIN_PASSPHRASE_LENGTH = 12;

// Keyboards/OSes can produce the same visible passphrase with different code points (a precomposed
// "é" vs "e" + combining accent). NFKC-normalising before the KDF makes them derive the same key.
function normalizeSecret(secret) {
  return String(secret).normalize('NFKC');
}

const KDF_CTX = { sign: 'mcpsign1', dh: 'mcpdh001', snapshot: 'mcpsnap1' };
const MSG_PREFIX = 'meshcrowd-passport-v1';
const FILE_FORMAT = 'meshcrowd-passport';
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
const ID_RE = /^mc1[a-z2-7]{52}$/;
// A crafted file could ask for an enormous Argon2 cost to freeze the tab; refuse anything above
// twice the MODERATE preset before touching the KDF.
const MAX_KDF_MEMLIMIT = 512 * 1024 * 1024;
const MAX_KDF_OPSLIMIT = 8;

export async function generateSeed() {
  await sodium.ready;
  return sodium.randombytes_buf(sodium.crypto_kdf_KEYBYTES);
}

export async function deriveKeys(seed) {
  await sodium.ready;
  const sub = (id, ctx) => sodium.crypto_kdf_derive_from_key(32, id, ctx, seed);
  const sign = sodium.crypto_sign_seed_keypair(sub(1, KDF_CTX.sign));
  const dh = sodium.crypto_box_seed_keypair(sub(2, KDF_CTX.dh));
  return {
    signPublicKey: sign.publicKey,
    signPrivateKey: sign.privateKey,
    dhPublicKey: dh.publicKey,
    dhPrivateKey: dh.privateKey,
    snapshotKey: sub(3, KDF_CTX.snapshot),
  };
}

export function passportIdFromPublicKey(publicKey) {
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

export function isPassportId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

// Short human form for display only ("mc1-abcd-efgh-ijkl-mnop"); never used for comparison.
export function formatPassportId(id) {
  const body = String(id).slice(3, 19);
  return `mc1-${body.match(/.{1,4}/g).join('-')}`;
}

export function buildChallengeMessage({ purpose, origin, nonce, issuedAt }) {
  return [MSG_PREFIX, purpose, origin, nonce, issuedAt].join('|');
}

export async function signChallenge(signPrivateKey, fields) {
  await sodium.ready;
  const sig = sodium.crypto_sign_detached(sodium.from_string(buildChallengeMessage(fields)), signPrivateKey);
  return sodium.to_base64(sig, sodium.base64_variants.ORIGINAL);
}

export const wrapSeed = wrapPrivateKey;
export const unwrapSeed = unwrapPrivateKey;

export async function buildPassportFile(seed, passphrase, { snapshot = null } = {}) {
  await sodium.ready;
  const keys = await deriveKeys(seed);
  const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
  const opslimit = sodium.crypto_pwhash_OPSLIMIT_MODERATE;
  const memlimit = sodium.crypto_pwhash_MEMLIMIT_MODERATE;
  const key = sodium.crypto_pwhash(
    sodium.crypto_secretbox_KEYBYTES, normalizeSecret(passphrase), salt, opslimit, memlimit, sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const payload = JSON.stringify({
    seed: sodium.to_base64(seed, sodium.base64_variants.ORIGINAL),
    createdAt: new Date().toISOString(),
    snapshot,
  });
  const ciphertext = sodium.crypto_secretbox_easy(sodium.from_string(payload), nonce, key);
  const b64 = (bytes) => sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);
  return {
    format: FILE_FORMAT,
    v: 1,
    id: passportIdFromPublicKey(keys.signPublicKey),
    kdf: { alg: 'argon2id13', opslimit, memlimit, salt: b64(salt) },
    nonce: b64(nonce),
    ciphertext: b64(ciphertext),
  };
}

export async function readPassportFile(file, passphrase) {
  await sodium.ready;
  const unsupported = () => new Error('unsupported passport file');
  if (!file || typeof file !== 'object' || file.format !== FILE_FORMAT || file.v !== 1) throw unsupported();
  const kdf = file.kdf;
  if (!kdf || kdf.alg !== 'argon2id13'
    || !Number.isInteger(kdf.opslimit) || kdf.opslimit < 1 || kdf.opslimit > MAX_KDF_OPSLIMIT
    || !Number.isInteger(kdf.memlimit) || kdf.memlimit < 8192 || kdf.memlimit > MAX_KDF_MEMLIMIT
    || typeof kdf.salt !== 'string' || typeof file.nonce !== 'string' || typeof file.ciphertext !== 'string') {
    throw unsupported();
  }
  let salt; let nonce; let ciphertext;
  try {
    salt = sodium.from_base64(kdf.salt, sodium.base64_variants.ORIGINAL);
    nonce = sodium.from_base64(file.nonce, sodium.base64_variants.ORIGINAL);
    ciphertext = sodium.from_base64(file.ciphertext, sodium.base64_variants.ORIGINAL);
  } catch {
    throw unsupported();
  }
  if (salt.length !== sodium.crypto_pwhash_SALTBYTES || nonce.length !== sodium.crypto_secretbox_NONCEBYTES) throw unsupported();
  const key = sodium.crypto_pwhash(
    sodium.crypto_secretbox_KEYBYTES, normalizeSecret(passphrase), salt, kdf.opslimit, kdf.memlimit, sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
  let plain;
  try {
    plain = sodium.crypto_secretbox_open_easy(ciphertext, nonce, key);
  } catch {
    throw new Error('wrong passphrase or corrupted file');
  }
  let payload;
  try {
    payload = JSON.parse(sodium.to_string(plain));
  } catch {
    throw new Error('wrong passphrase or corrupted file');
  }
  const seed = sodium.from_base64(String(payload.seed), sodium.base64_variants.ORIGINAL);
  if (seed.length !== sodium.crypto_kdf_KEYBYTES) throw new Error('wrong passphrase or corrupted file');
  const id = passportIdFromPublicKey((await deriveKeys(seed)).signPublicKey);
  if (file.id !== id) throw new Error('passport file id does not match its contents');
  return { seed, id, createdAt: payload.createdAt || null, snapshot: payload.snapshot || null };
}

// Split-password sign-in (docs/superpowers/specs/2026-10-01-split-password-design.md). The server
// only ever receives authKey; wrapKey wraps the seed backup and never leaves the browser. The
// Argon2 cost is a constant of this code on purpose: a server must not be able to lower it.
export const MIN_PASSWORD_LENGTH = 8;
export const AUTH_SALT_BYTES = 16;
export const SPLIT_BACKUP_TAG = 'split:v1';
const AUTH_CTX = { auth: 'mcauth01', wrap: 'mcwrap01' };
const AUTH_SALT_RE = /^[A-Za-z0-9+/]{21}[AQgw]==$/;

export function isAuthSalt(salt) {
  return typeof salt === 'string' && AUTH_SALT_RE.test(salt);
}

export async function generateAuthSalt() {
  await sodium.ready;
  return sodium.to_base64(sodium.randombytes_buf(AUTH_SALT_BYTES), sodium.base64_variants.ORIGINAL);
}

export async function deriveAuthKeys(password, authSalt) {
  await sodium.ready;
  if (!isAuthSalt(authSalt)) throw new Error('invalid sign-in salt');
  const master = sodium.crypto_pwhash(
    sodium.crypto_kdf_KEYBYTES,
    normalizeSecret(password),
    sodium.from_base64(authSalt, sodium.base64_variants.ORIGINAL),
    sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
  try {
    const authKey = sodium.crypto_kdf_derive_from_key(32, 1, AUTH_CTX.auth, master);
    const wrapKey = sodium.crypto_kdf_derive_from_key(32, 2, AUTH_CTX.wrap, master);
    const authKeyB64 = sodium.to_base64(authKey, sodium.base64_variants.ORIGINAL);
    sodium.memzero(authKey);
    return { authKey: authKeyB64, wrapKey };
  } finally {
    sodium.memzero(master);
  }
}

// The Argon2 salt of a split backup lives in users.auth_salt; the backup's own `salt` field only
// carries the tag, so the client always knows which unwrap applies.
export async function wrapSeedWithKey(seed, wrapKey) {
  await sodium.ready;
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  return {
    encryptedKey: sodium.to_base64(sodium.crypto_secretbox_easy(seed, nonce, wrapKey), sodium.base64_variants.ORIGINAL),
    salt: SPLIT_BACKUP_TAG,
    nonce: sodium.to_base64(nonce, sodium.base64_variants.ORIGINAL),
  };
}

export async function unwrapSeedWithKey({ encryptedKey, salt, nonce }, wrapKey) {
  await sodium.ready;
  try {
    if (salt !== SPLIT_BACKUP_TAG) throw new Error('not a split backup');
    return sodium.crypto_secretbox_open_easy(
      sodium.from_base64(encryptedKey, sodium.base64_variants.ORIGINAL),
      sodium.from_base64(nonce, sodium.base64_variants.ORIGINAL),
      wrapKey,
    );
  } catch {
    throw new Error('wrong password or corrupted backup');
  }
}
