'use strict';

const { db } = require('../db');

const DEFAULTS = {
  session_ttl_days: '30', // stored as text in `meta`; 0 or negative means "indefinite"
};

function get(key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : DEFAULTS[key];
}

function set(key, value) {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, String(value));
}

function getSessionTtlDays() {
  const raw = Number(get('session_ttl_days'));
  return Number.isFinite(raw) ? raw : Number(DEFAULTS.session_ttl_days);
}

// null = no allowlist restriction (only uploads.js's BLOCKED_EXTENSIONS denylist applies).
// Otherwise a list of lowercase extensions with their leading dot, e.g. ['.png', '.pdf'].
function getAllowedExtensions() {
  const raw = get('allowed_attachment_extensions');
  if (!raw) return null;
  const list = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.length ? list : null;
}

function setAllowedExtensions(list) {
  set('allowed_attachment_extensions', Array.isArray(list) ? list.join(',') : '');
}

module.exports = {
  get, set, getSessionTtlDays,
  getAllowedExtensions, setAllowedExtensions,
};
