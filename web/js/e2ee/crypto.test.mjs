import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateIdentityKeypair, wrapPrivateKey, unwrapPrivateKey, bytesToBase64, bytesFromBase64,
} from './crypto.mjs';

test('generateIdentityKeypair produces a 32-byte X25519 keypair', async () => {
  const { publicKey, privateKey } = await generateIdentityKeypair();
  assert.equal(publicKey.length, 32);
  assert.equal(privateKey.length, 32);
});

test('generateIdentityKeypair produces a different keypair every call', async () => {
  const a = await generateIdentityKeypair();
  const b = await generateIdentityKeypair();
  assert.notDeepEqual([...a.privateKey], [...b.privateKey]);
});

test('wrapPrivateKey/unwrapPrivateKey round-trips the private key under the right password', async () => {
  const { privateKey } = await generateIdentityKeypair();
  const backup = await wrapPrivateKey(privateKey, 'correct horse battery staple');
  assert.equal(typeof backup.encryptedKey, 'string');
  assert.equal(typeof backup.salt, 'string');
  assert.equal(typeof backup.nonce, 'string');
  const recovered = await unwrapPrivateKey(backup, 'correct horse battery staple');
  assert.deepEqual([...recovered], [...privateKey]);
});

test('unwrapPrivateKey throws on the wrong password instead of returning garbage', async () => {
  const { privateKey } = await generateIdentityKeypair();
  const backup = await wrapPrivateKey(privateKey, 'right password');
  await assert.rejects(() => unwrapPrivateKey(backup, 'wrong password'));
});

test('wrapPrivateKey uses a fresh salt and nonce every call, even for the same key', async () => {
  const { privateKey } = await generateIdentityKeypair();
  const backupA = await wrapPrivateKey(privateKey, 'same password');
  const backupB = await wrapPrivateKey(privateKey, 'same password');
  assert.notEqual(backupA.salt, backupB.salt);
  assert.notEqual(backupA.nonce, backupB.nonce);
  assert.notEqual(backupA.encryptedKey, backupB.encryptedKey);
});

test('bytesToBase64/bytesFromBase64 round-trips', async () => {
  const { publicKey } = await generateIdentityKeypair();
  const b64 = await bytesToBase64(publicKey);
  const back = await bytesFromBase64(b64);
  assert.deepEqual([...back], [...publicKey]);
});

import {
  generateSeed, deriveKeys, passportIdFromPublicKey, isPassportId, formatPassportId,
  buildChallengeMessage, signChallenge, buildPassportFile, readPassportFile, wrapSeed, unwrapSeed,
} from './crypto.mjs';
import sodium from 'libsodium-wrappers-sumo';

test('generateSeed returns 32 random bytes', async () => {
  const a = await generateSeed();
  const b = await generateSeed();
  assert.equal(a.length, 32);
  assert.notDeepEqual([...a], [...b]);
});

test('deriveKeys is deterministic and the subkeys are all different', async () => {
  const seed = new Uint8Array(32).fill(7);
  const a = await deriveKeys(seed);
  const b = await deriveKeys(seed);
  assert.deepEqual([...a.signPublicKey], [...b.signPublicKey]);
  assert.deepEqual([...a.dhPublicKey], [...b.dhPublicKey]);
  assert.deepEqual([...a.snapshotKey], [...b.snapshotKey]);
  assert.equal(a.signPublicKey.length, 32);
  assert.equal(a.dhPublicKey.length, 32);
  assert.notDeepEqual([...a.signPublicKey], [...a.dhPublicKey]);
  assert.notDeepEqual([...a.dhPrivateKey], [...a.snapshotKey]);
});

