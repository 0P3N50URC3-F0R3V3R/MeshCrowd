'use strict';

const { db } = require('../db');
const { PERMISSIONS, has } = require('./permissions');
const { getChannelPermissionBits } = require('./channelAccess');

// Returns the ISO timestamp the member is timed out until, or null if they aren't
// currently timed out (never set, or the timeout has already expired).
function getMemberTimeout(serverId, userId) {
  const row = db.prepare('SELECT timeout_until FROM server_members WHERE server_id = ? AND user_id = ?').get(serverId, userId);
  if (!row || !row.timeout_until) return null;
  return new Date(row.timeout_until) > new Date() ? row.timeout_until : null;
}

// Seconds the user still has to wait before their next message in this channel, or 0 if
// they can post now. Anyone who can delete others' messages is exempt, same as Discord.
function slowmodeRetryAfter(channel, userId) {
  if (!channel.slowmode_seconds) return 0;
  if (has(getChannelPermissionBits(channel, userId), PERMISSIONS.MANAGE_MESSAGES)) return 0;
  const last = db.prepare(
    `SELECT created_at FROM messages WHERE scope_type = 'channel' AND scope_id = ? AND author_id = ? ORDER BY id DESC LIMIT 1`
  ).get(channel.id, userId);
  if (!last) return 0;
  const elapsedSeconds = (Date.now() - new Date(last.created_at).getTime()) / 1000;
  const remaining = channel.slowmode_seconds - elapsedSeconds;
  return remaining > 0 ? Math.ceil(remaining) : 0;
}

module.exports = { getMemberTimeout, slowmodeRetryAfter };
