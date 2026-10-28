'use strict';

const siteSettings = require('../siteSettings');
const { parseEntry } = require('./ipMatch');

const KEY = 'security_settings';

const DEFAULTS = {
  captcha: {
    mode: 'after_failures', // off | after_failures | always
    failureThreshold: 3,
    failureWindowMinutes: 15,
    applyTo: { login: true, register: true },
    type: 'text', // text | words | math
    charset: 'alphanumeric', // digits | letters | alphanumeric (type text)
    length: 5,
    excludeAmbiguous: true,
    words: { source: 'builtin', lists: ['en'], count: 1, custom: [] }, // source: builtin | custom | both
    difficulty: 'medium', // easy | medium | hard
    ttlSeconds: 180,
  },
  protection: {
    mode: 'protect', // off | detect | protect
    requestsPerWindow: 900,
    windowSeconds: 10,
    banMinutes: 15,
    rateLimitStrikes: 20,
    strikeWindowMinutes: 5,
    failedLoginBan: { threshold: 30, windowMinutes: 10, banMinutes: 60 },
    registrationLimit: { enabled: true, max: 5, windowHours: 24 },
    honeypot: true,
    underAttack: { auto: true, trigger: 10, windowMinutes: 5, durationMinutes: 30 },
  },
  allowlist: ['127.0.0.1', '::1'],
};

const MAX_CUSTOM_WORDS = 2000;

