'use strict';

const crypto = require('node:crypto');
const { db } = require('../db');
const { getSessionTtlDays } = require('./siteSettings');

// Site-admin-configurable (0 or negative = indefinite, represented as a far-future date rather
// than NULL so the `expires_at` column can stay NOT NULL — no schema migration needed for it).
const INDEFINITE_EXPIRY = '9999-12-31T00:00:00.000Z';

function createSession(userId, userAgent, ip) {
  const token = crypto.randomBytes(32).toString('hex');
  const ttlDays = getSessionTtlDays();
  const expiresAt = ttlDays > 0
    ? new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString()
    : INDEFINITE_EXPIRY;
  db.prepare('INSERT INTO sessions (token, user_id, expires_at, user_agent, ip, last_used_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(token, userId, expiresAt, userAgent || '', ip || '', new Date().toISOString());
  return { token, expiresAt };
}

function getSession(token) {
  if (!token) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return row;
}

function destroySession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function destroyAllSessionsForUser(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

// Throttled so a request burst doesn't turn into a write per request.
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;
function touchSession(row) {
  const last = row.last_used_at ? new Date(row.last_used_at).getTime() : 0;
  if (Date.now() - last < TOUCH_INTERVAL_MS) return;
  db.prepare('UPDATE sessions SET last_used_at = ? WHERE token = ?').run(new Date().toISOString(), row.token);
}

// Public, non-secret handle for a session row: the raw token is the cookie, so it never leaves the server.
function sessionId(token) {
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 20);
}

function listSessionsForUser(userId) {
  return db.prepare('SELECT token, created_at, last_used_at, user_agent, ip, expires_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY COALESCE(last_used_at, created_at) DESC')
    .all(userId, new Date().toISOString());
}

const COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;

function sessionCookie(req, token) {
  return `dismesh_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_S}${req.secure ? '; Secure' : ''}`;
}

module.exports = { createSession, getSession, destroySession, destroyAllSessionsForUser, sessionCookie, touchSession, sessionId, listSessionsForUser };