test('passportIdFromPublicKey matches the shared vectors and round-trips the format rules', () => {
  assert.equal(passportIdFromPublicKey(new Uint8Array(32)), 'mc1' + 'a'.repeat(52));
  assert.equal(passportIdFromPublicKey(new Uint8Array(32).fill(255)), 'mc1' + '7'.repeat(51) + 'q');
  assert.equal(isPassportId('mc1' + 'a'.repeat(52)), true);
  for (const bad of ['', 'mc1', 'mc1' + 'a'.repeat(51), 'mc1' + 'A'.repeat(52), 'mc2' + 'a'.repeat(52), 'mc1' + '1'.repeat(52), null, 42]) {
    assert.equal(isPassportId(bad), false, String(bad));
  }
  assert.equal(formatPassportId('mc1' + 'a'.repeat(52)), 'mc1-aaaa-aaaa-aaaa-aaaa');
});

test('signChallenge produces a detached Ed25519 signature that verifies over the exact message', async () => {
  const keys = await deriveKeys(new Uint8Array(32).fill(3));
  const fields = { purpose: 'login', origin: 'https://a.example', nonce: 'ab12', issuedAt: '2026-09-30T12:00:00.000Z' };
  assert.equal(buildChallengeMessage(fields), 'meshcrowd-passport-v1|login|https://a.example|ab12|2026-09-30T12:00:00.000Z');
  const sig = await signChallenge(keys.signPrivateKey, fields);
  await sodium.ready;
  const sigBytes = sodium.from_base64(sig, sodium.base64_variants.ORIGINAL);
  assert.equal(sodium.crypto_sign_verify_detached(sigBytes, sodium.from_string(buildChallengeMessage(fields)), keys.signPublicKey), true);
  assert.equal(sodium.crypto_sign_verify_detached(sigBytes, sodium.from_string(buildChallengeMessage({ ...fields, origin: 'https://evil.example' })), keys.signPublicKey), false);
});

test('a passport file round-trips under the right passphrase and fails under a wrong one', async () => {
  const seed = await generateSeed();
  const file = await buildPassportFile(seed, 'correct horse battery');
  assert.equal(file.format, 'meshcrowd-passport');
  assert.equal(file.v, 1);
  const { publicKey } = { publicKey: (await deriveKeys(seed)).signPublicKey };
  assert.equal(file.id, passportIdFromPublicKey(publicKey));
  const back = await readPassportFile(JSON.parse(JSON.stringify(file)), 'correct horse battery');
  assert.deepEqual([...back.seed], [...seed]);
  assert.equal(back.id, file.id);
  await assert.rejects(() => readPassportFile(file, 'wrong passphrase!!'), /wrong passphrase or corrupted/);
});

test('passphrases are Unicode-normalised so different compositions unlock the same file', async () => {
  const seed = await generateSeed();
  const file = await buildPassportFile(seed, 'café au lait 1234');
  const back = await readPassportFile(file, 'café au lait 1234');
  assert.deepEqual([...back.seed], [...seed]);
});

test('readPassportFile refuses unknown versions, wrong formats and absurd KDF costs before deriving a key', async () => {
  const seed = await generateSeed();
  const file = await buildPassportFile(seed, 'correct horse battery');
  await assert.rejects(() => readPassportFile({ ...file, v: 2 }, 'correct horse battery'), /unsupported passport file/);
  await assert.rejects(() => readPassportFile({ ...file, format: 'other' }, 'correct horse battery'), /unsupported passport file/);
  await assert.rejects(() => readPassportFile({ ...file, kdf: { ...file.kdf, memlimit: 4 * 1024 * 1024 * 1024 } }, 'correct horse battery'), /unsupported passport file/);
  await assert.rejects(() => readPassportFile({ ...file, kdf: { ...file.kdf, opslimit: 1000 } }, 'correct horse battery'), /unsupported passport file/);
  await assert.rejects(() => readPassportFile(null, 'x'), /unsupported passport file/);
});

test('readPassportFile rejects a file whose plaintext id does not match its seed', async () => {
  const seed = await generateSeed();
  const file = await buildPassportFile(seed, 'correct horse battery');
  const other = await buildPassportFile(await generateSeed(), 'correct horse battery');
  await assert.rejects(() => readPassportFile({ ...file, id: other.id }, 'correct horse battery'), /does not match/);
});

test('unwrapSeed with a wrong login password rejects with the stable error, not a raw libsodium one', async () => {
  const wrapped = await wrapSeed(await generateSeed(), 'login password 1');
  await assert.rejects(() => unwrapSeed(wrapped, 'login password 2'), /^Error: wrong password or corrupted backup$/);
});

