// Client-side encryption for Notes channels. The server only ever stores { nonce, ciphertext }; the
// AES-GCM key is derived from the Passport seed (HKDF-SHA256), so it never leaves this device and a
// lost seed means lost notes. The AES-GCM helpers themselves live in notesCrypto.mjs.
import { getVerifiedSeed } from './identity.js';

export { encryptNote, decryptNote, encryptBytes, decryptBytes, newFileTag, packNote, unpackNote } from './notesCrypto.mjs';

const INFO = new TextEncoder().encode('meshcrowd-notes-v1');
let cached = null;

export async function getNotesKey(user) {
  if (cached && cached.userId === user.id) return cached.key;
  const seed = await getVerifiedSeed(user);
  if (!seed) return null;
  const base = await crypto.subtle.importKey('raw', seed, 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: INFO },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
  cached = { userId: user.id, key };
  return key;
}

export function forgetNotesKey() { cached = null; }
