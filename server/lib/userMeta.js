'use strict';

const { db } = require('../db');
const { has, PERMISSIONS } = require('./permissions');
const { getChannelPermissionBits } = require('./channelAccess');

const FOREVER = '9999-12-31T00:00:00.000Z';

function isIgnoring(userId, targetId) {
  return !!db.prepare('SELECT 1 FROM user_annotations WHERE user_id = ? AND target_id = ? AND ignored = 1').get(userId, targetId);
}

function ignoredIds(userId) {
  return new Set(db.prepare('SELECT target_id FROM user_annotations WHERE user_id = ? AND ignored = 1').all(userId).map((r) => r.target_id));
}

// Whether `userId` may see a message in this scope; threads inherit their parent channel's rules.
function canViewScope(userId, scopeType, scopeId) {
  if (scopeType === 'channel' || scopeType === 'thread') {
    const channel = scopeType === 'channel'
      ? db.prepare('SELECT * FROM channels WHERE id = ?').get(scopeId)
      : db.prepare('SELECT c.* FROM threads t JOIN channels c ON c.id = t.channel_id WHERE t.id = ?').get(scopeId);
    return !!channel && has(getChannelPermissionBits(channel, userId), PERMISSIONS.VIEW_CHANNEL);
  }
  if (scopeType === 'dm') {
    return !!db.prepare('SELECT 1 FROM dm_members WHERE dm_channel_id = ? AND user_id = ?').get(scopeId, userId);
  }
  return false;
}

function canViewMessage(userId, message) {
  return !!message && canViewScope(userId, message.scope_type, message.scope_id);
}

// minutes | forever -> ISO expiry
function muteExpiry({ minutes, forever }) {
  if (forever === true) return FOREVER;
  if (Number.isFinite(minutes) && minutes > 0) return new Date(Date.now() + Math.min(minutes, 366 * 24 * 60) * 60_000).toISOString();
  return null;
}

module.exports = { FOREVER, isIgnoring, ignoredIds, canViewScope, canViewMessage, muteExpiry };
