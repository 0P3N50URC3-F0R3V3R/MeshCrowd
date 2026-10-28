import { api } from '../api.js';
import { t } from '../i18n.js';
import {
  signChallenge, wrapSeed, unwrapSeed, wrapSeedWithKey, unwrapSeedWithKey, deriveAuthKeys, generateAuthSalt, isAuthSalt,
  buildPassportFile, readPassportFile, bytesToBase64, MIN_PASSPHRASE_LENGTH,
} from '../e2ee/crypto.mjs';

// Signs the origin this page believes it talks to (location.origin), not what the server echoes,
// so a proof is useless against any other server.
export async function proveWith(keys, purpose) {
  const ch = await api.passportChallenge();
  const signature = await signChallenge(keys.signPrivateKey, {
    purpose, origin: window.location.origin, nonce: ch.nonce, issuedAt: ch.issuedAt,
  });
  return { nonce: ch.nonce, issuedAt: ch.issuedAt, signature };
}

// A sign-in credential as this client holds it. Split: { mode: 'split', authKey, authSalt, wrapKey };
// only authKey/authSalt may ever be put into a request, wrapKey stays in memory here. Legacy:
// { mode: 'password', password } for accounts that still sign in with a plain password.
export async function splitCredential(password, authSalt) {
  const salt = authSalt || await generateAuthSalt();
  const { authKey, wrapKey } = await deriveAuthKeys(password, salt);
  return { mode: 'split', authKey, authSalt: salt, wrapKey };
}

export function legacyCredential(password) {
  return { mode: 'password', password };
}

// login-params, then the body for POST /api/auth/login. Unknown names come back as split with a
// stable fake salt, so they fail exactly like a wrong password.
export async function prepareLogin(username, password) {
  const params = await api.loginParams(username);
  if (!params || params.v !== 1) throw new Error(t('auth.signInParamsError'));
  if (params.mode === 'password') return { body: { username, password }, cred: legacyCredential(password) };
  if (params.mode !== 'split' || !isAuthSalt(params.salt)) throw new Error(t('auth.signInParamsError'));
  const cred = await splitCredential(password, params.salt);
  return { body: { username, authKey: cred.authKey }, cred };
}

// The signed-in user's current credential, re-derived from a password typed into a Settings form.
export async function currentCredential(me, password) {
  if (me.authMode !== 'split') return legacyCredential(password);
  const params = await api.loginParams(me.username);
  if (!params || params.mode !== 'split' || !isAuthSalt(params.salt)) throw new Error(t('auth.signInParamsError'));
  return splitCredential(password, params.salt);
}

// The "prove you know the current credential" field for attach / change-password.
export function currentCredentialField(cred) {
  return cred.mode === 'split' ? { currentAuthKey: cred.authKey } : { currentPassword: cred.password };
}

export async function wrapFor(seed, cred) {
  return cred.mode === 'split' ? wrapSeedWithKey(seed, cred.wrapKey) : wrapSeed(seed, cred.password);
}

export async function unwrapFor(backup, cred) {
  return cred.mode === 'split' ? unwrapSeedWithKey(backup, cred.wrapKey) : unwrapSeed(backup, cred.password);
}

// Public halves plus the seed wrapped for this credential; the server cannot open `backup`.
export async function passportBundle(seed, keys, cred) {
  return {
    passportPublicKey: await bytesToBase64(keys.signPublicKey),
    e2eePublicKey: await bytesToBase64(keys.dhPublicKey),
    backup: await wrapFor(seed, cred),
  };
}

export async function readFileWithPassphrase(file, passphrase) {
  if (!file) throw new Error('no passport file chosen');
  if (file.size > 64 * 1024) throw new Error('unsupported passport file');
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new Error('unsupported passport file');
  }
  return readPassportFile(parsed, passphrase);
}

export async function downloadPassportFile(seed, passphrase, filename = 'meshcrowd-passport.mcpass') {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE_LENGTH) throw new Error('passphrase too short');
  const file = await buildPassportFile(seed, passphrase);
  const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return file.id;
}

const EXPORTED_KEY = 'dismesh_passport_exported';

export function markExported(userId) {
  try { localStorage.setItem(`${EXPORTED_KEY}:${userId}`, new Date().toISOString()); } catch { /* storage unavailable */ }
}

export function lastExportedAt(userId) {
  try { return localStorage.getItem(`${EXPORTED_KEY}:${userId}`); } catch { return null; }
}
