'use strict';

const crypto = require('node:crypto');

const TTL_MS = 60_000;
const MAX_CHALLENGES = 10_000;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60_000;
const FAILURE_WINDOW_MS = 15 * 60_000;
const MAX_FAILURE_KEYS = 10_000;

const challenges = new Map(); // nonce -> { issuedAt, origin, at }
const failures = new Map(); // key -> { count, lockedUntil, last }

function issue(origin) {
  if (challenges.size >= MAX_CHALLENGES) {
    // Maps iterate in insertion order, so the first key is the oldest challenge.
    challenges.delete(challenges.keys().next().value);
  }
  const nonce = crypto.randomBytes(32).toString('hex');
  const issuedAt = new Date().toISOString();
  challenges.set(nonce, { issuedAt, origin, at: Date.now() });
  return { nonce, issuedAt, origin };
}

// Single use: the nonce is removed whether or not the rest of the request turns out valid.
function consume(nonce, issuedAt, origin) {
  const entry = typeof nonce === 'string' ? challenges.get(nonce) : undefined;
  if (!entry) return false;
  challenges.delete(nonce);
  return entry.issuedAt === issuedAt && entry.origin === origin && Date.now() - entry.at <= TTL_MS;
}

// Entries with no recent failure and no active lock are treated as reset.
function isStale(f, now) {
  return f.lockedUntil > now ? false : now - f.last > FAILURE_WINDOW_MS;
}

function recordFailure(key) {
  const now = Date.now();
  const cur = failures.get(key);
  // Failures while already locked must not extend the lock, or an attacker could pin a victim's id locked forever.
  if (cur && cur.lockedUntil > now) return;
  const count = (cur && !isStale(cur, now) && !cur.lockedUntil ? cur.count : 0) + 1;
  failures.delete(key);
  if (failures.size >= MAX_FAILURE_KEYS) failures.delete(failures.keys().next().value);
  failures.set(key, { count, lockedUntil: count >= MAX_FAILURES ? now + LOCKOUT_MS : 0, last: now });
}

function isLocked(key) {
  const cur = failures.get(key);
  return !!cur && cur.lockedUntil > Date.now();
}

function clearFailures(key) {
  failures.delete(key);
}

setInterval(() => {
  const now = Date.now();
  for (const [nonce, e] of challenges) if (now - e.at > TTL_MS) challenges.delete(nonce);
  for (const [k, f] of failures) if (isStale(f, now)) failures.delete(k);
}, TTL_MS).unref();

module.exports = {
  issue, consume, recordFailure, isLocked, clearFailures,
  _resetForTests() { challenges.clear(); failures.clear(); },
  _backdate(nonce, ms) { const e = challenges.get(nonce); if (e) e.at -= ms; },
  _size() { return challenges.size; },
  _backdateFailure(key, ms) {
    const f = failures.get(key);
    if (!f) return;
    f.last -= ms;
    if (f.lockedUntil) f.lockedUntil -= ms;
  },
  _failureCount() { return failures.size; },
};
