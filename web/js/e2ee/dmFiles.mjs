// Pure helpers for encrypted-DM attachments: no DOM, network or storage. Each file gets a fresh random
// AES-256-GCM key; the blob is iv (12 bytes) || ciphertext, with the DM id and blob id bound in as AAD
// so the server cannot swap a blob into another conversation or another attachment slot. The key,
// name, type and size ride inside the ratchet-encrypted message payload as one `files` entry.
export const MAX_FILES = 5;
export const MAX_NAME = 200;
export const MAX_TYPE = 100;
const BLOB_ID_RE = /^[0-9a-f]{32}$/;
const KEY_RE = /^[A-Za-z0-9+/]{43}=$/;

function b64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const aad = (dmId, blobId) => new TextEncoder().encode(`meshcrowd-dm-file|v1|${dmId}|${blobId}`);

export function newBlobId() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function encryptFile(bytes, dmId, blobId) {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(dmId, blobId) }, key, bytes));
  const blob = new Uint8Array(iv.length + ct.length);
  blob.set(iv); blob.set(ct, iv.length);
  return { key: b64(raw), blob };
}

// null on any failure: wrong key, wrong DM/blob binding, truncation or tampering.
export async function decryptFile(blob, keyB64, dmId, blobId) {
  try {
    if (blob.length < 28) return null;
    const key = await crypto.subtle.importKey('raw', unb64(keyB64), 'AES-GCM', false, ['decrypt']);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.slice(0, 12), additionalData: aad(dmId, blobId) }, key, blob.slice(12)));
  } catch {
    return null;
  }
}

export function fileMeta(blobId, key, file) {
  return {
    id: blobId,
    key,
    name: String(file.name || 'file').slice(0, MAX_NAME),
    type: String(file.type || 'application/octet-stream').slice(0, MAX_TYPE),
    size: file.size,
  };
}

// The peer controls everything in the payload, so entries are re-validated on receipt; anything
// malformed is dropped rather than rendered.
export function normalizeFiles(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const f of raw.slice(0, MAX_FILES)) {
    if (!f || typeof f !== 'object') continue;
    if (typeof f.id !== 'string' || !BLOB_ID_RE.test(f.id)) continue;
    if (typeof f.key !== 'string' || !KEY_RE.test(f.key)) continue;
    if (!Number.isSafeInteger(f.size) || f.size < 0) continue;
    out.push({
      id: f.id,
      key: f.key,
      name: typeof f.name === 'string' && f.name ? f.name.slice(0, MAX_NAME) : 'file',
      type: typeof f.type === 'string' ? f.type.slice(0, MAX_TYPE) : 'application/octet-stream',
      size: f.size,
    });
  }
  return out;
}

// Message plaintext: { text, embed } as before, plus `files` only when there are any, so payloads
// without attachments stay byte-identical in shape to the original format.
export function buildPayload(text, embed, files) {
  const obj = { text, embed: embed || null };
  if (files && files.length) obj.files = files;
  return obj;
}
