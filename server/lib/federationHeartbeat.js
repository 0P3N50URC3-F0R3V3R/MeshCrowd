'use strict';

const { db } = require('../db');
const { signPayload } = require('./federationCrypto');
const { safeFetch } = require('./federationSsrf');
const { ownDomain } = require('./federationOutboxWorker');

// Guards against overlapping invocations, same convention as federationOutboxWorker's `draining`
// flag: setInterval doesn't wait for the previous pingOnce() to settle, and a slow/hanging peer
// fetch can otherwise let a second interval tick start a concurrent pass. Overlap here is far more
// benign than in the outbox (no double-delivery, no attempt_count race) — worst case is two
// in-flight pings to the same peer racing to UPDATE last_seen_at to roughly the same timestamp,
// which is harmless. The guard is kept anyway for consistency with the established pattern and to
// avoid doubling outbound request volume per peer on a slow tick.
let pinging = false;

async function pingOnce(fetchImpl = safeFetch) {
  if (pinging) return;
  pinging = true;
  try {
    await pingOnceInner(fetchImpl);
  } finally {
    pinging = false;
  }
}

async function pingOnceInner(fetchImpl) {
  const domain = ownDomain();
  const peers = db.prepare(`SELECT id, public_url FROM federation_peers WHERE status = 'active'`).all();
  await Promise.all(peers.map(async (peer) => {
    const timestamp = new Date().toISOString();
    const signature = signPayload({ domain, timestamp });
    let res;
    try {
      res = await fetchImpl(`${peer.public_url.replace(/\/$/, '')}/federation/api/ping?domain=${encodeURIComponent(domain)}&timestamp=${encodeURIComponent(timestamp)}&signature=${encodeURIComponent(signature)}`, { signal: AbortSignal.timeout(10_000) });
    } catch {
      res = { ok: false };
    }
    if (res.ok) db.prepare('UPDATE federation_peers SET last_seen_at = ? WHERE id = ?').run(new Date().toISOString(), peer.id);
  }));
}

let timer = null;
function startHeartbeat(intervalMs = 60_000) {
  if (timer) return;
  timer = setInterval(() => { pingOnce().catch((err) => console.error('[federation-heartbeat]', err)); }, intervalMs);
  timer.unref();
}
function stopHeartbeat() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { pingOnce, startHeartbeat, stopHeartbeat };
