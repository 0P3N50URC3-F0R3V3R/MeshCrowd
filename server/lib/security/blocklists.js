'use strict';

const { db } = require('../../db');
const { safeFetch } = require('../federationSsrf');
const { parseEntry } = require('./ipMatch');
const guard = require('./guard');
const logger = require('../logger');

const MAX_ENTRIES_PER_LIST = 50_000;
const MAX_LISTS = 10;
const FETCH_TIMEOUT_MS = 20_000;

// One-click starting points. All are plain-text lists of addresses and networks.
const PRESETS = [
  { id: 'spamhaus-drop', name: 'Spamhaus DROP', url: 'https://www.spamhaus.org/drop/drop.txt' },
  { id: 'tor-exits', name: 'Tor exit nodes', url: 'https://check.torproject.org/torbulkexitlist' },
  { id: 'firehol-level1', name: 'FireHOL level 1', url: 'https://raw.githubusercontent.com/firehol/blocklist-ipsets/master/firehol_level1.netset' },
];

// One address or network per line; "#", ";" and "//" start a comment, anything after the first
// whitespace-separated token is ignored (Spamhaus appends "; SBL12345").
function parseList(text) {
  const seen = new Set();
  const out = [];
  let skipped = 0;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/\s*(#|;|\/\/).*$/, '').trim();
    if (!line) continue;
    const parsed = parseEntry(line.split(/\s+/)[0]);
    if (!parsed) { skipped += 1; continue; }
    if (seen.has(parsed.entry)) continue;
    if (out.length >= MAX_ENTRIES_PER_LIST) { skipped += 1; continue; }
    seen.add(parsed.entry);
    out.push(parsed.entry);
  }
  return { entries: out, skipped };
}

function validateUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error('not a valid URL'); }
  if (u.protocol !== 'https:' && !(process.env.DISMESH_FEDERATION_ALLOW_LOOPBACK === '1' && u.protocol === 'http:')) {
    throw new Error('blocklist URLs must use https');
  }
  if (u.username || u.password) throw new Error('credentials in the URL are not allowed');
  return u.toString();
}

function listAll() {
  return db.prepare('SELECT id, name, url, enabled, refresh_hours, entry_count, last_fetched_at, last_error, created_at FROM ip_blocklists ORDER BY id').all()
    .map((l) => ({ ...l, enabled: !!l.enabled }));
}

function addList({ name, url, refreshHours = 24 }) {
  const cleanUrl = validateUrl(String(url || ''));
  const hours = Number(refreshHours);
  if (!Number.isInteger(hours) || hours < 1 || hours > 720) throw new Error('refreshHours must be 1-720');
  if (db.prepare('SELECT COUNT(*) AS n FROM ip_blocklists').get().n >= MAX_LISTS) throw new Error(`at most ${MAX_LISTS} blocklists`);
  const label = String(name || '').trim().slice(0, 60) || new URL(cleanUrl).hostname;
  try {
    const id = Number(db.prepare('INSERT INTO ip_blocklists (name, url, refresh_hours) VALUES (?, ?, ?)').run(label, cleanUrl, hours).lastInsertRowid);
    return id;
  } catch (err) {
    if (/UNIQUE/i.test(err.message)) throw new Error('that list is already added');
    throw err;
  }
}

async function refreshList(id) {
  const list = db.prepare('SELECT * FROM ip_blocklists WHERE id = ?').get(id);
  if (!list) throw new Error('no such list');
  const now = new Date().toISOString();
  try {
    const res = await safeFetch(list.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { 'user-agent': 'MeshCrowd-security/1' } });
    if (res.status !== 200) throw new Error(`the list server answered ${res.status}`);
    const { entries, skipped } = parseList(await res.text());
    if (entries.length === 0) throw new Error('the list contained no usable addresses');
    db.prepare('UPDATE ip_blocklists SET entries = ?, entry_count = ?, last_fetched_at = ?, last_error = NULL WHERE id = ?')
      .run(entries.join('\n'), entries.length, now, id);
    guard.rebuild();
    guard.event('blocklist_refreshed', null, { name: list.name, entries: entries.length, skipped });
    return { entries: entries.length, skipped };
  } catch (err) {
    // Keep serving the previous copy of the list; only record why the refresh failed.
    db.prepare('UPDATE ip_blocklists SET last_error = ? WHERE id = ?').run(String(err.message).slice(0, 200), id);
    guard.event('blocklist_failed', null, { name: list.name, error: String(err.message).slice(0, 200) });
    throw err;
  }
}

function startWorker() {
  const tick = async () => {
    const due = db.prepare(
      `SELECT id, refresh_hours, last_fetched_at FROM ip_blocklists WHERE enabled = 1`
    ).all().filter((l) => !l.last_fetched_at || Date.parse(l.last_fetched_at) + l.refresh_hours * 3600_000 <= Date.now());
    for (const l of due) {
      try { await refreshList(l.id); } catch (err) { logger.warn(`[security] blocklist ${l.id} refresh failed: ${err.message}`); }
    }
  };
  setTimeout(tick, 15_000).unref();
  setInterval(tick, 30 * 60_000).unref();
}

module.exports = { PRESETS, parseList, validateUrl, listAll, addList, refreshList, startWorker, MAX_ENTRIES_PER_LIST };
