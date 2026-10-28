'use strict';

const { db } = require('../db');
const { signPayload } = require('./federationCrypto');
const { safeFetch } = require('./federationSsrf');
const { CONTROL_EVENT_TYPES } = require('./federationOutbox');

const MAX_ATTEMPTS = 10;
const LIVE_EVENT_MAX_ATTEMPTS = 1;
const MAX_PASSES_PER_TICK = 100;

function backoffMs(attempt) {
  return Math.min(60_000 * 2 ** attempt, 6 * 60 * 60 * 1000); // caps at 6h
}

// One in-flight request per peer, oldest-first: picks the single oldest due 'pending' row for
// each active peer that isn't already being retried too soon, and processes them concurrently
// across *different* peers (still sequential within a peer, since only one row per peer is
// selected per pass).
const { load: loadConfig } = require('./config');

// The instance's own domain as its peers must know it — MUST include a non-default port
// (`host`, not `hostname`) so two instances sharing one IP on different ports (local dev, or
// this project's own two-instance integration test) get distinct, non-colliding domains.
function ownDomain() {
  const config = loadConfig();
  return config.federationPublicUrl ? new URL(config.federationPublicUrl).host : config.publicHost;
}

// Guards against overlapping invocations: startOutboxWorker's setInterval doesn't wait for the
// previous drainOnce() to settle, and a slow/hanging peer fetch can otherwise cause two calls to
// SELECT the same still-'pending' row before either UPDATE lands, double-delivering it and
// racing attempt_count. A concurrent call is skipped outright (not queued) rather than delivering.
let draining = false;

// Resolves to how many events were delivered this pass (0 when skipped or nothing was due).
async function drainOnce(fetchImpl = safeFetch) {
  if (draining) return 0;
  draining = true;
  try {
    return await drainOnceInner(fetchImpl);
  } finally {
    draining = false;
  }
}

async function drainOnceInner(fetchImpl) {
  const now = new Date().toISOString();
  const peers = db.prepare(`SELECT id, public_url, status FROM federation_peers`).all();
  const controlTypes = [...CONTROL_EVENT_TYPES];
  const delivered = await Promise.all(peers.map(async (peer) => {
    // A peer that isn't active only ever gets pairing-control events (the accept/reject/revoke
    // that resolves its pending state or tells it it was dropped).
    const active = peer.status === 'active';
    const typeFilter = active ? '' : ` AND type IN (${controlTypes.map(() => '?').join(',')})`;
    const row = db.prepare(
      `SELECT * FROM federation_outbox WHERE peer_id = ? AND status = 'pending' AND next_attempt_at <= ?${typeFilter} ORDER BY id ASC LIMIT 1`
    ).get(peer.id, now, ...(active ? [] : controlTypes));
    if (!row) return 0;

    const payload = { event_id: row.event_id, type: row.type, origin_domain: ownDomain(), created_at: row.created_at, payload: JSON.parse(row.payload_json) };
    const signature = signPayload(payload);

    let res;
    try {
      res = await fetchImpl(`${peer.public_url.replace(/\/$/, '')}/federation/api/inbox`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...payload, signature }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      res = { ok: false, status: 0 };
    }

    if (res.ok) {
      db.prepare(`UPDATE federation_outbox SET status = 'delivered' WHERE id = ?`).run(row.id);
      db.prepare(`UPDATE federation_peers SET last_seen_at = ? WHERE id = ?`).run(new Date().toISOString(), peer.id);
      return 1;
    } else {
      const attempt = row.attempt_count + 1;
      // Live channel events are only useful fresh; a late retry would overwrite newer client state.
      const limit = row.type === 'remote_channel_event' ? LIVE_EVENT_MAX_ATTEMPTS : MAX_ATTEMPTS;
      const status = attempt >= limit ? 'dead' : 'pending';
      const nextAttemptAt = new Date(Date.now() + backoffMs(attempt)).toISOString();
      db.prepare('UPDATE federation_outbox SET attempt_count = ?, status = ?, next_attempt_at = ? WHERE id = ?')
        .run(attempt, status, nextAttemptAt, row.id);
      return 0;
    }
  }));
  return delivered.reduce((a, b) => a + b, 0);
}

let timer = null;

// Keeps draining while events are still being delivered (still one in-flight request per peer, in
// order), so a burst of live channel updates is not spread over one event per tick.
async function tick() {
  for (let i = 0; i < MAX_PASSES_PER_TICK && (await drainOnce()) > 0; i += 1);
}

// Delivered/dead events (which can carry base64 attachments), replay-dedup rows and spent
// invites/sessions are only needed for a short window; without this they grow forever.
function purgeHousekeeping() {
  const cutoff = (ms) => new Date(Date.now() - ms).toISOString();
  const day = 24 * 60 * 60 * 1000;
  db.prepare(`DELETE FROM federation_outbox WHERE status IN ('delivered', 'dead') AND created_at < ?`).run(cutoff(day));
  db.prepare('DELETE FROM federation_inbox_seen WHERE seen_at < ?').run(cutoff(day));
  db.prepare('DELETE FROM federation_invites WHERE expires_at < ?').run(cutoff(day));
  db.prepare('DELETE FROM federation_admin_sessions WHERE expires_at < ?').run(new Date().toISOString());
}

let housekeepingTimer = null;

function startOutboxWorker(intervalMs = 5000) {
  if (timer) return;
  try { purgeHousekeeping(); } catch (err) { console.error('[federation-outbox] purge', err); }
  housekeepingTimer = setInterval(() => { try { purgeHousekeeping(); } catch (err) { console.error('[federation-outbox] purge', err); } }, 60 * 60 * 1000);
  housekeepingTimer.unref();
  timer = setInterval(() => { tick().catch((err) => console.error('[federation-outbox]', err)); }, intervalMs);
  timer.unref();
}

// Lets a freshly queued live event go out now instead of waiting for the next interval. No-op unless
// the worker is actually running (so unit tests that only inspect the outbox never touch the network).
function kickOutboxWorker() {
  if (timer) tick().catch((err) => console.error('[federation-outbox]', err));
}
function stopOutboxWorker() {
  if (timer) clearInterval(timer);
  if (housekeepingTimer) clearInterval(housekeepingTimer);
  timer = null; housekeepingTimer = null;
}

module.exports = { purgeHousekeeping, drainOnce, startOutboxWorker, stopOutboxWorker, kickOutboxWorker, ownDomain };
