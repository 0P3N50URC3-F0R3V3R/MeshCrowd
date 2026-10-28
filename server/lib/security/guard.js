'use strict';

const { db } = require('../../db');
const settings = require('./settings');
const captcha = require('./captcha');
const { normalizeIp, parseEntry, IpSet, entryCovers } = require('./ipMatch');
const logger = require('../logger');

let clock = () => Date.now();
const iso = (ms) => new Date(ms).toISOString();

// ---- ban state ----------------------------------------------------------------------------------

const state = {
  banSet: new IpSet(),
  lists: [], // { id, name, set }
  allow: new IpSet(),
  verdicts: new Map(), // ip -> { v, t }
};
const VERDICT_TTL_MS = 30_000;

function rebuild() {
  const now = iso(clock());
  const rows = db.prepare('SELECT entry FROM ip_bans WHERE expires_at IS NULL OR expires_at > ?').all(now);
  state.banSet = new IpSet(rows.map((r) => parseEntry(r.entry)));
  state.lists = db.prepare('SELECT id, name, entries FROM ip_blocklists WHERE enabled = 1').all()
    .map((l) => ({ id: l.id, name: l.name, set: new IpSet(l.entries.split('\n').map(parseEntry)) }));
  state.allow = new IpSet(settings.load().allowlist.map(parseEntry));
  state.verdicts.clear();
}

// { blocked, allowlisted, source }. Allowlisted addresses are never blocked, even when a ban or a
// subscribed list covers them: the allowlist is how an admin recovers from a bad entry.
function check(ip) {
  const n = normalizeIp(ip);
  if (!n) return { blocked: false, allowlisted: false };
  const hit = state.verdicts.get(n);
  const now = clock();
  if (hit && now - hit.t < VERDICT_TTL_MS) return hit.v;
  let v;
  if (state.allow.has(n)) v = { blocked: false, allowlisted: true };
  else if (state.banSet.has(n)) v = { blocked: true, allowlisted: false, source: 'ban' };
  else {
    const list = state.lists.find((l) => l.set.has(n));
    v = list ? { blocked: true, allowlisted: false, source: 'blocklist', list: list.name } : { blocked: false, allowlisted: false };
  }
  if (state.verdicts.size > 20000) state.verdicts.clear();
  state.verdicts.set(n, { v, t: now });
  return v;
}

// ---- events -------------------------------------------------------------------------------------

let eventWrites = 0;

function event(type, ip, detail) {
  try {
    db.prepare('INSERT INTO security_events (ts, type, ip, detail) VALUES (?, ?, ?, ?)')
      .run(iso(clock()), type, ip || null, detail === undefined ? null : JSON.stringify(detail));
    eventWrites += 1;
    if (eventWrites % 200 === 0) {
      db.prepare('DELETE FROM security_events WHERE ts < ?').run(iso(clock() - 30 * 86400_000));
      db.prepare('DELETE FROM security_events WHERE id <= (SELECT MAX(id) FROM security_events) - 10000').run();
    }
  } catch (err) {
    logger.error('[security] could not record event:', err);
  }
}

const blockedLogged = new Map(); // ip -> last logged ms
const counters = { blocked: 0 };

// ---- bans ---------------------------------------------------------------------------------------

function addBan(entry, { reason = '', source = 'manual', minutes = null, userId = null } = {}) {
  const parsed = parseEntry(entry);
  if (!parsed) throw new Error('not a valid IP address, range or CIDR');
  const expires = minutes ? iso(clock() + minutes * 60_000) : null;
  db.prepare(
    `INSERT INTO ip_bans (entry, reason, source, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(entry) DO UPDATE SET reason = excluded.reason, source = excluded.source, expires_at = excluded.expires_at`
  ).run(parsed.entry, String(reason).slice(0, 200), source, userId, iso(clock()), expires);
  rebuild();
  return db.prepare('SELECT * FROM ip_bans WHERE entry = ?').get(parsed.entry);
}

function removeBan(id) {
  const info = db.prepare('DELETE FROM ip_bans WHERE id = ?').run(id);
  if (info.changes) rebuild();
  return info.changes > 0;
}

