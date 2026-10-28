'use strict';

const crypto = require('node:crypto');
const { signPayload } = require('./federationCrypto');
const { safeFetch } = require('./federationSsrf');
const { ownDomain } = require('./federationOutboxWorker');

const RPC_TIMEOUT_MS = 8000;

// Synchronous signed call to a paired peer's /federation/api/rpc, in the same envelope shape the
// outbox uses. Every transport-level failure (down, timeout, revoked, rate-limited, bad body) is
// folded into one 'unreachable' result so callers never leak peer internals to the browser.
async function callPeer(peer, type, payload, { timeoutMs = RPC_TIMEOUT_MS } = {}) {
  const envelope = {
    event_id: crypto.randomUUID(), type, origin_domain: ownDomain(), created_at: new Date().toISOString(), payload,
  };
  const signature = signPayload(envelope);
  try {
    const res = await safeFetch(`${peer.public_url.replace(/\/$/, '')}/federation/api/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...envelope, signature }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, status: 502, error: 'unreachable' };
    const body = await res.json();
    return body && typeof body === 'object' ? body : { ok: false, status: 502, error: 'unreachable' };
  } catch {
    return { ok: false, status: 502, error: 'unreachable' };
  }
}

module.exports = { callPeer };
