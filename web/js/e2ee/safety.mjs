// Safety numbers: a short numeric fingerprint of the two identity keys of a conversation, shown
// to both people so they can compare it over a channel the server does not control. Pure: no DOM,
// network or storage.
import sodium from 'libsodium-wrappers-sumo';

const LABEL = 'meshcrowd-safety-v1';
const ITERATIONS = 5200;
const GROUPS = 12;
const GROUP_MODULUS = 100000;
// Largest multiple of the modulus that fits in 32 bits: draws at or above it are discarded, so
// every group value in [0, 100000) is exactly equally likely (no modulo bias).
const ACCEPT_BELOW = Math.floor(2 ** 32 / GROUP_MODULUS) * GROUP_MODULUS;

function encodeEntry(userId, publicKey) {
  const id = sodium.from_string(String(userId));
  const out = new Uint8Array(1 + id.length + 1 + publicKey.length);
  out[0] = id.length;
  out.set(id, 1);
  out[1 + id.length] = publicKey.length;
  out.set(publicKey, 2 + id.length);
  return out;
}

function compareEntries(a, b) {
  const na = Number(a.userId);
  const nb = Number(b.userId);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  const sa = String(a.userId);
  const sb = String(b.userId);
  if (sa !== sb) return sa < sb ? -1 : 1;
  return sodium.compare(a.publicKey, b.publicKey);
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// Both sides pass (me, them) in their own order; the canonical sort makes the result identical.
export async function safetyNumber(myUserId, myDhPublicKey, theirUserId, theirDhPublicKey) {
  await sodium.ready;
  const entries = [
    { userId: myUserId, publicKey: myDhPublicKey },
    { userId: theirUserId, publicKey: theirDhPublicKey },
  ].sort(compareEntries);
  const material = concat(...entries.map((e) => encodeEntry(e.userId, e.publicKey)));

  let hash = sodium.crypto_generichash(32, concat(sodium.from_string(LABEL), material));
  for (let i = 0; i < ITERATIONS; i += 1) hash = sodium.crypto_generichash(32, concat(hash, material));

  const groups = [];
  const counter = new DataView(new ArrayBuffer(4));
  for (let block = 0; groups.length < GROUPS; block += 1) {
    counter.setUint32(0, block);
    const stream = sodium.crypto_generichash(64, new Uint8Array(counter.buffer.slice(0)), hash);
    const view = new DataView(stream.buffer, stream.byteOffset, stream.length);
    for (let off = 0; off + 4 <= stream.length && groups.length < GROUPS; off += 4) {
      const draw = view.getUint32(off);
      if (draw < ACCEPT_BELOW) groups.push(String(draw % GROUP_MODULUS).padStart(5, '0'));
    }
  }
  return groups.join(' ');
}
