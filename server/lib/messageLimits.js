'use strict';

const { load } = require('./config');

const MIN_CHARS = 100;
const MAX_CHARS = 100000;
const DEFAULT_CHARS = 15000;

let cached = null;

// Per-message character cap for plaintext content. Restart-only (config.json: maxMessageChars);
function maxMessageChars() {
  if (cached === null) {
    const n = Math.floor(Number(load().maxMessageChars));
    cached = Number.isFinite(n) ? Math.min(MAX_CHARS, Math.max(MIN_CHARS, n)) : DEFAULT_CHARS;
  }
  return cached;
}

// Absent content counts as empty; anything but a string is refused, and an over-long text is
// rejected (never truncated) so the client can offer to send it as a file instead.
function readContent(raw, { trim = false } = {}) {
  if (raw === undefined || raw === null) return { content: '' };
  if (typeof raw !== 'string') return { status: 400, body: { error: 'content must be a string', code: 'invalid_content' } };
  const content = trim ? raw.trim() : raw;
  const maxChars = maxMessageChars();
  if (content.length > maxChars) return { status: 413, body: { error: 'message too long', code: 'message_too_long', maxChars } };
  return { content };
}

module.exports = { maxMessageChars, readContent, DEFAULT_CHARS };
