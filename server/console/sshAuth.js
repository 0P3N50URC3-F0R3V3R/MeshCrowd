'use strict';

const net = require('node:net');
const { db } = require('../db');
const splitAuth = require('../lib/splitAuth');
const guard = require('../lib/security/guard');
const { normalizeIp } = require('../lib/security/ipMatch');
const { canUseConsole } = require('../lib/siteAuth');
const { checkSecondFactor } = require('../lib/secondFactor');
const logger = require('../lib/logger');

const log = logger.scoped('ssh');

const MAX_FAILURES = 5;
const WINDOW_MS = 10 * 60_000;
const LOCKOUT_MS = 10 * 60_000;
const USER_MAX_FAILURES = 20;
const MAX_PASSWORD = 1024;
const MAX_USERNAME = 254;
// One verification (Argon2id + bcrypt-12) blocks the event loop for about 350 ms, synchronously, so a concurrency
// cap cannot work and the only lever is the rate. 1 per second keeps verification under ~35% of the loop for
// everyone else; the burst of 3 is a single ~1 s stall.
const DEFAULT_LIMITER = Object.freeze({ capacity: 3, refillPerSec: 1 });
const DENIED = Object.freeze({ ok: false });
// Clients that offer password and keyboard-interactive send the same wrong password twice; that is one guess.
const DUPLICATE_FAIL_MS = 2000;

let clock = () => Date.now();
let limits = { ips: 10_000, users: 10_000 };
let limiter = { ...DEFAULT_LIMITER };
let tokens = limiter.capacity;
let tokenAt = null;
const recentFails = new WeakMap();

// key -> { fails: number[], lockedUntil: number }. Insertion order is recency order, locked entries are never evicted.
class Tracker {
  constructor(max) { this.map = new Map(); this.max = () => max(); }

  isLocked(key) {
    const e = this.map.get(key);
    return !!e && e.lockedUntil > clock();
  }

  entry(key, now) {
    let e = this.map.get(key);
    if (e) {
      this.map.delete(key);
    } else {
      while (this.map.size >= this.max()) {
        let victim = null;
        for (const [k, v] of this.map) if (v.lockedUntil <= now) { victim = k; break; }
        if (victim === null) return null;
        this.map.delete(victim);
      }
      e = { fails: [], lockedUntil: 0 };
    }
    this.map.set(key, e);
    return e;
  }

  // true when this failure started a lockout
  fail(key, limit, lockMs) {
    const now = clock();
    const e = this.entry(key, now);
    if (!e) return false;
    e.fails = e.fails.filter((t) => now - t < WINDOW_MS);
    e.fails.push(now);
    if (e.fails.length < limit) return false;
    e.lockedUntil = now + lockMs;
    e.fails = [];
    return true;
  }
}

const ips = new Tracker(() => limits.ips);
const names = new Tracker(() => limits.users);

let cryptoModule = null;
async function deriveAuthKeys(password, authSalt) {
  if (!cryptoModule) cryptoModule = await import('../../web/js/e2ee/crypto.mjs');
  return cryptoModule.deriveAuthKeys(password, authSalt);
}

function cleanName(name) {
  return String(name ?? '').replace(/[^\x20-\x7e\u00a0-\uffff]|[\u200b-\u200f\u2028-\u202e\u2066-\u2069\ud800-\udfff]/g, '?').slice(0, 64);
}

function expandV6(address) {
  let s = address.split('%')[0];
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (v4) s = s.slice(0, v4.index) + ((Number(v4[1]) << 8) | Number(v4[2])).toString(16) + ':' + ((Number(v4[3]) << 8) | Number(v4[4])).toString(16);
  const dc = s.indexOf('::');
  const head = (dc >= 0 ? s.slice(0, dc) : s).split(':').filter((g) => g !== '');
  const tail = dc >= 0 ? s.slice(dc + 2).split(':').filter((g) => g !== '') : [];
  return [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail];
}

// One IPv6 /64 is a single subscriber, so it is a single lockout bucket. IPv4-mapped addresses count as IPv4.
function ipBucket(ip) {
  const n = normalizeIp(String(ip ?? ''));
  if (!n) return `raw:${String(ip ?? 'unknown').slice(0, 64)}`;
  if (net.isIPv4(n)) return n;
  return `${expandV6(n).slice(0, 4).map((g) => g.padStart(4, '0')).join(':')}::/64`;
}

function takeToken(now) {
  if (tokenAt === null) tokenAt = now;
  tokens = Math.min(limiter.capacity, tokens + ((now - tokenAt) / 1000) * limiter.refillPerSec);
  tokenAt = now;
  if (tokens < 1) return false;
  tokens -= 1;
  return true;
}

function isLoopback(addr) {
  const n = normalizeIp(addr);
  return n === '::1' || /^127\./.test(n);
}

// Malformed requests and limiter refusals say nothing about a guessed password, so they must not feed lockouts
// (otherwise they are a free way to lock an admin out).
const UNCOUNTED = new Set(['malformed', 'busy']);

function duplicateFailure(conn, name) {
  if (!conn || typeof conn !== 'object') return false;
  const now = clock();
  const key = cleanName(name).toLowerCase();
  let seen = recentFails.get(conn);
  if (!seen) { seen = new Map(); recentFails.set(conn, seen); }
  const last = seen.get(key);
  seen.set(key, now);
  return last !== undefined && now - last < DUPLICATE_FAIL_MS;
}