test('wrapSeed/unwrapSeed round-trip a seed under the login password', async () => {
  const seed = await generateSeed();
  const wrapped = await wrapSeed(seed, 'login password 1');
  const back = await unwrapSeed(wrapped, 'login password 1');
  assert.deepEqual([...back], [...seed]);
});

import {
  deriveAuthKeys, generateAuthSalt, isAuthSalt, wrapSeedWithKey, unwrapSeedWithKey, SPLIT_BACKUP_TAG, MIN_PASSWORD_LENGTH,
} from './crypto.mjs';

const VECTOR_SALT = 'AQEBAQEBAQEBAQEBAQEBAQ==';

test('deriveAuthKeys matches the pinned vector (Argon2id INTERACTIVE, mcauth01 / mcwrap01)', async () => {
  const { authKey, wrapKey } = await deriveAuthKeys('correct horse battery', VECTOR_SALT);
  assert.equal(authKey, '0v0HyWxm7RB2UzXDk9pHjUYTWp7w8NqtCW8iWA97GtQ=');
  assert.equal(await bytesToBase64(wrapKey), 'IpkZavXaHSZadOG3KKF1YihvAPOxZ5Q3HDbRXXc7o5I=');
});

test('deriveAuthKeys separates authKey from wrapKey and depends on the salt', async () => {
  const a = await deriveAuthKeys('same password 1', VECTOR_SALT);
  const b = await deriveAuthKeys('same password 1', await generateAuthSalt());
  assert.notEqual(a.authKey, await bytesToBase64(a.wrapKey));
  assert.notEqual(a.authKey, b.authKey);
  assert.equal(a.wrapKey.length, 32);
  assert.equal((await bytesFromBase64(a.authKey)).length, 32);
});

test('passwords are NFKC-normalised before derivation', async () => {
  const composed = `caf${String.fromCharCode(0xe9)} au lait`;
  const decomposed = `cafe${String.fromCharCode(0x301)} au lait`;
  assert.equal((await deriveAuthKeys(composed, VECTOR_SALT)).authKey, (await deriveAuthKeys(decomposed, VECTOR_SALT)).authKey);
});

test('isAuthSalt accepts only canonical base64 of 16 bytes and deriveAuthKeys refuses anything else', async () => {
  assert.equal(isAuthSalt(VECTOR_SALT), true);
  assert.equal(isAuthSalt(await generateAuthSalt()), true);
  for (const bad of [null, 42, '', `${VECTOR_SALT}=`, 'AQEBAQEBAQEBAQEBAQEBAR==', 'AQEBAQEBAQEBAQEBAQEBAQ', '0v0HyWxm7RB2UzXDk9pHjUYTWp7w8NqtCW8iWA97GtQ=']) {
    assert.equal(isAuthSalt(bad), false, String(bad));
  }
  await assert.rejects(() => deriveAuthKeys('x', 'nope'), /invalid sign-in salt/);
  assert.equal(MIN_PASSWORD_LENGTH, 8);
});

test('wrapSeedWithKey/unwrapSeedWithKey round-trip, tag the backup and fail with the stable error', async () => {
  const seed = await generateSeed();
  const { wrapKey } = await deriveAuthKeys('login password 1', VECTOR_SALT);
  const backup = await wrapSeedWithKey(seed, wrapKey);
  assert.equal(backup.salt, SPLIT_BACKUP_TAG);
  assert.equal(SPLIT_BACKUP_TAG, 'split:v1');
  assert.deepEqual([...(await unwrapSeedWithKey(backup, wrapKey))], [...seed]);
  const other = (await deriveAuthKeys('login password 2', VECTOR_SALT)).wrapKey;
  await assert.rejects(() => unwrapSeedWithKey(backup, other), /^Error: wrong password or corrupted backup$/);
  await assert.rejects(() => unwrapSeedWithKey({ ...backup, salt: 'AAAA' }, wrapKey), /^Error: wrong password or corrupted backup$/);
});
