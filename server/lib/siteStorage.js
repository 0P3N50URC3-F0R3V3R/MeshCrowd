'use strict';

const zlib = require('node:zlib');
const { db } = require('../db');

// Site pages run in an opaque origin, so their localStorage, cookies and IndexedDB live here instead,
// per viewer and per site. Nothing in this module ever reads another user's or another site's rows.
const LIMITS = {
  // Sized for browser games and tools (DOSBox saves, cached disk images), still bounded because this lives in the
  // server database. The IndexedDB snapshot is one string in memory, so 256 MB is the practical ceiling.
  maxBytes: 64 * 1024 * 1024,   // local + cookie keys and values, per viewer and site
  maxEntries: 100_000,
  maxKey: 1024,
  maxValue: 16 * 1024 * 1024,
  maxCookies: 180,
  maxCookieValue: 4096,
  maxOps: 2000,
  maxIdbBytes: 256 * 1024 * 1024,
  cookieDefaultDays: 30,
  writesPerMinute: 1200,
  idbWritesPerMinute: 120,
};

class StorageError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const buckets = new Map();
function rateLimit(kind, siteId, userId, max) {
  const k = `${kind}:${siteId}:${userId}`;
  const now = Date.now();
  let b = buckets.get(k);
  if (!b || now - b.start > 60_000) {
    if (buckets.size > 5000) for (const [key, v] of buckets) if (now - v.start > 60_000) buckets.delete(key);
    b = { start: now, n: 0 };
    buckets.set(k, b);
  }
  if (++b.n > max) throw new StorageError(429, 'too many storage writes');
}

const usage = (siteId, userId) => db.prepare(
  'SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(key) + LENGTH(value)), 0) AS bytes FROM site_storage WHERE site_id = ? AND user_id = ?'
).get(siteId, userId);

function sweepCookies(siteId, userId) {
  db.prepare("DELETE FROM site_storage WHERE site_id = ? AND user_id = ? AND kind = 'cookie' AND expires IS NOT NULL AND expires <= ?").run(siteId, userId, Date.now());
}

// Site-relative cookie paths always start with "/".
function normPath(p) {
  let s = typeof p === 'string' ? p : '/';
  if (!s.startsWith('/')) s = '/';
  return s.slice(0, 256);
}
const pathMatches = (cookiePath, reqPath) => reqPath === cookiePath || reqPath.startsWith(cookiePath.endsWith('/') ? cookiePath : `${cookiePath}/`);
const validCookieName = (n) => typeof n === 'string' && n.length > 0 && n.length <= 128 && /^[^\s=;,]+$/.test(n);

function snapshot(siteId, userId) {
  sweepCookies(siteId, userId);
  const local = {};
  for (const r of db.prepare("SELECT key, value FROM site_storage WHERE site_id = ? AND user_id = ? AND kind = 'local'").all(siteId, userId)) local[r.key] = r.value;
  const cookies = db.prepare("SELECT key AS n, value AS v, path AS p, expires AS e FROM site_storage WHERE site_id = ? AND user_id = ? AND kind = 'cookie' AND http_only = 0").all(siteId, userId);
  const idb = db.prepare('SELECT bytes FROM site_idb WHERE site_id = ? AND user_id = ?').get(siteId, userId);
  return { local, cookies, idb: idb ? idb.bytes : 0 };
}

const UPSERT = db.prepare(
  'INSERT INTO site_storage (site_id, user_id, kind, key, path, value, expires, http_only) VALUES (?, ?, ?, ?, ?, ?, ?, ?) '
  + 'ON CONFLICT (site_id, user_id, kind, key, path) DO UPDATE SET value = excluded.value, expires = excluded.expires, http_only = excluded.http_only'
);

function setCookie(siteId, userId, name, value, cookiePath, expires, httpOnly) {
  if (expires != null && expires <= Date.now()) {
    db.prepare("DELETE FROM site_storage WHERE site_id = ? AND user_id = ? AND kind = 'cookie' AND key = ? AND path = ?").run(siteId, userId, name, cookiePath);
    return;
  }
  const exp = expires == null ? Date.now() + LIMITS.cookieDefaultDays * 86_400_000 : expires;
  UPSERT.run(siteId, userId, 'cookie', name, cookiePath, value, exp, httpOnly ? 1 : 0);
}

