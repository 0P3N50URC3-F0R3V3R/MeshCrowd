// Pure DM ratchet: two one-way symmetric chains per conversation (one per sender direction), seeded
// from the X25519 shared secret. No DOM, network or storage - callers persist the returned state.
// A state value is invalidated by the call that consumes it (its superseded keys are wiped).
import sodium from 'libsodium-wrappers-sumo';

export const MAX_SKIPPED = 1000;
export const MAX_CHAIN_INDEX = 2 ** 31 - 1;
const ROOT_LABEL = 'meshcrowd-dm-e2ee-v1';
const KDF_CTX = { message: 'mcdmmsg1', chain: 'mcdmchn1' };
const B64 = () => sodium.base64_variants.ORIGINAL;

export class RatchetError extends Error {}

export async function deriveRootSecret(myDhPrivate, theirDhPublic) {
  await sodium.ready;
  const shared = sodium.crypto_scalarmult(myDhPrivate, theirDhPublic);
  try {
    return sodium.crypto_generichash(32, shared, sodium.from_string(ROOT_LABEL));
  } finally {
    sodium.memzero(shared);
  }
}

// Lower user id is "A". A->B is A's sending chain; each side's receive chain is the other's send chain.
export async function initChains(root, myId, theirId) {
  await sodium.ready;
  const amA = Number(myId) < Number(theirId);
  const chain = (label) => sodium.crypto_generichash(32, sodium.from_string(`${ROOT_LABEL}|${label}`), root);
  return {
    sendIndex: 0,
    sendKey: chain(amA ? 'A->B' : 'B->A'),
    recvIndex: 0,
    recvKey: chain(amA ? 'B->A' : 'A->B'),
    skipped: {},
  };
}

function step(chainKey) {
  return {
    messageKey: sodium.crypto_kdf_derive_from_key(32, 1, KDF_CTX.message, chainKey),
    nextKey: sodium.crypto_kdf_derive_from_key(32, 2, KDF_CTX.chain, chainKey),
  };
}

function aad(dmId, chainIndex) {
  return sodium.from_string(`meshcrowd-dm|${dmId}|${chainIndex}`);
}

export async function sealMessage(state, dmId, plaintextObj) {
  await sodium.ready;
  if (state.sendIndex >= MAX_CHAIN_INDEX) throw new RatchetError('chain exhausted');
  const { messageKey, nextKey } = step(state.sendKey);
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  try {
    const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      sodium.from_string(JSON.stringify(plaintextObj)), aad(dmId, state.sendIndex), null, nonce, messageKey,
    );
    const envelope = {
      v: 1,
      chainIndex: state.sendIndex,
      nonce: sodium.to_base64(nonce, B64()),
      ciphertext: sodium.to_base64(ciphertext, B64()),
    };
    sodium.memzero(state.sendKey);
    return { envelope, state: { ...state, sendIndex: state.sendIndex + 1, sendKey: nextKey } };
  } catch (err) {
    sodium.memzero(nextKey);
    throw err;
  } finally {
    sodium.memzero(messageKey);
  }
}

export async function parseEnvelope(raw) {
  await sodium.ready;
  const bad = () => new RatchetError('invalid envelope');
  let env = raw;
  if (typeof raw === 'string') {
    try { env = JSON.parse(raw); } catch { throw bad(); }
  }
  if (!env || typeof env !== 'object' || Array.isArray(env)) throw bad();
  if (env.v !== 1 || !Number.isInteger(env.chainIndex) || env.chainIndex < 0 || env.chainIndex > MAX_CHAIN_INDEX) throw bad();
  if (typeof env.nonce !== 'string' || typeof env.ciphertext !== 'string' || !env.ciphertext) throw bad();
  let nonce; let ciphertext;
  try {
    nonce = sodium.from_base64(env.nonce, B64());
    ciphertext = sodium.from_base64(env.ciphertext, B64());
  } catch { throw bad(); }
  if (nonce.length !== sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
    || ciphertext.length < sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES) throw bad();
  return { chainIndex: env.chainIndex, nonce, ciphertext };
}

function decrypt(messageKey, dmId, { chainIndex, nonce, ciphertext }) {
  let plain;
  try {
    plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ciphertext, aad(dmId, chainIndex), nonce, messageKey);
  } catch {
    throw new RatchetError('decryption failed');
  }
  try {
    return JSON.parse(sodium.to_string(plain));
  } catch {
    throw new RatchetError('invalid plaintext');
  } finally {
    sodium.memzero(plain);
  }
}

// State only changes on success: a forged envelope must never advance or consume anything.
export async function openMessage(state, dmId, rawEnvelope) {
  await sodium.ready;
  const env = await parseEnvelope(rawEnvelope);
  const { chainIndex } = env;

  if (chainIndex < state.recvIndex) {
    const key = state.skipped[chainIndex];
    if (!key) throw new RatchetError('message key already consumed');
    const plaintextObj = decrypt(key, dmId, env);
    sodium.memzero(key);
    const skipped = { ...state.skipped };
    delete skipped[chainIndex];
    return { plaintextObj, state: { ...state, skipped } };
  }

  const gap = chainIndex - state.recvIndex;
  if (gap > MAX_SKIPPED || Object.keys(state.skipped).length + gap > MAX_SKIPPED) throw new RatchetError('too many skipped messages');

  const fresh = {};
  const derived = [];
  let cursor = state.recvKey;
  let nextKey;
  let messageKey;
  try {
    for (let i = state.recvIndex; i <= chainIndex; i += 1) {
      ({ messageKey, nextKey } = step(cursor));
      derived.push(nextKey);
      if (i < chainIndex) fresh[i] = messageKey;
      cursor = nextKey;
    }
    const plaintextObj = decrypt(messageKey, dmId, env);
    sodium.memzero(messageKey);
    sodium.memzero(state.recvKey);
    for (const k of derived.slice(0, -1)) sodium.memzero(k);
    return {
      plaintextObj,
      state: { ...state, recvIndex: chainIndex + 1, recvKey: nextKey, skipped: { ...state.skipped, ...fresh } },
    };
  } catch (err) {
    for (const k of derived) sodium.memzero(k);
    for (const k of Object.values(fresh)) sodium.memzero(k);
    if (messageKey) sodium.memzero(messageKey);
    throw err;
  }
}

export async function serializeState(state) {
  await sodium.ready;
  const skipped = {};
  for (const [i, k] of Object.entries(state.skipped)) skipped[i] = sodium.to_base64(k, B64());
  return {
    sendIndex: state.sendIndex,
    sendKey: sodium.to_base64(state.sendKey, B64()),
    recvIndex: state.recvIndex,
    recvKey: sodium.to_base64(state.recvKey, B64()),
    skipped,
  };
}

export async function deserializeState(data) {
  await sodium.ready;
  const skipped = {};
  for (const [i, k] of Object.entries(data.skipped || {})) skipped[i] = sodium.from_base64(k, B64());
  return {
    sendIndex: data.sendIndex,
    sendKey: sodium.from_base64(data.sendKey, B64()),
    recvIndex: data.recvIndex,
    recvKey: sodium.from_base64(data.recvKey, B64()),
    skipped,
  };
}