function sweepExpired() {
  const info = db.prepare('DELETE FROM ip_bans WHERE expires_at IS NOT NULL AND expires_at <= ?').run(iso(clock()));
  if (info.changes) rebuild();
  return info.changes;
}

// ---- failure, flood and strike tracking ---------------------------------------------------------

const failures = new Map(); // ip -> [ms]
const floods = new Map(); // ip -> { start, count, fired }
const strikes = new Map(); // ip -> [ms]
const registrations = new Map(); // ip -> [ms]
const autoBanTimes = [];
let underAttackUntil = 0;

const within = (list, windowMs) => {
  const cutoff = clock() - windowMs;
  let n = 0;
  for (let i = list.length - 1; i >= 0 && list[i] > cutoff; i--) n += 1;
  return n;
};
const push = (map, ip, keepMs) => {
  const now = clock();
  const list = (map.get(ip) || []).filter((t) => t > now - keepMs);
  list.push(now);
  if (list.length > 2000) list.shift();
  map.set(ip, list);
  return list;
};

function autoBan(ip, minutes, reason, extra) {
  const cfg = settings.load().protection;
  if (cfg.mode !== 'protect') {
    event('threat_detected', ip, { reason, ...extra });
    return false;
  }
  if (check(ip).allowlisted || check(ip).blocked) return false;
  addBan(ip, { reason, source: 'auto', minutes });
  event('ban_auto', ip, { reason, minutes, ...extra });
  const now = clock();
  autoBanTimes.push(now);
  while (autoBanTimes.length && autoBanTimes[0] < now - 3600_000) autoBanTimes.shift();
  const ua = cfg.underAttack;
  if (ua.auto && !isUnderAttack() && within(autoBanTimes, ua.windowMinutes * 60_000) >= ua.trigger) {
    setUnderAttack(ua.durationMinutes, 'auto');
  }
  return true;
}

// Returns true when this call tripped the flood limit and banned the address.
function noteRequest(ip) {
  const cfg = settings.load().protection;
  if (cfg.mode === 'off') return false;
  const now = clock();
  const windowMs = cfg.windowSeconds * 1000;
  let f = floods.get(ip);
  if (!f || now - f.start >= windowMs) { f = { start: now, count: 0, fired: false }; floods.set(ip, f); }
  f.count += 1;
  if (f.count > cfg.requestsPerWindow && !f.fired) {
    f.fired = true;
    return autoBan(ip, cfg.banMinutes, 'request flood', { requests: f.count, windowSeconds: cfg.windowSeconds });
  }
  return false;
}

function noteRateLimited(ip) {
  const cfg = settings.load().protection;
  if (cfg.mode === 'off' || !ip || check(ip).allowlisted) return;
  const list = push(strikes, ip, cfg.strikeWindowMinutes * 60_000);
  if (list.length >= cfg.rateLimitStrikes) {
    strikes.delete(ip);
    autoBan(ip, cfg.banMinutes, 'repeated rate-limit violations', { strikes: list.length });
  }
}

function noteFailure(ip) {
  const cfg = settings.load().protection;
  const keep = Math.max(cfg.failedLoginBan.windowMinutes, settings.load().captcha.failureWindowMinutes) * 60_000;
  const list = push(failures, ip, keep);
  if (cfg.mode === 'off' || check(ip).allowlisted) return;
  const fb = cfg.failedLoginBan;
  if (within(list, fb.windowMinutes * 60_000) >= fb.threshold) {
    failures.delete(ip);
    autoBan(ip, fb.banMinutes, 'too many failed sign-ins', { threshold: fb.threshold });
  }
}

const failureCount = (ip, windowMinutes) => within(failures.get(ip) || [], windowMinutes * 60_000);
const clearFailures = (ip) => failures.delete(ip);

function noteRegistration(ip) {
  push(registrations, ip, 720 * 3600_000);
}

function registrationBlocked(ip) {
  const cfg = settings.load().protection.registrationLimit;
  if (!cfg.enabled || check(ip).allowlisted) return false;
  return within(registrations.get(ip) || [], cfg.windowHours * 3600_000) >= cfg.max;
}

// ---- under attack -------------------------------------------------------------------------------

