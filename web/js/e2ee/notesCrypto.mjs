// Pure AES-GCM helpers for Notes (no browser glue, so they run under node --test). Key derivation
// and the Passport seed live in notes.js.

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

// New notes bind origin, server, channel and owner into the AAD so a server operator cannot replay a
// note into another channel, server or user; notes written before this bound only the channel id and
// are still readable through the legacy fallback in decryptNote.
function aad(channelId, scope) { return new TextEncoder().encode(scope ? `note:${scope}:${channelId}` : `note:${channelId}`); }

export async function encryptNote(key, channelId, text, scope) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(channelId, scope) }, key, new TextEncoder().encode(text));
  return { nonce: b64(iv), ciphertext: b64(new Uint8Array(ct)) };
}

export async function decryptNote(key, channelId, { nonce, ciphertext }, scope) {
  for (const additionalData of scope ? [aad(channelId, scope), aad(channelId)] : [aad(channelId)]) {
    try {
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(nonce), additionalData }, key, unb64(ciphertext));
      return new TextDecoder().decode(pt);
    } catch { /* try the next AAD */ }
  }
  return null;
}

// Attachments: iv (12 bytes) || AES-GCM ciphertext. The file name, type, size and a per-file random
// tag (`fk`) travel inside the encrypted note payload, never in the clear. New files bind
// scope + channel + fk into the AAD, so the server cannot serve one file's blob in place of another's
// (the note body that names fk is itself authenticated). Files from before fk carry only the
// channel id and decrypt with that legacy AAD; a file that has fk never falls back to it.
export function newFileTag() { return b64(crypto.getRandomValues(new Uint8Array(16))); }

function fileAad(channelId, binding) {
  return new TextEncoder().encode(binding?.fk ? `notefile:v2:${binding.scope}:${channelId}:${binding.fk}` : `notefile:${channelId}`);
}

export async function encryptBytes(key, channelId, bytes, binding) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: fileAad(channelId, binding) }, key, bytes));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv); out.set(ct, iv.length);
  return out;
}

export async function decryptBytes(key, channelId, blob, binding) {
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.slice(0, 12), additionalData: fileAad(channelId, binding) }, key, blob.slice(12)));
  } catch {
    return null;
  }
}

// A note's encrypted body: { v: 1, text, files: [{ id, name, type, size, fk? }] }. Older notes are bare text.
export function packNote(text, files) { return JSON.stringify({ v: 1, text, files }); }
export function unpackNote(plain) {
  if (plain === null) return null;
  try {
    const o = JSON.parse(plain);
    if (o && o.v === 1 && typeof o.text === 'string' && Array.isArray(o.files)) return o;
  } catch { /* bare text from before attachments */ }
  return { v: 1, text: plain, files: [] };
}
