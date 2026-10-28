'use strict';

const { db } = require('../db');
const { aiRequest, readBody } = require('./ai/http');
const { load: loadConfig } = require('./config');
const logger = require('./logger');

const MAX_PER_USER = 5;
const MAX_FAILURES = 5;
const COALESCE_MS = 5000;
const TIMEOUT_MS = 8000;
const config = loadConfig();

// `allowPrivate` is read at send time so tests (and a config change after restart) can flip it.
const settings = { allowPrivate: !!config.pushAllowPrivateEndpoints, coalesceMs: COALESCE_MS };

class PushError extends Error {
  constructor(status, message) { super(message); this.name = 'PushError'; this.status = status; }
}

function validateEndpoint(raw) {
  let u;
  try { u = new URL(String(raw ?? '').trim()); } catch { throw new PushError(400, 'invalid endpoint URL'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new PushError(400, 'the endpoint must be http or https');
  if (!u.hostname || u.username || u.password || u.hash) throw new PushError(400, 'invalid endpoint URL');
  const out = u.toString();
  if (out.length > 500) throw new PushError(400, 'the endpoint URL is too long');
  return out;
}

function register(userId, endpoint, label) {
  const url = validateEndpoint(endpoint);
  const existing = db.prepare('SELECT id FROM push_endpoints WHERE user_id = ? AND endpoint = ?').get(userId, url);
  if (!existing && db.prepare('SELECT COUNT(*) AS n FROM push_endpoints WHERE user_id = ?').get(userId).n >= MAX_PER_USER) {
    throw new PushError(409, `at most ${MAX_PER_USER} push endpoints per account`);
  }
  db.prepare('INSERT INTO push_endpoints (user_id, endpoint, label) VALUES (?, ?, ?) ON CONFLICT(user_id, endpoint) DO UPDATE SET failures = 0, label = excluded.label')
    .run(userId, url, String(label ?? '').slice(0, 60));
  return list(userId).find((e) => e.endpoint === url);
}

function remove(userId, endpoint) {
  const info = db.prepare('DELETE FROM push_endpoints WHERE user_id = ? AND endpoint = ?').run(userId, String(endpoint ?? '').trim());
  return Number(info.changes) > 0;
}

function list(userId) {
  return db.prepare('SELECT id, endpoint, label, failures, last_ok_at, created_at FROM push_endpoints WHERE user_id = ? ORDER BY id ASC').all(userId)
    .map((r) => ({ id: r.id, endpoint: r.endpoint, label: r.label, failures: r.failures, lastOkAt: r.last_ok_at, createdAt: r.created_at }));
}

async function send(row) {
  try {
    const res = await aiRequest(row.endpoint, {
      method: 'POST', body: '{"t":"wake"}', allowPrivate: settings.allowPrivate,
      headers: { 'user-agent': 'MeshCrowd-Push/1' }, signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    try { await readBody(res, 4096); } catch { /* the answer is not used */ }
    if (res.statusCode >= 200 && res.statusCode < 300) {
      db.prepare("UPDATE push_endpoints SET failures = 0, last_ok_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(row.id);
      return 'ok';
    }
    // The distributor says the endpoint is gone: forget it.
    if (res.statusCode === 404 || res.statusCode === 410) { db.prepare('DELETE FROM push_endpoints WHERE id = ?').run(row.id); return 'gone'; }
  } catch { /* counted below */ }
  const failures = row.failures + 1;
  if (failures >= MAX_FAILURES) db.prepare('DELETE FROM push_endpoints WHERE id = ?').run(row.id);
  else db.prepare('UPDATE push_endpoints SET failures = ? WHERE id = ?').run(failures, row.id);
  return 'failed';
}

const timers = new Map(); // userId -> pending timer

// Called whenever a notification is recorded for a user. Bursts are merged into one wake-up per window.
function wake(userId) {
  if (timers.has(userId)) return;
  if (!db.prepare('SELECT 1 FROM push_endpoints WHERE user_id = ? LIMIT 1').get(userId)) return;
  const timer = setTimeout(async () => {
    timers.delete(userId);
    try {
      for (const row of db.prepare('SELECT * FROM push_endpoints WHERE user_id = ?').all(userId)) await send(row);
    } catch (err) { logger.warn(`[push] wake failed: ${err.message}`); }
  }, settings.coalesceMs);
  timer.unref?.();
  timers.set(userId, timer);
}

function _reset() { for (const t of timers.values()) clearTimeout(t); timers.clear(); }

module.exports = { PushError, validateEndpoint, register, remove, list, send, wake, settings, _reset, MAX_PER_USER, MAX_FAILURES };
