// Browser glue for encrypted 1:1 DMs: per-conversation ratchet state and a plaintext cache in
// IndexedDB (memory-only when IndexedDB is unavailable), serialised per conversation with a Web
// Lock so two tabs never consume or advance the same chain position. Every failure to read a
// message resolves to a placeholder; nothing here throws into the UI on the receive path.
import { api } from '../api.js';
import { state } from '../state.js';
import { bus } from '../bus.js';
import { deriveKeys, bytesToBase64, bytesFromBase64 } from './crypto.mjs';
import { deriveRootSecret, initChains, sealMessage, openMessage, serializeState, deserializeState } from './ratchet.mjs';
import { getVerifiedSeed } from './identity.js';
import { safetyNumber } from './safety.mjs';
import * as trust from './trust.mjs';
import { newBlobId, encryptFile, decryptFile, fileMeta, normalizeFiles, buildPayload } from './dmFiles.mjs';

export const NO_IDENTITY = 'no local identity';
export const KEY_CHANGED = 'peer key changed';
const DB_NAME = 'meshcrowd-dm-e2ee';
const CHAINS = 'chains';
const PLAIN = 'plaintext';
const TRUST = 'trust';

const memory = { [CHAINS]: new Map(), [PLAIN]: new Map(), [TRUST]: new Map() };
const sentEnvelopes = new Map(); // envelope string -> plaintext, bridges the websocket echo racing the HTTP response
let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, 2);
        req.onupgradeneeded = () => {
          for (const store of [CHAINS, PLAIN, TRUST]) {
            if (!req.result.objectStoreNames.contains(store)) req.result.createObjectStore(store);
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return dbPromise;
}

async function idbGet(store, key) {
  const db = await openDb();
  if (!db) return memory[store].get(key);
  try {
    return await new Promise((resolve, reject) => {
      const req = db.transaction(store).objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return memory[store].get(key);
  }
}

async function idbPut(store, key, value) {
  memory[store].set(key, value);
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch { /* persistence is best-effort: the in-memory copy keeps this tab working */ }
}

async function idbDelete(store, key) {
  memory[store].delete(key);
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).delete(key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch { /* best-effort, like idbPut */ }
}

function withLock(dmId, fn) {
  return navigator.locks ? navigator.locks.request(`meshcrowd-dm-e2ee-${dmId}`, fn) : fn();
}

const chainKey = (meId, dmId) => `${meId}:${dmId}`;
const plainKey = (meId, messageId) => `${meId}:${messageId}`;

export function peekPlaintext(meId, messageId) {
  return memory[PLAIN].get(plainKey(meId, messageId)) || null;
}

async function cachedPlaintext(meId, messageId) {
  const hit = peekPlaintext(meId, messageId) || await idbGet(PLAIN, plainKey(meId, messageId));
  if (hit) memory[PLAIN].set(plainKey(meId, messageId), hit);
  return hit || null;
}

export async function cacheSentPlaintext(meId, messageId, plaintextObj) {
  await idbPut(PLAIN, plainKey(meId, messageId), plaintextObj);
}

const trustStorage = { get: (k) => idbGet(TRUST, k), set: (k, v) => idbPut(TRUST, k, v) };
const views = new Map(); // dmId -> { status: 'ok' | 'changed' | 'nokey', verified, serverKey }

export const trustView = (dmId) => views.get(dmId) || null;

// The server's current key for the peer; falls back to the last one this tab saw if the lookup fails.
async function currentPeerKey(dm) {
  const peer = dm.members[0];
  try {
    peer.e2eePublicKey = (await api.getUser(peer.id)).user.e2eePublicKey || null;
  } catch { /* offline: keep what the conversation list carried */ }
  return peer.e2eePublicKey || null;
}

// This device's own X25519 public key, derived from the verified Passport seed, never taken from the server.
async function ownDerivedKey(me) {
  const seed = await getVerifiedSeed(me);
  return seed ? (await deriveKeys(seed)).dhPublicKey : null;
}

// True when the key the server hands out for this account is not the one this device derives:
// the peer would then be encrypting to a key we do not hold.
async function ownKeyMismatch(me, refetch) {
  if (refetch) {
    try { me.e2eePublicKey = (await api.getUser(me.id)).user.e2eePublicKey || null; } catch { /* offline: keep the last known copy */ }
  }
  const derived = await ownDerivedKey(me);
  return !!derived && !!me.e2eePublicKey && await bytesToBase64(derived) !== me.e2eePublicKey;
}

// Compares the server's key for the peer with the key pinned on this device (pinning it on first
// sight) and publishes the result. Nothing is derived from a key that differs from the pin.
export async function refreshTrust(dm, me) {
  const serverKey = await currentPeerKey(dm);
  const prev = views.get(dm.id);
  const ownMismatch = await ownKeyMismatch(me, !prev);
  let view = { status: 'nokey', verified: false, serverKey: null, ownMismatch };
  if (serverKey) {
    const { status, record } = await trust.evaluatePeerKey(trustStorage, me.id, dm.members[0].id, serverKey);
    view = { status: status === 'changed' ? 'changed' : 'ok', verified: status !== 'changed' && trust.isVerified(record), serverKey, ownMismatch };
  }
  views.set(dm.id, view);
  if (!prev || prev.status !== view.status || prev.verified !== view.verified || prev.serverKey !== view.serverKey || prev.ownMismatch !== view.ownMismatch) {
    bus.emit('e2ee:trust', { dmId: dm.id, view });
  }
  return view;
}

export function setPeerVerified(dm, me, verified) {
  return withLock(dm.id, async () => {
    await trust.setVerified(trustStorage, me.id, dm.members[0].id, verified);
    return refreshTrust(dm, me);
  });
}

// Re-pins the peer's current key and drops this conversation's chains so they are re-derived from it.
// Decrypted-plaintext cache is kept; keys of not-yet-read messages under the old chains are lost.
export function acceptPeerKey(dm, me) {
  return withLock(dm.id, async () => {
    const serverKey = await currentPeerKey(dm);
    if (!serverKey) throw new Error('peer has no encryption key');
    await trust.acceptNewKey(trustStorage, me.id, dm.members[0].id, serverKey);
    await idbDelete(CHAINS, chainKey(me.id, dm.id));
    await refreshTrust(dm, me);
    bus.emit('e2ee:accepted', { dmId: dm.id });
  });
}

export async function getSafetyNumber(dm, me) {
  const view = views.get(dm.id) || await refreshTrust(dm, me);
  if (!view.serverKey) throw new Error('peer has no encryption key');
  const ownKey = await ownDerivedKey(me);
  if (!ownKey) throw new Error(NO_IDENTITY);
  return safetyNumber(me.id, ownKey, dm.members[0].id, await bytesFromBase64(view.serverKey));
}

// Loads (or creates) this conversation's chains. Runs inside the conversation lock.
async function loadChains(dm, me, peerKey) {
  const stored = await idbGet(CHAINS, chainKey(me.id, dm.id));
  if (stored) return deserializeState(stored);
  const seed = await getVerifiedSeed(me);
  if (!seed) throw new Error(NO_IDENTITY);
  const keys = await deriveKeys(seed);
  const root = await deriveRootSecret(keys.dhPrivateKey, await bytesFromBase64(peerKey));
  return initChains(root, me.id, dm.members[0].id);
}

async function saveChains(dm, me, chains) {
  await idbPut(CHAINS, chainKey(me.id, dm.id), await serializeState(chains));
}

// Publishes this device's derived X25519 key if the account has none or a different one; both
// sides of an encrypted DM must be using the key derived from their Passport seed.
export async function ensureOwnKeyPublished(me) {
  const seed = await getVerifiedSeed(me);
  if (!seed) return false;
  const publicKey = await bytesToBase64((await deriveKeys(seed)).dhPublicKey);
  if (me.e2eePublicKey !== publicKey) {
    await api.setE2eePublicKey(publicKey);
    me.e2eePublicKey = publicKey;
  }
  return true;
}

export function encryptForSend(dm, me, text, embed, files) {
  const plaintextObj = buildPayload(text, embed, files);
  return withLock(dm.id, async () => {
    const view = await refreshTrust(dm, me);
    if (view.status === 'changed') throw new Error(KEY_CHANGED);
    if (view.status === 'nokey') throw new Error('peer has no encryption key');
    const chains = await loadChains(dm, me, view.serverKey);
    const { envelope, state: next } = await sealMessage(chains, dm.id, plaintextObj);
    await saveChains(dm, me, next);
    const content = JSON.stringify(envelope);
    sentEnvelopes.set(content, plaintextObj);
    return { content, plaintextObj };
  });
}

function applyPlaintext(message, plaintextObj) {
  message.content = typeof plaintextObj.text === 'string' ? plaintextObj.text : '';
  message.embed = plaintextObj.embed || null;
  message.e2eeFiles = normalizeFiles(plaintextObj.files);
  message.decryptFailed = false;
}

function applyFailure(message) {
  message.content = '';
  message.embed = null;
  message.e2eeFiles = [];
  message.decryptFailed = true;
}

async function decryptOne(dm, me, message, getView) {
  const cached = await cachedPlaintext(me.id, message.id);
  if (cached) return applyPlaintext(message, cached);

  const own = message.author.id === me.id;
  if (own) {
    const sent = sentEnvelopes.get(message.content);
    if (!sent) return applyFailure(message);
    await cacheSentPlaintext(me.id, message.id, sent);
    return applyPlaintext(message, sent);
  }

  if ((await getView()).status !== 'ok') return applyFailure(message);

  try {
    const plaintextObj = await withLock(dm.id, async () => {
      // Another tab may have decrypted it while this one waited for the lock.
      const again = await cachedPlaintext(me.id, message.id);
      if (again) return again;
      const chains = await loadChains(dm, me, (await getView()).serverKey);
      const opened = await openMessage(chains, dm.id, message.content);
      await saveChains(dm, me, opened.state);
      await cacheSentPlaintext(me.id, message.id, opened.plaintextObj);
      return opened.plaintextObj;
    });
    return applyPlaintext(message, plaintextObj);
  } catch {
    return applyFailure(message);
  }
}

// Replaces ciphertext with plaintext on each encrypted message in place, oldest first so the
// receive chain advances sequentially instead of filling the skipped-key table.
export async function decryptMessages(dm, me, messages) {
  const encrypted = messages.filter((m) => m.isEncrypted && !m.eventType && m.decryptFailed === undefined);
  encrypted.sort((a, b) => a.id - b.id);
  let view = null;
  const getView = async () => view || (view = await refreshTrust(dm, me));
  for (const m of encrypted) await decryptOne(dm, me, m, getView);
  for (const m of messages) {
    if (m.replyTo?.isEncrypted) {
      const plain = peekPlaintext(me.id, m.replyTo.id) || await cachedPlaintext(me.id, m.replyTo.id);
      m.replyTo.content = plain?.text || '';
    }
  }
  return messages;
}

export async function decryptMessage(dm, me, message) {
  return (await decryptMessages(dm, me, [message]))[0];
}

export function dmFor(dmId) {
  return state.dms.find((d) => d.id === dmId) || null;
}

// Encrypts and uploads one attachment; the returned entry goes into the message payload.
export async function uploadDmFile(dmId, file) {
  const id = newBlobId();
  const { key, blob } = await encryptFile(new Uint8Array(await file.arrayBuffer()), dmId, id);
  await api.uploadDmFile(dmId, id, blob);
  return fileMeta(id, key, file);
}

// Downloads and decrypts one attachment entry; null when the blob is gone or fails authentication.
export async function fetchDmFile(dmId, meta) {
  const blob = await api.downloadDmFile(dmId, meta.id);
  return decryptFile(blob, meta.key, dmId, meta.id);
}
