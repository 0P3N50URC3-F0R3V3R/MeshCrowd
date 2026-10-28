'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { db } = require('../db');

const LANG_DIR = path.join(__dirname, '..', '..', 'lang');
if (!fs.existsSync(LANG_DIR)) fs.mkdirSync(LANG_DIR, { recursive: true });

const CODE_RE = /^[a-z]{2,8}$/;
const BANNED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Strict allowlist, checked before the code ever touches a filesystem path — the only thing
// standing between an admin-facing "language code" field and path traversal.
function sanitizeCode(code) {
  if (typeof code !== 'string') return null;
  return CODE_RE.test(code) ? code : null;
}

function pathForCode(code) {
  const safe = sanitizeCode(code);
  if (!safe) return null;
  const full = path.join(LANG_DIR, `${safe}.json`);
  // Belt-and-suspenders: even with the regex above, confirm the resolved path never escapes LANG_DIR.
  if (path.dirname(full) !== LANG_DIR) return null;
  return full;
}

// Recursively collects every leaf as a dot-path (e.g. "chat.userJoined") and rejects any shape
// that isn't a plain object nesting down to string leaves, or that carries a prototype-pollution
// key at any depth.
function collectKeys(node, prefix, keys) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    return { ok: false, reason: `"${prefix || '(root)'}" must be an object` };
  }
  for (const key of Object.keys(node)) {
    if (BANNED_KEYS.has(key)) return { ok: false, reason: `disallowed key "${key}"` };
    const dotPath = prefix ? `${prefix}.${key}` : key;
    const value = node[key];
    if (value !== null && typeof value === 'object') {
      if (Array.isArray(value)) return { ok: false, reason: `"${dotPath}" must be an object, not an array` };
      const nested = collectKeys(value, dotPath, keys);
      if (!nested.ok) return nested;
    } else if (typeof value === 'string') {
      keys.add(dotPath);
    } else {
      return { ok: false, reason: `"${dotPath}" must be a string` };
    }
  }
  return { ok: true };
}

// Validates a parsed (already JSON.parse'd) language file candidate.
function validateLanguageJson(candidate) {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { ok: false, reason: 'file must contain a JSON object' };
  }
  const keys = new Set();
  const result = collectKeys(candidate, '', keys);
  if (!result.ok) return result;
  return { ok: true, keys };
}

// Compares an uploaded translation's keys against the base (en.json) template's keys.
function diffKeys(candidateKeys, baseKeys) {
  const missing = [...baseKeys].filter((k) => !candidateKeys.has(k));
  const extra = [...candidateKeys].filter((k) => !baseKeys.has(k));
  return { missing, extra };
}

function readLanguageFile(code) {
  const filePath = pathForCode(code);
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeLanguageFile(code, data) {
  const filePath = pathForCode(code);
  if (!filePath) throw new Error('invalid language code');
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function listLanguages({ onlyEnabled = false } = {}) {
  const rows = db.prepare('SELECT code, name, enabled, builtin FROM languages ORDER BY builtin DESC, name ASC').all();
  return onlyEnabled ? rows.filter((r) => r.enabled) : rows;
}

function getLanguage(code) {
  const safe = sanitizeCode(code);
  if (!safe) return null;
  return db.prepare('SELECT code, name, enabled, builtin FROM languages WHERE code = ?').get(safe) || null;
}

module.exports = {
  LANG_DIR, CODE_RE, sanitizeCode, pathForCode, validateLanguageJson, diffKeys,
  readLanguageFile, writeLanguageFile, listLanguages, getLanguage,
};
