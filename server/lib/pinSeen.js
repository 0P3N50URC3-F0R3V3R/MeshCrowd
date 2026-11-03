'use strict';

const { db } = require('../db');
const { has, PERMISSIONS } = require('./permissions');
const { getChannelPermissionBits } = require('./channelAccess');

// Pins made before this are treated as already seen, so the feature doesn't light up every old pin.
const PIN_EPOCH = '2026-11-03T00:00:00.000Z';
const SCOPES = ['channel', 'thread', 'dm'];

function canView(scopeType, scopeId, userId) {
  if (scopeType === 'dm') return !!db.prepare('SELECT 1 FROM dm_members WHERE dm_channel_id = ? AND user_id = ?').get(scopeId, userId);
  const channel = scopeType === 'channel'
    ? db.prepare('SELECT * FROM channels WHERE id = ?').get(scopeId)
    : db.prepare('SELECT c.* FROM channels c JOIN threads t ON t.channel_id = c.id WHERE t.id = ?').get(scopeId);
  return !!channel && has(getChannelPermissionBits(channel, userId), PERMISSIONS.VIEW_CHANNEL);
}

// Scopes the user can see whose newest pin is newer than the last time they opened the pin list.
function unseenPins(userId) {
  const rows = db.prepare(
    `SELECT m.scope_type AS scopeType, m.scope_id AS scopeId, MAX(m.pinned_at) AS latest, ps.seen_at AS seenAt
       FROM messages m
       LEFT JOIN pin_seen ps ON ps.user_id = ? AND ps.scope_type = m.scope_type AND ps.scope_id = m.scope_id
      WHERE m.pinned_at IS NOT NULL AND m.pinned_at > ? AND (m.pinned_by IS NULL OR m.pinned_by != ?)
      GROUP BY m.scope_type, m.scope_id
     HAVING latest > COALESCE(seenAt, ?)`
  ).all(userId, PIN_EPOCH, userId, PIN_EPOCH);
  return rows.filter((r) => canView(r.scopeType, r.scopeId, userId));
}

function markSeen(userId, scopeType, scopeId) {
  const seenAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO pin_seen (user_id, scope_type, scope_id, seen_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, scope_type, scope_id) DO UPDATE SET seen_at = excluded.seen_at`
  ).run(userId, scopeType, scopeId, seenAt);
  return seenAt;
}

module.exports = { unseenPins, markSeen, canView, SCOPES, PIN_EPOCH };
