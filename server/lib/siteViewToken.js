'use strict';

const crypto = require('node:crypto');
const { getSession } = require('./session');

// A site page runs author-controlled script in an opaque origin, so it never carries the app session
// cookie. Instead the app mints a capability for one site and one viewer and puts it in the iframe URL
// path (/site/<id>/~<token>/...), so relative links and fetches inherit it. It is valid for that site
// only, dies with the session it was minted from, and is lost on a server restart (the app re-mints).
const TTL_MS = 12 * 60 * 60 * 1000;
const MAX_TOKENS = 20000;
const tokens = new Map();

function sweep(now) {
  for (const [k, v] of tokens) if (v.exp < now) tokens.delete(k);
  if (tokens.size >= MAX_TOKENS) {
    const drop = tokens.size - MAX_TOKENS + 1000;
    let i = 0;
    for (const k of tokens.keys()) { if (i++ >= drop) break; tokens.delete(k); }
  }
}

function mint(siteId, userId, sessionToken) {
  const now = Date.now();
  if (tokens.size >= MAX_TOKENS) sweep(now);
  const token = crypto.randomBytes(24).toString('base64url');
  tokens.set(token, { siteId: Number(siteId), userId, sessionToken, exp: now + TTL_MS });
  return token;
}

function verify(token, siteId) {
  const rec = typeof token === 'string' ? tokens.get(token) : null;
  if (!rec) return null;
  const now = Date.now();
  if (rec.exp < now || rec.siteId !== Number(siteId) || !getSession(rec.sessionToken)) {
    if (rec.exp < now || !getSession(rec.sessionToken)) tokens.delete(token);
    return null;
  }
  rec.exp = now + TTL_MS;
  return { userId: rec.userId };
}

module.exports = { mint, verify };
