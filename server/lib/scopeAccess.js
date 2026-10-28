'use strict';

// Shared by any route that needs to post/vote into an arbitrary (scopeType, scopeId) rather
// than the one scope its own URL is already nested under — currently polls and message
// forwarding, both of which target a scope named in the request body.

const { db } = require('../db');
const { PERMISSIONS, has } = require('./permissions');
const { getChannelPermissionBits } = require('./channelAccess');
const { broadcastToChannel, broadcastToDm } = require('../socket/hub');
const { getMemberTimeout } = require('./moderation');

function resolveScope(scopeType, scopeId) {
  if (scopeType === 'channel') {
    const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(scopeId);
    return channel && channel.type !== 'notes' ? { channel, broadcast: (p) => broadcastToChannel(channel, p) } : null;
  }
  if (scopeType === 'thread') {
    const thread = db.prepare('SELECT * FROM threads WHERE id = ?').get(scopeId);
    if (!thread) return null;
    const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(thread.channel_id);
    if (!channel) return null;
    return { channel, thread, broadcast: (p) => broadcastToChannel(channel, p) };
  }
  if (scopeType === 'dm') {
    const dm = db.prepare('SELECT * FROM dm_channels WHERE id = ?').get(scopeId);
    return dm ? { dm, broadcast: (p) => broadcastToDm(dm.id, p) } : null;
  }
  return null;
}

function canViewScope(scopeType, scopeId, userId) {
  const ctx = resolveScope(scopeType, scopeId);
  if (!ctx) return { ok: false, status: 404, error: 'not found' };
  if (scopeType === 'dm') {
    const member = db.prepare('SELECT 1 FROM dm_members WHERE dm_channel_id = ? AND user_id = ?').get(scopeId, userId);
    return member ? { ok: true, ctx } : { ok: false, status: 403, error: 'not a member of this conversation' };
  }
  if (!has(getChannelPermissionBits(ctx.channel, userId), PERMISSIONS.VIEW_CHANNEL)) {
    return { ok: false, status: 403, error: 'cannot view this' };
  }
  return { ok: true, ctx };
}

function canSendToScope(scopeType, scopeId, userId) {
  const result = canViewScope(scopeType, scopeId, userId);
  if (!result.ok) return result;
  const { ctx } = result;
  if (scopeType === 'thread' && ctx.thread.archived) {
    return { ok: false, status: 403, error: 'this thread is archived' };
  }
  if (scopeType !== 'dm' && !has(getChannelPermissionBits(ctx.channel, userId), PERMISSIONS.SEND_MESSAGES)) {
    return { ok: false, status: 403, error: 'missing permission' };
  }
  if (ctx.channel) {
    const timeoutUntil = getMemberTimeout(ctx.channel.server_id, userId);
    if (timeoutUntil) return { ok: false, status: 403, error: 'you are timed out in this server', timeoutUntil };
  }
  return { ok: true, ctx };
}

module.exports = { resolveScope, canViewScope, canSendToScope };
