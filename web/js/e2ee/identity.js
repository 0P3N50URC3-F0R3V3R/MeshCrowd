// Browser-only glue: localStorage + network calls around the pure functions in crypto.mjs.
// The device cache holds the Passport seed (never derived keys); signing, E2EE and snapshot keys
// are derived from it on demand.
import { api } from '../api.js';
import { generateSeed, deriveKeys, bytesToBase64, bytesFromBase64, passportIdFromPublicKey } from './crypto.mjs';
import { toast } from '../utils.js';
import { t } from '../i18n.js';
import { proveWith, passportBundle, unwrapFor, currentCredentialField } from '../passport/flow.js';

const STORAGE_KEY = 'dismesh_passport_seed';

// Only valid for the user it was written for: a different account on the same browser (or a
// malformed entry) counts as "no passport on this device".
export function getCachedSeed(userId) {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    return parsed && parsed.userId === String(userId) && typeof parsed.seed === 'string' ? parsed.seed : null;
  } catch {
    return null;
  }
}

export async function cacheSeed(userId, seedBytes) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ userId: String(userId), seed: await bytesToBase64(seedBytes) }));
  } catch { /* storage unavailable - the seed is recovered from the server backup at next login */ }
}

export async function seedMatchesAccount(seed, passportId) {
  return !!passportId && passportIdFromPublicKey((await deriveKeys(seed)).signPublicKey) === passportId;
}

// The cached seed, but only if it really belongs to this account's passport (user ids can be
// reused across database resets on one origin). A foreign seed is dropped.
export async function getVerifiedSeed(user) {
  const cached = getCachedSeed(user.id);
  if (!cached) return null;
  try {
    const seed = await bytesFromBase64(cached);
    if (await seedMatchesAccount(seed, user.passportId)) return seed;
  } catch { /* corrupt cache entry */ }
  clearCachedIdentity();
  return null;
}

// Explicit logout: the seed comes back from the server backup (password login) or the .mcpass file.
export function clearCachedIdentity() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* storage unavailable */ }
}

// Called once after a password sign-in, while the credential (split keys or the legacy password) is
// still in memory. Never throws: passport setup failing must not block a normal login.
export async function ensureIdentity(user, cred) {
  try {
    if (!cred || await getVerifiedSeed(user)) return;

    if (user.passportId) {
      try {
        const seed = await unwrapFor(await api.getE2eeBackup(), cred);
        if (!(await seedMatchesAccount(seed, user.passportId))) throw new Error('backup does not match the account passport');
        await cacheSeed(user.id, seed);
      } catch (err) {
        console.error('[passport] server backup unusable:', err);
        try { toast(t('auth.backupUnreadable'), { type: 'error', ttl: 15000 }); } catch { /* no DOM */ }
      }
      return;
    }

    // attach needs a 2FA code too; the Settings -> Passport tab handles that case
    if (user.totpEnabled) return;

    // Account made by a client that does not know about passports (e.g. the Android app), or a split
    // account created while this server could not verify Passport proofs.
    const seed = await generateSeed();
    const keys = await deriveKeys(seed);
    const bundle = await passportBundle(seed, keys, cred);
    await api.passportAttach({ ...bundle, ...(await proveWith(keys, 'attach')), ...currentCredentialField(cred) });
    await cacheSeed(user.id, seed);
    try { toast(t('auth.exportReminder'), { ttl: 12000 }); } catch { /* no DOM */ }
  } catch (err) {
    console.error('[passport] identity setup failed:', err);
  }
}
