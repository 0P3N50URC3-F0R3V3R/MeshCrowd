// Trust-on-first-use pinning of a peer's DM public key, device-local. Pure state machine over an
// injected async storage ({ get(key), set(key, value) }), so it runs under plain `node --test`.
// A record is { pinned, verifiedKey }: `pinned` is the base64 key first seen for the peer and
// `verifiedKey` is the key the user marked as verified (null when unverified). Verification is
// only ever true for the key it was recorded against.

const recordKey = (meId, peerId) => `${meId}:${peerId}`;

export const isVerified = (record) => !!record && !!record.verifiedKey && record.verifiedKey === record.pinned;

// 'pinned' = first sight (key stored now), 'ok' = matches the pin, 'changed' = differs from the pin
// (nothing is modified; the caller must block until acceptNewKey).
export async function evaluatePeerKey(storage, meId, peerId, serverKey) {
  const record = await storage.get(recordKey(meId, peerId));
  if (!record || typeof record.pinned !== 'string') {
    const created = { pinned: serverKey, verifiedKey: null };
    await storage.set(recordKey(meId, peerId), created);
    return { status: 'pinned', record: created };
  }
  return { status: record.pinned === serverKey ? 'ok' : 'changed', record };
}

export async function acceptNewKey(storage, meId, peerId, serverKey) {
  const record = { pinned: serverKey, verifiedKey: null };
  await storage.set(recordKey(meId, peerId), record);
  return record;
}

// Returns null when there is no pin yet: nothing can be verified before a key is pinned.
export async function setVerified(storage, meId, peerId, verified) {
  const record = await storage.get(recordKey(meId, peerId));
  if (!record || typeof record.pinned !== 'string') return null;
  const next = { pinned: record.pinned, verifiedKey: verified ? record.pinned : null };
  await storage.set(recordKey(meId, peerId), next);
  return next;
}
