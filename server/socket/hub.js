'use strict';

const { db } = require('../db');
const { toPublicUser } = require('../lib/publicUser');
const { canAccessChannel } = require('../lib/channelAccess');
const { PERMISSIONS } = require('../lib/permissions');
const presence = require('../lib/presence');
const { isSiteAdmin } = require('../lib/siteAuth');

const { registerConnection, unregisterConnection, notifyUser, isOnline, disconnectUser } = presence;

function broadcastToChannel(channel, payload, requiredFlag = PERMISSIONS.VIEW_CHANNEL) {
  const members = db.prepare('SELECT user_id FROM server_members WHERE server_id = ?').all(channel.server_id);
  for (const m of members) {
    if (!isOnline(m.user_id)) continue;
    if (canAccessChannel(channel, m.user_id, requiredFlag)) {
      notifyUser(m.user_id, payload);
    }
  }
}

function broadcastToDm(dmChannelId, payload) {
  const members = db.prepare('SELECT user_id FROM dm_members WHERE dm_channel_id = ?').all(dmChannelId);
  for (const m of members) notifyUser(m.user_id, payload);
}

// For events whose payload carries no channel-specific secrets (member/role/server-metadata
// changes) — never use this for a per-channel payload, since it does no VIEW_CHANNEL filtering.
function broadcastToServer(serverId, payload) {
  const members = db.prepare('SELECT user_id FROM server_members WHERE server_id = ?').all(serverId);
  for (const m of members) notifyUser(m.user_id, payload);
}

// Same as broadcastToServer, but takes an explicit member-id list instead of querying
// server_members live — required when the membership row is already gone by the time we
// broadcast (kick/ban/delete all remove the row before notifying).
function notifyUserIds(userIds, payload) {
  for (const uid of userIds) notifyUser(uid, payload);
}

// Push a user's presence to friends + everyone who shares a server with them.
function broadcastPresence(userId) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return;

  const recipients = new Set();
  const friendRows = db.prepare(
    `SELECT user_a, user_b FROM friendships WHERE (user_a = ? OR user_b = ?) AND status = 'accepted'`
  ).all(userId, userId);
  for (const f of friendRows) recipients.add(f.user_a === userId ? f.user_b : f.user_a);

  const serverIds = db.prepare('SELECT server_id FROM server_members WHERE user_id = ?').all(userId);
  for (const s of serverIds) {
    const mates = db.prepare('SELECT user_id FROM server_members WHERE server_id = ? AND user_id != ?')
      .all(s.server_id, userId);
    for (const m of mates) recipients.add(m.user_id);
  }

  const payload = { type: 'presence', user: toPublicUser(user, { viewerIsSelf: false }) };
  for (const rid of recipients) notifyUser(rid, payload);
}

// Push an arbitrary payload to just a user's accepted friends — narrower than broadcastPresence
// (friends only, not shared-server members), for things that are meaningfully "this is a friend
// of mine doing something" rather than general presence (e.g. joining/leaving voice).
function broadcastToFriends(userId, payload) {
  const friendRows = db.prepare(
    `SELECT user_a, user_b FROM friendships WHERE (user_a = ? OR user_b = ?) AND status = 'accepted'`
  ).all(userId, userId);
  for (const f of friendRows) notifyUser(f.user_a === userId ? f.user_b : f.user_a, payload);
}

function notifySiteAdmins(payload) {
  for (const uid of presence.onlineUserIds()) {
    if (isSiteAdmin(uid)) notifyUser(uid, payload);
  }
}

module.exports = {
  registerConnection, unregisterConnection, notifyUser, isOnline, disconnectUser, notifyUserIds,
  broadcastToChannel, broadcastToDm, broadcastToServer, broadcastPresence, broadcastToFriends, notifySiteAdmins,
};