// Every op is validated up front and the batch is applied in one transaction, so a rejected batch changes nothing.
function applyOps(siteId, userId, ops) {
  if (!Array.isArray(ops) || ops.length > LIMITS.maxOps) throw new StorageError(400, 'bad ops');
  rateLimit('w', siteId, userId, LIMITS.writesPerMinute);
  for (const o of ops) {
    if (!o || typeof o !== 'object') throw new StorageError(400, 'bad op');
    if (o.t === 'set') {
      if (typeof o.k !== 'string' || !o.k || o.k.length > LIMITS.maxKey || typeof o.v !== 'string' || o.v.length > LIMITS.maxValue) throw new StorageError(413, 'key or value too large');
    } else if (o.t === 'del') {
      if (typeof o.k !== 'string') throw new StorageError(400, 'bad op');
    } else if (o.t === 'cset') {
      if (!validCookieName(o.n) || typeof o.v !== 'string' || o.v.length > LIMITS.maxCookieValue || (o.e != null && !Number.isFinite(o.e))) throw new StorageError(400, 'bad cookie');
    } else if (o.t === 'cdel') {
      if (!validCookieName(o.n)) throw new StorageError(400, 'bad cookie');
    } else if (o.t !== 'clear') throw new StorageError(400, 'bad op');
  }
  db.exec('BEGIN');
  try {
    sweepCookies(siteId, userId);
    for (const o of ops) {
      if (o.t === 'set') UPSERT.run(siteId, userId, 'local', o.k, '', o.v, null, 0);
      else if (o.t === 'del') db.prepare("DELETE FROM site_storage WHERE site_id = ? AND user_id = ? AND kind = 'local' AND key = ?").run(siteId, userId, o.k);
      else if (o.t === 'clear') db.prepare("DELETE FROM site_storage WHERE site_id = ? AND user_id = ? AND kind = 'local'").run(siteId, userId);
      else if (o.t === 'cset') setCookie(siteId, userId, o.n, o.v, normPath(o.p), o.e == null ? null : o.e, 0);
      else if (o.t === 'cdel') db.prepare("DELETE FROM site_storage WHERE site_id = ? AND user_id = ? AND kind = 'cookie' AND key = ? AND path = ?").run(siteId, userId, o.n, normPath(o.p));
    }
    const u = usage(siteId, userId);
    if (u.bytes > LIMITS.maxBytes || u.n > LIMITS.maxEntries) throw new StorageError(413, 'site storage quota exceeded');
    const c = db.prepare("SELECT COUNT(*) AS n FROM site_storage WHERE site_id = ? AND user_id = ? AND kind = 'cookie'").get(siteId, userId).n;
    if (c > LIMITS.maxCookies) throw new StorageError(413, 'too many cookies');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// The Cookie header handed to PHP: only this viewer's cookies for this site whose path covers the request.
function cookieHeader(siteId, userId, reqPath) {
  sweepCookies(siteId, userId);
  const rows = db.prepare("SELECT key, value, path FROM site_storage WHERE site_id = ? AND user_id = ? AND kind = 'cookie'").all(siteId, userId);
  return rows.filter((r) => pathMatches(r.path, reqPath)).sort((a, b) => b.path.length - a.path.length).map((r) => `${r.key}=${r.value}`).join('; ');
}

// Applies PHP's Set-Cookie headers to the viewer's store. Domain, Secure and SameSite are meaningless here.
function applySetCookies(siteId, userId, headers, reqPath) {
  if (!headers || !headers.length) return;
  const dir = reqPath.slice(0, reqPath.lastIndexOf('/') + 1) || '/';
  for (const h of headers) {
    const parts = String(h).split(';');
    const eq = parts[0].indexOf('=');
    if (eq < 1) continue;
    const name = parts[0].slice(0, eq).trim();
    const value = parts[0].slice(eq + 1).trim();
    if (!validCookieName(name) || value.length > LIMITS.maxCookieValue) continue;
    let cookiePath = dir; let expires = null; let httpOnly = 0; let maxAge = null;
    for (const a of parts.slice(1)) {
      const i = a.indexOf('=');
      const k = (i === -1 ? a : a.slice(0, i)).trim().toLowerCase();
      const v = i === -1 ? '' : a.slice(i + 1).trim();
      if (k === 'path' && v.startsWith('/')) cookiePath = v.slice(0, 256);
      else if (k === 'max-age' && /^-?\d+$/.test(v)) maxAge = Number(v);
      else if (k === 'expires') { const t = Date.parse(v); if (Number.isFinite(t)) expires = t; }
      else if (k === 'httponly') httpOnly = 1;
    }
    if (maxAge != null) expires = Date.now() + maxAge * 1000;
    const known = db.prepare("SELECT 1 FROM site_storage WHERE site_id = ? AND user_id = ? AND kind = 'cookie' AND key = ? AND path = ?").get(siteId, userId, name, cookiePath);
    const have = db.prepare("SELECT COUNT(*) AS n FROM site_storage WHERE site_id = ? AND user_id = ? AND kind = 'cookie'").get(siteId, userId).n;
    if (!known && have >= LIMITS.maxCookies) continue;
    setCookie(siteId, userId, name, value, cookiePath, expires, httpOnly);
  }
}

function getIdb(siteId, userId) {
  const row = db.prepare('SELECT data FROM site_idb WHERE site_id = ? AND user_id = ?').get(siteId, userId);
  return row ? zlib.gunzipSync(row.data).toString('utf8') : null;
}

function putIdb(siteId, userId, text) {
  rateLimit('i', siteId, userId, LIMITS.idbWritesPerMinute);
  const bytes = Buffer.byteLength(text);
  if (bytes > LIMITS.maxIdbBytes) throw new StorageError(413, 'indexedDB quota exceeded');
  db.prepare(
    "INSERT INTO site_idb (site_id, user_id, data, bytes, updated_at) VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now')) "
    + 'ON CONFLICT (site_id, user_id) DO UPDATE SET data = excluded.data, bytes = excluded.bytes, updated_at = excluded.updated_at'
  ).run(siteId, userId, zlib.gzipSync(Buffer.from(text, 'utf8')), bytes);
}

function clearAll(siteId, userId) {
  db.prepare('DELETE FROM site_storage WHERE site_id = ? AND user_id = ?').run(siteId, userId);
  db.prepare('DELETE FROM site_idb WHERE site_id = ? AND user_id = ?').run(siteId, userId);
}

module.exports = { clearAll, LIMITS, StorageError, snapshot, applyOps, cookieHeader, applySetCookies, getIdb, putIdb };
