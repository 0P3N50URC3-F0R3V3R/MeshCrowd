'use strict';

const { load } = require('./config');

const MIN_CHARS = 100;
const MAX_CHARS = 100000;
const DEFAULT_CHARS = 15000;

let cached = null;

// Per-message character cap for plaintext content. Restart-only (config.json: maxMessageChars);
// encrypted DM envelopes keep their own fixed bound (see lib/e2ee).
function maxMessageChars() {
  if (cached === null) {
    const n = Math.floor(Number(load().maxMessageChars));
    cached = Number.isFinite(n) ? Math.min(MAX_CHARS, Math.max(MIN_CHARS, n)) : DEFAULT_CHARS;
  }
  return cached;
}

module.exports = { maxMessageChars, DEFAULT_CHARS };