const isUnderAttack = () => clock() < underAttackUntil;

function setUnderAttack(minutes, by = 'admin') {
  const wasOn = isUnderAttack();
  underAttackUntil = minutes > 0 ? clock() + minutes * 60_000 : 0;
  if (!wasOn && minutes > 0) event('under_attack_on', null, { minutes, by });
  if (wasOn && minutes <= 0) event('under_attack_off', null, { by });
  return underAttackUntil;
}

const underAttackInfo = () => ({ active: isUnderAttack(), until: isUnderAttack() ? iso(underAttackUntil) : null });

// ---- captcha policy -----------------------------------------------------------------------------

function captchaRequired(ip, kind) {
  const c = settings.load().captcha;
  if (isUnderAttack()) return true;
  if (!c.applyTo[kind] || c.mode === 'off') return false;
  if (c.mode === 'always') return true;
  return failureCount(ip, c.failureWindowMinutes) >= c.failureThreshold;
}

// ---- middleware ---------------------------------------------------------------------------------

function clientIp(req) {
  return normalizeIp(req.ip || (req.socket && req.socket.remoteAddress) || '');
}

function recordBlocked(ip, verdict, where) {
  counters.blocked += 1;
  const now = clock();
  if ((blockedLogged.get(ip) || 0) > now - 300_000) return;
  if (blockedLogged.size > 5000) blockedLogged.clear();
  blockedLogged.set(ip, now);
  event('blocked_request', ip, { source: verdict.source, list: verdict.list, where });
}

function ipGuard(req, res, next) {
  const ip = clientIp(req);
  if (!ip) return next();
  const verdict = check(ip);
  if (verdict.blocked) {
    recordBlocked(ip, verdict, req.path);
    return res.status(403).type('text/plain').send('Access denied');
  }
  if (!verdict.allowlisted && !req.path.startsWith('/federation/') && noteRequest(ip)) {
    return res.status(403).type('text/plain').send('Access denied');
  }
  next();
}

// WebSocket upgrades never pass through Express, so the socket layer asks directly.
function upgradeIp(req, trustProxy) {
  const direct = normalizeIp((req.socket && req.socket.remoteAddress) || '');
  const xff = req.headers && req.headers['x-forwarded-for'];
  if (trustProxy && typeof xff === 'string') {
    const last = normalizeIp(xff.split(',').pop());
    if (last) return last;
  }
  return direct;
}

function isUpgradeBlocked(req, trustProxy) {
  const ip = upgradeIp(req, trustProxy);
  const verdict = check(ip);
  if (verdict.blocked) recordBlocked(ip, verdict, '/ws');
  return verdict.blocked;
}

const FAILURE_STATUSES = new Set([400, 401, 409, 422]);
const REJECT = { error: 'request rejected', code: 'rejected' };

// Sits in front of the sign-in and sign-up routes: honeypot, per-IP sign-up cap, captcha, and
// failure bookkeeping once the route has answered. kind is 'login' or 'register'.
function gate(kind, { requireCaptcha = true } = {}) {
  return (req, res, next) => {
    if (req.method !== 'POST') return next();
    const ip = clientIp(req);
    const body = req.body || {};
    const prot = settings.load().protection;

    if (prot.honeypot) {
      const tooFast = kind === 'register' && Number.isFinite(body.formMs) && body.formMs < 800;
      if ((typeof body.website === 'string' && body.website !== '') || tooFast) {
        event('honeypot', ip, { kind, tooFast });
        noteFailure(ip);
        return res.status(400).json(REJECT);
      }
    }
    if (kind === 'register' && registrationBlocked(ip)) {
      event('registration_limited', ip);
      return res.status(429).json({ error: 'too many sign-ups from this address, try again later', code: 'registration_limited' });
    }
    if (requireCaptcha && captchaRequired(ip, kind)) {
      const result = captcha.verify(body.captchaId, body.captchaAnswer);
      if (result !== 'ok') {
        const missing = typeof body.captchaId !== 'string' || !body.captchaId;
        if (!missing) { event('captcha_failed', ip, { kind, result }); noteFailure(ip); }
        return res.status(403).json({
          error: missing ? 'captcha required' : result === 'expired' ? 'captcha expired' : 'captcha incorrect',
          code: missing ? 'captcha_required' : 'captcha_invalid',
        });
      }
    }
    res.on('finish', () => {
      const status = res.statusCode;
      if (status < 400) {
        if (kind === 'register') noteRegistration(ip);
        else clearFailures(ip);
      } else if (FAILURE_STATUSES.has(status)) {
        noteFailure(ip);
      }
    });
    next();
  };
}

