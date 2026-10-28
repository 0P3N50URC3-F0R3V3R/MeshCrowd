'use strict';

// Short-lived holding pen for a login that passed the password check but still needs a 2FA code.
// Deliberately in-memory (not a DB table) — a server restart mid-login just means the user
// re-enters their password, which is fine for something meant to live seconds, not the
// durable-across-restarts guarantee a real session needs.
const crypto = require('node:crypto');

const TTL_MS = 5 * 60 * 1000;
const pending = new Map(); // token -> { userId, expiresAt }

function create(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  pending.set(token, { userId, expiresAt: Date.now() + TTL_MS });
  return token;
}

// Non-consuming lookup — a mistyped 2FA code must not burn the token, or the very next (correct)
// attempt would fail with "login expired" instead of just being told the code was wrong.
function peek(token) {
  const entry = pending.get(token);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) { pending.delete(token); return null; }
  return entry.userId;
}

// Only call this once the code has actually verified — it's what makes the token one-shot
// (can't replay the same successful login), not `peek`.
function remove(token) {
  pending.delete(token);
}

// A credential change must also kill a login that was already past the password step.
function removeForUser(userId) {
  for (const [token, entry] of pending) if (entry.userId === userId) pending.delete(token);
}

setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of pending) if (entry.expiresAt < now) pending.delete(token);
}, 60_000).unref();

module.exports = { create, peek, remove, removeForUser };
