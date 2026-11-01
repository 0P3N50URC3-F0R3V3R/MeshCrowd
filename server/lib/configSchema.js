'use strict';

const { DEFAULTS } = require('./config');

// registrationMode is re-read from the config on every request; the logging keys go through the logger.
const LIVE = new Set(['registrationMode', 'logging.level', 'logging.keepDays', 'logging.maxFileMb']);
const SECRET = new Set(['turn.secret']);

const port = { min: 1, max: 65535 };
const OVERRIDES = {
  port,
  httpsPort: port,
  maxUploadMb: { min: 1, max: 10240 },
  maxMessageChars: { min: 100, max: 100000 },
  registrationMode: { enum: ['open', 'closed', 'invite'] },
  trustProxy: { type: 'json', looseString: true, check: 'trustProxy' },
  iceServers: { type: 'json', array: true, check: 'iceServers' },
  passportOrigins: { type: 'json', array: true },
  'sites.maxWorkers': { min: 1, max: 16 },
  'turn.port': port,
  'turn.relayPortMin': port,
  'turn.relayPortMax': port,
  'turn.credentialTtlSeconds': { min: 60, max: 31536000 },
  'turn.maxAllocations': { min: 1, max: 1000000 },
  'turn.maxAllocationsPerUser': { min: 1, max: 1000000 },
  'turn.maxKbps': { min: 0, max: 10000000 },
  'logging.level': { enum: ['debug', 'info', 'warn', 'error'] },
  'logging.keepDays': { min: 1, max: 3650 },
  'logging.maxFileMb': { min: 1, max: 1024 },
  'ssh.port': port,
  'ssh.maxSessions': { min: 1, max: 100 },
  'ssh.idleTimeoutMinutes': { min: 1, max: 1440 },
  'backup.keep': { min: 1, max: 100 },
  'backup.maxFileMb': { min: 1, max: 1024 },
  'backup.preRestoreKeep': { min: 0, max: 100 },
};

function typeOf(value) {
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string') return 'string';
  return 'json';
}

function walk(obj, prefix, out) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) { walk(v, key, out); continue; }
    out[key] = { type: typeOf(v), restart: !LIVE.has(key), secret: SECRET.has(key), ...OVERRIDES[key] };
  }
  return out;
}

const SCHEMA = walk(DEFAULTS, '', {});

function describe() { return SCHEMA; }

function distance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function suggest(key) {
  const lower = String(key).toLowerCase();
  const keys = Object.keys(SCHEMA);
  const exact = keys.find((k) => k.toLowerCase() === lower);
  if (exact) return exact;
  const related = keys
    .filter((k) => { const kl = k.toLowerCase(); return kl.includes(lower) ? lower.length >= 3 : lower.includes(kl); })
    .sort((x, y) => y.length - x.length);
  if (related.length) return related[0];
  let best = null;
  let bestScore = Infinity;
  for (const k of keys) {
    const score = distance(lower, k.toLowerCase());
    if (score < bestScore) { best = k; bestScore = score; }
  }
  return bestScore <= Math.min(2, Math.floor(lower.length / 3)) ? best : null;
}

function lookup(key) {
  const entry = Object.hasOwn(SCHEMA, key) ? SCHEMA[key] : null;
  if (!entry) {
    const s = suggest(key);
    throw new Error(`unknown config key: ${key}${s ? `, did you mean ${s}?` : ''}`);
  }
  return entry;
}

function checkIceServers(key, list) {
  list.forEach((e, i) => {
    const urlsOk = e && typeof e === 'object' && !Array.isArray(e)
      && ((typeof e.urls === 'string' && e.urls !== '') || (Array.isArray(e.urls) && e.urls.length > 0 && e.urls.every((u) => typeof u === 'string' && u !== '')));
    if (!urlsOk) throw new Error(`${key}[${i}] must be an object with a string or string-array "urls"`);
  });
}

function checkTrustProxy(key, value) {
  const ok = typeof value === 'boolean' || typeof value === 'string' || (Number.isInteger(value) && value >= 0);
  if (!ok) throw new Error(`${key} must be true, false, a non-negative integer hop count or a string`);
}

function coerce(key, raw) {
  const spec = lookup(key);
  const text = String(raw);
  if (spec.type === 'number') {
    const n = Number(text);
    if (!/^-?\d+$/.test(text.trim()) || !Number.isSafeInteger(n)) throw new Error(`${key} must be an integer, got "${text}"`);
    if (spec.min !== undefined && n < spec.min) throw new Error(`${key} must be at least ${spec.min}`);
    if (spec.max !== undefined && n > spec.max) throw new Error(`${key} must be at most ${spec.max}`);
    return n;
  }
  if (spec.type === 'boolean') {
    const t = text.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(t)) return true;
    if (['false', '0', 'no', 'off'].includes(t)) return false;
    throw new Error(`${key} must be true or false, got "${text}"`);
  }
  if (spec.type === 'json') {
    let value;
    try { value = JSON.parse(text); } catch {
      if (!spec.looseString) throw new Error(`${key} must be valid JSON`);
      value = text;
    }
    if (spec.array && !Array.isArray(value)) throw new Error(`${key} must be a JSON array`);
    if (spec.check === 'iceServers') checkIceServers(key, value);
    if (spec.check === 'trustProxy') checkTrustProxy(key, value);
    return value;
  }
  if (spec.enum && !spec.enum.includes(text)) throw new Error(`${key} must be one of: ${spec.enum.join(', ')}`);
  return text;
}

function defaultOf(key) {
  lookup(key);
  return key.split('.').reduce((o, p) => o[p], DEFAULTS);
}

module.exports = { describe, coerce, lookup, suggest, defaultOf };
