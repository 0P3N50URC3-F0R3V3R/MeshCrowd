'use strict';

const { db } = require('../db');
const hub = require('../socket/hub');

const RANGES = new Set([7, 14, 30, 90]);
const CACHE_MS = 60_000;
const TOP = 8;
const cache = new Map(); // `${serverId}:${days}` -> { at, value }

const dayKey = (d) => d.toISOString().slice(0, 10);

// The last `days` UTC calendar days ending today, oldest first.
function dayList(days, now = new Date()) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) out.push(dayKey(new Date(now.getTime() - i * 86400_000)));
  return out;
}

const fill = (days, rows) => {
  const by = new Map(rows.map((r) => [r.day, r.n]));
  return days.map((day) => ({ day, count: by.get(day) || 0 }));
};

// Statistics are read straight from existing data (messages, memberships): nothing extra is tracked.
// Only plain, unencrypted channel and thread messages written by people count; DMs, system events,
// webhook posts and bots are left out.
function compute(serverId, days, now = new Date()) {
  const list = dayList(days, now);
  const since = `${list[0]}T00:00:00.000Z`;
  const since7 = `${dayList(7, now)[0]}T00:00:00.000Z`;
  const scope = `((m.scope_type = 'channel' AND m.scope_id IN (SELECT id FROM channels WHERE server_id = @s))
    OR (m.scope_type = 'thread' AND m.scope_id IN (SELECT t.id FROM threads t JOIN channels c ON c.id = t.channel_id WHERE c.server_id = @s)))`;
  const real = `m.event_type IS NULL AND m.is_encrypted = 0 AND m.webhook_id IS NULL
    AND m.author_id IN (SELECT id FROM users WHERE is_bot = 0)`;
  const q = (sql, extra = {}) => db.prepare(sql).all({ s: serverId, ...extra });

  const byDay = q(`SELECT substr(m.created_at, 1, 10) AS day, COUNT(*) AS n FROM messages m WHERE m.created_at >= @since AND ${real} AND ${scope} GROUP BY day`, { since });
  const byHour = q(`SELECT CAST(substr(m.created_at, 12, 2) AS INTEGER) AS h, COUNT(*) AS n FROM messages m WHERE m.created_at >= @since AND ${real} AND ${scope} GROUP BY h`, { since });
  const topChannels = q(`SELECT c.id, c.name, COUNT(*) AS n FROM messages m JOIN channels c ON c.id = m.scope_id
      WHERE m.scope_type = 'channel' AND c.server_id = @s AND m.created_at >= @since AND ${real} GROUP BY c.id ORDER BY n DESC, c.id ASC LIMIT ${TOP}`, { since });
  const topMembers = q(`SELECT u.id, u.username, u.display_name, COUNT(*) AS n FROM messages m JOIN users u ON u.id = m.author_id
      WHERE m.created_at >= @since AND ${real} AND ${scope} AND m.author_id IN (SELECT user_id FROM server_members WHERE server_id = @s)
      GROUP BY u.id ORDER BY n DESC, u.id ASC LIMIT ${TOP}`, { since });
  const active = (from) => db.prepare(`SELECT COUNT(DISTINCT m.author_id) AS n FROM messages m WHERE m.created_at >= @since AND ${real} AND ${scope}`).get({ s: serverId, since: from }).n;
  const joinedByDay = q('SELECT substr(joined_at, 1, 10) AS day, COUNT(*) AS n FROM server_members WHERE server_id = @s AND joined_at >= @since GROUP BY day', { since });
  const total = db.prepare('SELECT COUNT(*) AS n FROM server_members WHERE server_id = ? AND user_id IN (SELECT id FROM users WHERE is_bot = 0)').get(serverId).n;
  const joined7 = db.prepare('SELECT COUNT(*) AS n FROM server_members WHERE server_id = ? AND joined_at >= ?').get(serverId, since7).n;
  const online = db.prepare('SELECT user_id FROM server_members WHERE server_id = ?').all(serverId).filter((r) => hub.isOnline(r.user_id)).length;
  const hours = Array.from({ length: 24 }, (_, h) => byHour.find((r) => r.h === h)?.n || 0);
  const messageDays = fill(list, byDay);

  return {
    days,
    generatedAt: now.toISOString(),
    members: { total, online, joinedLast7: joined7, joinedByDay: fill(list, joinedByDay), joinedInRange: joinedByDay.reduce((a, r) => a + r.n, 0) },
    messages: { total: messageDays.reduce((a, d) => a + d.count, 0), byDay: messageDays, byHour: hours },
    activeMembers: { last7: active(since7), inRange: active(since) },
    topChannels: topChannels.map((c) => ({ id: c.id, name: c.name, count: c.n })),
    topMembers: topMembers.map((m) => ({ id: m.id, username: m.username, displayName: m.display_name, count: m.n })),
  };
}

function getInsights(serverId, days) {
  const d = RANGES.has(days) ? days : 30;
  const key = `${serverId}:${d}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = compute(serverId, d);
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 500) cache.clear();
  return value;
}

function _reset() { cache.clear(); }

module.exports = { getInsights, compute, dayList, RANGES, _reset };