// ---- reporting ----------------------------------------------------------------------------------

function lookup(rawIp) {
  const ip = normalizeIp(rawIp);
  if (!ip) return null;
  const verdict = check(ip);
  const bans = db.prepare('SELECT * FROM ip_bans').all().filter((b) => entryCovers(parseEntry(b.entry), ip));
  const lists = state.lists.filter((l) => l.set.has(ip)).map((l) => ({ id: l.id, name: l.name }));
  const prot = settings.load().protection;
  return {
    ip,
    allowlisted: verdict.allowlisted,
    blocked: verdict.blocked,
    bans,
    blocklists: lists,
    recentFailures: failureCount(ip, prot.failedLoginBan.windowMinutes),
    captchaRequired: captchaRequired(ip, 'login'),
    events: db.prepare('SELECT id, ts, type, detail FROM security_events WHERE ip = ? ORDER BY id DESC LIMIT 25').all(ip)
      .map((e) => ({ ...e, detail: e.detail ? JSON.parse(e.detail) : null })),
  };
}

function overview() {
  const since = iso(clock() - 86400_000);
  const count = (type) => db.prepare('SELECT COUNT(*) AS n FROM security_events WHERE type = ? AND ts > ?').get(type, since).n;
  const bansBySource = Object.fromEntries(
    db.prepare('SELECT source, COUNT(*) AS n FROM ip_bans WHERE expires_at IS NULL OR expires_at > ? GROUP BY source').all(iso(clock())).map((r) => [r.source, r.n])
  );
  const listRows = db.prepare('SELECT enabled, entry_count FROM ip_blocklists').all();
  return {
    underAttack: underAttackInfo(),
    bans: { manual: bansBySource.manual || 0, auto: bansBySource.auto || 0 },
    blocklists: { lists: listRows.length, enabled: listRows.filter((l) => l.enabled).length, entries: listRows.reduce((a, l) => a + (l.enabled ? l.entry_count : 0), 0) },
    last24h: {
      autoBans: count('ban_auto'),
      threats: count('threat_detected'),
      captchaFailed: count('captcha_failed'),
      honeypot: count('honeypot'),
      registrationLimited: count('registration_limited'),
    },
    sinceStart: { blockedRequests: counters.blocked, captchaIssued: captcha.stats.issued, captchaSolved: captcha.stats.solved, captchaFailed: captcha.stats.failed },
  };
}

function start() {
  rebuild();
  setInterval(() => { try { sweepExpired(); } catch (err) { logger.error('[security] sweep failed:', err); } }, 30_000).unref();
  setInterval(() => {
    const now = clock();
    for (const [ip, f] of floods) if (now - f.start > 300_000) floods.delete(ip);
    for (const map of [failures, strikes, registrations]) {
      for (const [ip, list] of map) if (!list.length || list[list.length - 1] < now - 720 * 3600_000) map.delete(ip);
    }
  }, 60_000).unref();
}

// Test hooks.
const _test = {
  setClock(fn) { clock = fn; },
  resetClock() { clock = () => Date.now(); },
  reset() {
    for (const m of [failures, floods, strikes, registrations, blockedLogged]) m.clear();
    autoBanTimes.length = 0; underAttackUntil = 0; counters.blocked = 0;
  },
};

module.exports = {
  start, rebuild, check, event, lookup, overview,
  addBan, removeBan, sweepExpired,
  noteRequest, noteRateLimited, noteFailure, clearFailures, failureCount, noteRegistration, registrationBlocked,
  isUnderAttack, setUnderAttack, underAttackInfo, captchaRequired,
  ipGuard, gate, clientIp, isUpgradeBlocked, upgradeIp,
  _test,
};
