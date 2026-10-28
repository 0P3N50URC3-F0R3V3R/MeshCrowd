'use strict';

const crypto = require('node:crypto');
const { db } = require('../db');
const { getSessionTtlDays } = require('./siteSettings');

// Site-admin-configurable (0 or negative = indefinite, represented as a far-future date rather
// than NULL so the `expires_at` column can stay NOT NULL — no schema migration needed for it).
const INDEFINITE_EXPIRY = '9999-12-31T00:00:00.000Z';

function createSession(userId, userAgent) {
  const token = crypto.randomBytes(32).toString('hex');
  const ttlDays = getSessionTtlDays();
  const expiresAt = ttlDays > 0
    ? new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString()
    : INDEFINITE_EXPIRY;
  db.prepare('INSERT INTO sessions (token, user_id, expires_at, user_agent) VALUES (?, ?, ?, ?)')
    .run(token, userId, expiresAt, userAgent || '');
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

const COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;

function sessionCookie(req, token) {
  return `dismesh_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_S}${req.secure ? '; Secure' : ''}`;
}

module.exports = { createSession, getSession, destroySession, destroyAllSessionsForUser, sessionCookie };
