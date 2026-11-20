'use strict';

const { db } = require('../db');
const { canAccessChannel } = require('./channelAccess');
const { PERMISSIONS } = require('./permissions');

function pairKey(a, b) {
  return a < b ? [a, b] : [b, a];
}

function getFriendship(a, b) {
  const [x, y] = pairKey(a, b);
  return db.prepare('SELECT * FROM friendships WHERE user_a = ? AND user_b = ?').get(x, y);
}

function areFriends(a, b) {
  const f = getFriendship(a, b);
  return !!f && f.status === 'accepted';
}

function isBlocked(a, b) {
  const f = getFriendship(a, b);
  return !!f && f.status === 'blocked';
}

// What a friend may learn about someone's voice channel: names only when they can view it themselves,
// otherwise the same shape with no ids or names (hidden: true).
function voiceChannelInfoFor(viewerId, channel) {
  if (!channel) return null;
  if (!canAccessChannel(channel, viewerId, PERMISSIONS.VIEW_CHANNEL)) return { id: null, name: '', serverId: null, serverName: '', hidden: true };
  const server = db.prepare('SELECT id, name FROM servers WHERE id = ?').get(channel.server_id);
  return { id: channel.id, name: channel.name, serverId: server?.id, serverName: server?.name };
}

module.exports = { pairKey, getFriendship, areFriends, isBlocked, voiceChannelInfoFor };