function fail(name, addr, bucket, reason, conn) {
  if (UNCOUNTED.has(reason)) {
    log.warn(`[ssh] login failed user=${cleanName(name)} ip=${addr} reason=${reason}`);
    return DENIED;
  }
  if (duplicateFailure(conn, name)) {
    log.warn(`[ssh] login failed user=${cleanName(name)} ip=${addr} reason=${reason}`);
    return DENIED;
  }
  if (ips.fail(bucket, MAX_FAILURES, LOCKOUT_MS)) {
    log.warn(`[ssh] ip=${addr} locked out for ${LOCKOUT_MS / 60_000} minutes after ${MAX_FAILURES} failed logins`);
  }
  const nameKey = cleanName(name).toLowerCase();
  if (names.fail(nameKey, USER_MAX_FAILURES, LOCKOUT_MS)) {
    log.warn(`[ssh] user=${cleanName(name)} refused for ${LOCKOUT_MS / 60_000} minutes after ${USER_MAX_FAILURES} failed logins from any address`);
  }
  log.warn(`[ssh] login failed user=${cleanName(name)} ip=${addr} reason=${reason}`);
  guard.noteFailure(addr);
  return DENIED;
}

// Every path that reaches the password check runs exactly one bcrypt compare (splitAuth.checkLogin), and
// unknown names also run the argon2 derivation against a stable fake salt, so timing does not tell
// unknown, split and legacy accounts apart beyond what /api/auth/login-params already publishes.
async function authenticate({ username, password, totp, ip, conn }) {
  const addr = String(ip || 'unknown');
  const bucket = ipBucket(addr);
  const verdict = guard.check(addr);
  if (verdict.blocked) {
    log.debug(`[ssh] login refused user=${cleanName(username)} ip=${addr} reason=blocked`);
    return DENIED;
  }
  const exempt = !!verdict.allowlisted || isLoopback(addr);
  if (ips.isLocked(bucket)) {
    log.debug(`[ssh] login refused user=${cleanName(username)} ip=${addr} reason=locked`);
    return DENIED;
  }
  if (typeof username !== 'string' || username.length < 1 || username.length > MAX_USERNAME
    || typeof password !== 'string' || password.length > MAX_PASSWORD) {
    return fail(username, addr, bucket, 'malformed', conn);
  }
  if (!exempt && names.isLocked(cleanName(username).toLowerCase())) {
    log.debug(`[ssh] login refused user=${cleanName(username)} ip=${addr} reason=user_locked`);
    return DENIED;
  }
  if (!ips.entry(bucket, clock()) && !exempt) {
    log.warn(`[ssh] login refused ip=${addr}: lockout table is full of active lockouts`);
    return DENIED;
  }
  if (!takeToken(clock())) return fail(username, addr, bucket, 'busy', conn);

  const user = splitAuth.findLoginUser(username);
  let outcome;
  if (user && user.auth_mode === 'split') {
    let authKey = null;
    try {
      authKey = (await deriveAuthKeys(password, user.auth_salt)).authKey;
    } catch {
      authKey = null;
    }
    outcome = splitAuth.checkLogin(user, { authKey });
    authKey = null;
  } else if (user) {
    outcome = splitAuth.checkLogin(user, { password });
  } else {
    const params = splitAuth.loginParams(username);
    try {
      await deriveAuthKeys(password, params.salt);
    } catch { /* equal-cost only */ }
    outcome = splitAuth.checkLogin(null, { password });
  }

  if (outcome !== 'ok') return fail(username, addr, bucket, 'bad_credentials', conn);
  if (user.is_disabled) return fail(username, addr, bucket, 'disabled', conn);
  if (!canUseConsole(user.id)) return fail(username, addr, bucket, 'no_permission', conn);

  if (user.totp_enabled) {
    if (totp === undefined || totp === null || totp === '') return { ok: false, needTotp: true };
    if (typeof totp !== 'string' || totp.length > 64 || !checkSecondFactor(user, totp)) return fail(username, addr, bucket, 'bad_totp', conn);
  }

  ips.map.delete(bucket);
  names.map.delete(cleanName(username).toLowerCase());
  log.info(`[ssh] login ok user=${cleanName(user.username)} ip=${addr}`);
  return { ok: true, user: { id: user.id, username: user.username } };
}

function stillAllowed(userId) {
  const u = db.prepare('SELECT is_disabled FROM users WHERE id = ?').get(userId);
  return !!u && !u.is_disabled && canUseConsole(userId);
}

module.exports = {
  authenticate, stillAllowed, cleanName, ipBucket,
  _test: {
    setClock(fn) { clock = fn; },
    setLimits(l) { limits = { ...limits, ...l }; },
    setLimiter(l) { limiter = { ...limiter, ...l }; tokens = limiter.capacity; tokenAt = null; },
    reset() {
      ips.map.clear();
      names.map.clear();
      limiter = { ...DEFAULT_LIMITER };
      tokens = limiter.capacity;
      tokenAt = null;
      limits = { ips: 10_000, users: 10_000 };
    },
  },
};
