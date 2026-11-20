'use strict';

// Shared by any route that needs to post/vote into an arbitrary (scopeType, scopeId) rather
// than the one scope its own URL is already nested under — currently polls and message
// forwarding, both of which target a scope named in the request body.

const { db } = require('../db');
const { PERMISSIONS, has } = require('./permissions');
const { getChannelPermissionBits } = require('./channelAccess');
const { broadcastToChannel, broadcastToDm } = require('../socket/hub');
const { getMemberTimeout, slowmodeRetryAfter } = require('./moderation');
const { isBlocked } = require('./friends');
const { nsfwBlock } = require('./ageGate');
const { verificationBlock } = require('./verification');
const automod = require('./automod');

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

// `content` is the user-typed text that will accompany the post (a forward comment, a poll
// question), so AutoMod sees it the same as it would on the plain message route.
function canSendToScope(scopeType, scopeId, userId, { content, skipSlowmode } = {}) {
  const result = canViewScope(scopeType, scopeId, userId);
  if (!result.ok) return result;
  const { ctx } = result;
  if (ctx.dm && !ctx.dm.is_group) {
    const other = db.prepare('SELECT user_id FROM dm_members WHERE dm_channel_id = ? AND user_id != ?').get(ctx.dm.id, userId);
    if (!other) return { ok: false, status: 409, error: 'the other participant closed this conversation' };
    if (isBlocked(userId, other.user_id)) return { ok: false, status: 403, error: 'you cannot message this user' };
  }
  if (scopeType === 'thread' && ctx.thread.archived) {
    return { ok: false, status: 403, error: 'this thread is archived' };
  }
  if (scopeType !== 'dm' && !has(getChannelPermissionBits(ctx.channel, userId), PERMISSIONS.SEND_MESSAGES)) {
    return { ok: false, status: 403, error: 'missing permission' };
  }
  if (ctx.channel) {
    const timeoutUntil = getMemberTimeout(ctx.channel.server_id, userId);
    if (timeoutUntil) return { ok: false, status: 403, error: 'you are timed out in this server', timeoutUntil };
    const gate = nsfwBlock(ctx.channel, userId) || verificationBlock(ctx.channel.server_id, userId);
    if (gate) return { ok: false, status: gate.status, error: gate.body.error };
    const sender = db.prepare('SELECT is_bot FROM users WHERE id = ?').get(userId);
    if (scopeType === 'channel' && !sender?.is_bot && !skipSlowmode) {
      const retryAfter = slowmodeRetryAfter(ctx.channel, userId);
      if (retryAfter > 0) return { ok: false, status: 429, error: 'slowmode is active', retryAfter };
    }
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    const blocked = automod.evaluate({ channel: ctx.channel, user, content });
    if (blocked) return { ok: false, status: 403, error: blocked.message };
  }
  return { ok: true, ctx };
}

module.exports = { resolveScope, canViewScope, canSendToScope };
