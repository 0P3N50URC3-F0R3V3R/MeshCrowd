'use strict';

// Time-limited TURN credentials (the "TURN REST API" scheme used by coturn's use-auth-secret):
// username = "<unix expiry>:<label>", password = base64(HMAC-SHA1(secret, username)). The server
// never stores them and a leaked one stops working at its expiry. Only signed-in users are given one.

const crypto = require('node:crypto');

const passwordFor = (secret, username) => crypto.createHmac('sha1', secret).update(username).digest('base64');

function issue(secret, label, ttlSeconds, now = Date.now()) {
  const expiresAt = Math.floor(now / 1000) + Math.max(60, Math.trunc(ttlSeconds));
  const username = `${expiresAt}:${String(label).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 40)}`;
  return { username, credential: passwordFor(secret, username), expiresAt };
}

// Returns the label for a username that has not expired, else null (the signature is checked
// by the STUN message integrity itself).
function labelOf(username, now = Date.now()) {
  const i = username.indexOf(':');
  if (i < 1) return null;
  const expiry = Number(username.slice(0, i));
  if (!Number.isFinite(expiry) || expiry * 1000 < now) return null;
  return username.slice(i + 1);
}

function newSecret() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = { issue, labelOf, passwordFor, newSecret };