// Custom words are shown as letters in the picture, so they are folded to a-z0-9 here and the
// answer is compared folded too: "Ház" is displayed and accepted as HAZ.
function foldWord(raw) {
  return String(raw).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function cleanWordList(input) {
  const lines = Array.isArray(input) ? input : String(input || '').split(/[\r\n,;]+/);
  const out = [];
  const seen = new Set();
  let rejected = 0;
  for (const line of lines) {
    if (!String(line).trim()) continue;
    const w = foldWord(line);
    if (w.length < 3 || w.length > 14 || seen.has(w)) { rejected += 1; continue; }
    if (out.length >= MAX_CUSTOM_WORDS) { rejected += 1; continue; }
    seen.add(w);
    out.push(w);
  }
  return { words: out, rejected };
}

const oneOf = (v, list, name) => {
  if (!list.includes(v)) throw new Error(`${name} must be one of: ${list.join(', ')}`);
  return v;
};
const int = (v, min, max, name) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number from ${min} to ${max}`);
  return n;
};
const bool = (v, name) => {
  if (typeof v !== 'boolean') throw new Error(`${name} must be true or false`);
  return v;
};

function mergeCaptcha(cur, p) {
  const next = { ...cur, applyTo: { ...cur.applyTo }, words: { ...cur.words } };
  if (p.mode !== undefined) next.mode = oneOf(p.mode, ['off', 'after_failures', 'always'], 'captcha.mode');
  if (p.failureThreshold !== undefined) next.failureThreshold = int(p.failureThreshold, 1, 100, 'captcha.failureThreshold');
  if (p.failureWindowMinutes !== undefined) next.failureWindowMinutes = int(p.failureWindowMinutes, 1, 1440, 'captcha.failureWindowMinutes');
  if (p.applyTo !== undefined) {
    if (p.applyTo.login !== undefined) next.applyTo.login = bool(p.applyTo.login, 'captcha.applyTo.login');
    if (p.applyTo.register !== undefined) next.applyTo.register = bool(p.applyTo.register, 'captcha.applyTo.register');
  }
  if (p.type !== undefined) next.type = oneOf(p.type, ['text', 'words', 'math'], 'captcha.type');
  if (p.charset !== undefined) next.charset = oneOf(p.charset, ['digits', 'letters', 'alphanumeric'], 'captcha.charset');
  if (p.length !== undefined) next.length = int(p.length, 3, 10, 'captcha.length');
  if (p.excludeAmbiguous !== undefined) next.excludeAmbiguous = bool(p.excludeAmbiguous, 'captcha.excludeAmbiguous');
  if (p.difficulty !== undefined) next.difficulty = oneOf(p.difficulty, ['easy', 'medium', 'hard'], 'captcha.difficulty');
  if (p.ttlSeconds !== undefined) next.ttlSeconds = int(p.ttlSeconds, 30, 1800, 'captcha.ttlSeconds');
  if (p.words !== undefined) {
    const w = p.words;
    if (w.source !== undefined) next.words.source = oneOf(w.source, ['builtin', 'custom', 'both'], 'captcha.words.source');
    if (w.lists !== undefined) {
      if (!Array.isArray(w.lists) || !w.lists.every((l) => ['en', 'hu'].includes(l)) || w.lists.length === 0) throw new Error('captcha.words.lists must contain en and/or hu');
      next.words.lists = [...new Set(w.lists)];
    }
    if (w.count !== undefined) next.words.count = int(w.count, 1, 3, 'captcha.words.count');
    if (w.custom !== undefined) next.words.custom = cleanWordList(w.custom).words;
  }
  if (next.type === 'words' && next.words.source === 'custom' && next.words.custom.length < 10) {
    throw new Error('add at least 10 custom words, or use the built-in list');
  }
  return next;
}

function mergeProtection(cur, p) {
  const next = {
    ...cur,
    failedLoginBan: { ...cur.failedLoginBan },
    registrationLimit: { ...cur.registrationLimit },
    underAttack: { ...cur.underAttack },
  };
  if (p.mode !== undefined) next.mode = oneOf(p.mode, ['off', 'detect', 'protect'], 'protection.mode');
  if (p.requestsPerWindow !== undefined) next.requestsPerWindow = int(p.requestsPerWindow, 20, 1_000_000, 'protection.requestsPerWindow');
  if (p.windowSeconds !== undefined) next.windowSeconds = int(p.windowSeconds, 1, 300, 'protection.windowSeconds');
  if (p.banMinutes !== undefined) next.banMinutes = int(p.banMinutes, 1, 525600, 'protection.banMinutes');
  if (p.rateLimitStrikes !== undefined) next.rateLimitStrikes = int(p.rateLimitStrikes, 3, 10000, 'protection.rateLimitStrikes');
  if (p.strikeWindowMinutes !== undefined) next.strikeWindowMinutes = int(p.strikeWindowMinutes, 1, 1440, 'protection.strikeWindowMinutes');
  if (p.honeypot !== undefined) next.honeypot = bool(p.honeypot, 'protection.honeypot');
  if (p.failedLoginBan !== undefined) {
    const f = p.failedLoginBan;
    if (f.threshold !== undefined) next.failedLoginBan.threshold = int(f.threshold, 3, 10000, 'protection.failedLoginBan.threshold');
    if (f.windowMinutes !== undefined) next.failedLoginBan.windowMinutes = int(f.windowMinutes, 1, 1440, 'protection.failedLoginBan.windowMinutes');
    if (f.banMinutes !== undefined) next.failedLoginBan.banMinutes = int(f.banMinutes, 1, 525600, 'protection.failedLoginBan.banMinutes');
  }
  if (p.registrationLimit !== undefined) {
    const r = p.registrationLimit;
    if (r.enabled !== undefined) next.registrationLimit.enabled = bool(r.enabled, 'protection.registrationLimit.enabled');
    if (r.max !== undefined) next.registrationLimit.max = int(r.max, 1, 1000, 'protection.registrationLimit.max');
    if (r.windowHours !== undefined) next.registrationLimit.windowHours = int(r.windowHours, 1, 720, 'protection.registrationLimit.windowHours');
  }
  if (p.underAttack !== undefined) {
    const u = p.underAttack;
    if (u.auto !== undefined) next.underAttack.auto = bool(u.auto, 'protection.underAttack.auto');
    if (u.trigger !== undefined) next.underAttack.trigger = int(u.trigger, 2, 1000, 'protection.underAttack.trigger');
    if (u.windowMinutes !== undefined) next.underAttack.windowMinutes = int(u.windowMinutes, 1, 120, 'protection.underAttack.windowMinutes');
    if (u.durationMinutes !== undefined) next.underAttack.durationMinutes = int(u.durationMinutes, 1, 1440, 'protection.underAttack.durationMinutes');
  }
  return next;
}

function normalizeAllowlist(list) {
  if (!Array.isArray(list) || list.length > 200) throw new Error('allowlist must be a list of at most 200 entries');
  const out = [];
  for (const raw of list) {
    const parsed = parseEntry(String(raw));
    if (!parsed) throw new Error(`"${String(raw).slice(0, 60)}" is not an IP address, range or CIDR`);
    if (!out.includes(parsed.entry)) out.push(parsed.entry);
  }
  return out;
}

let cached = null;

function load() {
  if (cached) return cached;
  let stored = {};
  try { stored = JSON.parse(siteSettings.get(KEY) || '{}'); } catch { stored = {}; }
  let merged = { captcha: DEFAULTS.captcha, protection: DEFAULTS.protection, allowlist: DEFAULTS.allowlist };
  try { merged = { ...merged, captcha: mergeCaptcha(DEFAULTS.captcha, stored.captcha || {}) }; } catch { /* keep defaults */ }
  try { merged = { ...merged, protection: mergeProtection(DEFAULTS.protection, stored.protection || {}) }; } catch { /* keep defaults */ }
  if (Array.isArray(stored.allowlist)) { try { merged.allowlist = normalizeAllowlist(stored.allowlist); } catch { /* keep defaults */ } }
  cached = merged;
  return cached;
}

// Validates and persists a partial settings object; throws an Error with a user-facing message.
function update(patch) {
  const cur = load();
  const next = {
    captcha: patch.captcha ? mergeCaptcha(cur.captcha, patch.captcha) : cur.captcha,
    protection: patch.protection ? mergeProtection(cur.protection, patch.protection) : cur.protection,
    allowlist: patch.allowlist !== undefined ? normalizeAllowlist(patch.allowlist) : cur.allowlist,
  };
  siteSettings.set(KEY, JSON.stringify(next));
  cached = next;
  return next;
}

// For tests that reopen settings from the database.
function reset() { cached = null; }

module.exports = { DEFAULTS, load, update, reset, cleanWordList, foldWord, MAX_CUSTOM_WORDS, mergeCaptcha };
