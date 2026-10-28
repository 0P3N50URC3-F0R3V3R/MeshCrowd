'use strict';

const crypto = require('node:crypto');

const TOKEN_PREFIX = 'mcb_';

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

// 256 bits of randomness, so a plain SHA-256 is enough: there is nothing to brute-force.
function generateToken() {
  const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token), prefix: token.slice(0, TOKEN_PREFIX.length + 6) };
}

function generateWebhookSecret() {
  return `whsec_${crypto.randomBytes(24).toString('base64url')}`;
}

// "Authorization: Bot <token>" -> the token, or null.
function tokenFromHeader(header) {
  const m = /^Bot\s+(mcb_[A-Za-z0-9_-]{20,100})$/.exec(String(header || '').trim());
  return m ? m[1] : null;
}

module.exports = { TOKEN_PREFIX, hashToken, generateToken, generateWebhookSecret, tokenFromHeader };
