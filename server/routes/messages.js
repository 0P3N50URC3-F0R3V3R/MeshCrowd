'use strict';

const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const { db, DATA_DIR } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { PERMISSIONS, SITE_PERMISSIONS, has, hasSite } = require('../lib/permissions');
const { getChannelPermissionBits, isPendingMember } = require('../lib/channelAccess');
const reactionRoles = require('../lib/reactionRoles');
const { serializeMessage } = require('../lib/messages');
const { unlinkDmFilesOfMessage } = require('../lib/dmFiles');
const { broadcastToChannel, broadcastToDm } = require('../socket/hub');
const { getMemberTimeout } = require('../lib/moderation');
const { canSendToScope, resolveScope } = require('../lib/scopeAccess');
const automod = require('../lib/automod');
const { enqueueEvent } = require('../lib/federationOutbox');
const { serializeRemoteMessage, relayRemoteChannelEvent } = require('../lib/remoteChannelEvents');
const { maxMessageChars } = require('../lib/messageLimits');

const router = express.Router();

function getChannel(id) {
  return db.prepare('SELECT * FROM channels WHERE id = ?').get(id);
}

// A thread has no permissions of its own — viewing/posting/moderating in one is governed
// entirely by the parent channel's permissions, same as the thread's own creation route enforces.
function getThreadChannel(threadId) {
  const thread = db.prepare('SELECT * FROM threads WHERE id = ?').get(threadId);
  return thread ? getChannel(thread.channel_id) : null;
}

function inEncryptedDm(message) {
  return message.is_encrypted === 1
    || (message.scope_type === 'dm' && !!db.prepare('SELECT e2ee_enabled FROM dm_channels WHERE id = ?').get(message.scope_id)?.e2ee_enabled);
}

// Authors of channel/thread messages must still be able to view the channel: a kicked member or
// one whose access was revoked keeps no write access to what they posted there.
function canModerate(message, req) {
  if (hasSite(req.sitePermissions || 0, SITE_PERMISSIONS.DELETE_ANY_MESSAGE)) return true;
  if (message.scope_type !== 'channel' && message.scope_type !== 'thread') return message.author_id === req.user.id;
  const channel = message.scope_type === 'channel' ? getChannel(message.scope_id) : getThreadChannel(message.scope_id);
  if (!channel) return false;
  const bits = getChannelPermissionBits(channel, req.user.id);
  return has(bits, message.author_id === req.user.id ? PERMISSIONS.VIEW_CHANNEL : PERMISSIONS.MANAGE_MESSAGES);
}

// Server-log entries in announcement channels are authored by whoever triggered them, so the usual
// "authors may delete their own message" rule would let a kicked/greeted member scrub their own
// entry; only real moderators may remove them.
function canDeleteEvent(message, req) {
  if (hasSite(req.sitePermissions || 0, SITE_PERMISSIONS.DELETE_ANY_MESSAGE)) return true;
  if (message.scope_type !== 'channel') return false;
  const channel = getChannel(message.scope_id);
  return !!channel && has(getChannelPermissionBits(channel, req.user.id), PERMISSIONS.MANAGE_MESSAGES);
}

function broadcast(message, payload) {
  if (message.scope_type === 'channel') {
    const channel = getChannel(message.scope_id);
    if (channel) broadcastToChannel(channel, payload);
  } else if (message.scope_type === 'thread') {
    const channel = getThreadChannel(message.scope_id);
    if (channel) broadcastToChannel(channel, payload);
  } else {
    broadcastToDm(message.scope_id, payload);
  }
}

// originMessageId is the id the OTHER side will recognize: if this instance authored the
// message (federation_peer_id IS NULL), that's our own local id; if we're relaying a mutation
// on a message that originated elsewhere, it's the federation_message_id we stored for it.
function federationOriginId(message) {
  return message.federation_peer_id ? message.federation_message_id : String(message.id);
}

// DMs relay per-type events keyed by origin message id. Channels are owned by this instance, so
// members' home instances get a remote_channel_event carrying the full current message instead.
function relayMessageMutation(message, type, extra) {
  const originMessageId = federationOriginId(message);
  if (message.scope_type === 'dm') {
    const remoteHomeIds = db.prepare(
      `SELECT DISTINCT u.home_instance_id AS id FROM dm_members m JOIN users u ON u.id = m.user_id
        WHERE m.dm_channel_id = ? AND u.home_instance_id IS NOT NULL`
    ).all(message.scope_id).map((r) => r.id);
    for (const peerId of remoteHomeIds) {
      enqueueEvent(peerId, `dm_${type}`, { originMessageId, ...extra });
    }
  } else if (message.scope_type === 'channel') {
    const channel = getChannel(message.scope_id);
    if (!channel) return;
    if (type === 'message_delete') {
      relayRemoteChannelEvent(channel, 'message_delete', { messageId: message.id });
    } else {
      const current = db.prepare('SELECT * FROM messages WHERE id = ?').get(message.id);
      if (current) relayRemoteChannelEvent(channel, type === 'message_edit' ? 'message_update' : 'reaction_update', { message: serializeRemoteMessage(current) });
    }
  }
  // 'thread' scope: not in the federation spec's scope, no relay.
}

// Reacting only requires being able to see the message — even in a read-only/announcement
// channel where you can't post text, you can still react (matches Discord).
function canViewScope(message, req) {
  return canViewScopeById(message.scope_type, message.scope_id, req);
}

// Same check as canViewScope, but by (scopeType, scopeId) directly — the pins list needs this
// before any message necessarily exists in that scope (an empty pin list is a valid response).
function canViewScopeById(scopeType, scopeId, req) {
  if (scopeType === 'channel' || scopeType === 'thread') {
    const channel = scopeType === 'channel' ? getChannel(scopeId) : getThreadChannel(scopeId);
    return !!channel && has(getChannelPermissionBits(channel, req.user.id), PERMISSIONS.VIEW_CHANNEL);
  }
  return !!db.prepare('SELECT 1 FROM dm_members WHERE dm_channel_id = ? AND user_id = ?').get(scopeId, req.user.id);
}

// Timed-out members can still see messages but can't add new reactions — DMs have no server,
// so there is nothing to be timed out from there.
function timeoutServerIdForMessage(message) {
  if (message.scope_type === 'channel') return getChannel(message.scope_id)?.server_id;
  if (message.scope_type === 'thread') return getThreadChannel(message.scope_id)?.server_id;
  return null;
}

// Channel/thread pinning is a moderation action (MANAGE_MESSAGES, same flag that governs
// deleting others' messages) — but a DM has no role system, so any participant may pin/unpin
// there, same as reacting.
function canPin(message, req) {
  if (message.scope_type === 'channel' || message.scope_type === 'thread') {
    const channel = message.scope_type === 'channel' ? getChannel(message.scope_id) : getThreadChannel(message.scope_id);
    return !!channel && has(getChannelPermissionBits(channel, req.user.id), PERMISSIONS.MANAGE_MESSAGES);
  }
  return !!db.prepare('SELECT 1 FROM dm_members WHERE dm_channel_id = ? AND user_id = ?').get(message.scope_id, req.user.id);
}

// `file_path` is stored as e.g. "/uploads/attachments/channel-1/<name>" — strip the /uploads/
// prefix to get the path relative to DATA_DIR.
function deleteAttachmentFiles(messageId) {
  const attachments = db.prepare('SELECT * FROM attachments WHERE message_id = ?').all(messageId);
  for (const a of attachments) {
    const rel = a.file_path.replace(/^\/uploads\//, '');
    const abs = path.join(DATA_DIR, rel);
    fs.unlink(abs, () => {}); // best-effort; a missing file shouldn't block the delete
  }
  db.prepare('DELETE FROM attachments WHERE message_id = ?').run(messageId);
  unlinkDmFilesOfMessage(messageId);
}

router.patch('/:id', requireAuth, (req, res) => {
  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  if (!message) return res.status(404).json({ error: 'message not found' });
  if (message.event_type) return res.status(403).json({ error: 'system messages cannot be edited' });
  if (message.author_id !== req.user.id) return res.status(403).json({ error: 'only the author can edit this message' });
  if ((message.scope_type === 'channel' || message.scope_type === 'thread') && !canViewScope(message, req)) {
    return res.status(403).json({ error: 'no access to this channel' });
  }
  if (inEncryptedDm(message)) return res.status(400).json({ error: 'encrypted messages cannot be edited' });

  const content = String(req.body?.content || '').slice(0, maxMessageChars());
  if (!content.trim()) return res.status(400).json({ error: 'content cannot be empty' });
  if (message.scope_type === 'channel' || message.scope_type === 'thread') {
    const ctx = resolveScope(message.scope_type, message.scope_id);
    const blocked = ctx && automod.evaluate({ channel: ctx.channel, user: req.user, content, track: false });
    if (blocked) return res.status(403).json({ error: blocked.message, automod: true });
  }

  db.prepare("UPDATE messages SET content = ?, edited_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
    .run(content, message.id);
  const updated = serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(message.id));
  broadcast(message, { type: 'message_update', message: updated });
  relayMessageMutation(message, 'message_edit', { content });
  res.json({ message: updated });
});

router.delete('/:id', requireAuth, (req, res) => {
  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  if (!message) return res.status(404).json({ error: 'message not found' });
  if (message.event_type ? !canDeleteEvent(message, req) : !canModerate(message, req)) {
    return res.status(403).json({ error: message.event_type ? 'system messages can only be deleted by channel moderators' : 'not allowed to delete this message' });
  }

  // Hard delete, by design: no "message deleted" tombstone left behind. Attachments cascade via
  // the FK, but the files on disk need an explicit unlink first (cascade only clears DB rows).
  deleteAttachmentFiles(message.id);
  db.prepare('DELETE FROM messages WHERE id = ?').run(message.id);
  broadcast(message, { type: 'message_delete', messageId: message.id, scopeType: message.scope_type, scopeId: message.scope_id });
  relayMessageMutation(message, 'message_delete', {});
  res.json({ ok: true });
});

router.post('/:id/forward', requireAuth, (req, res) => {
  const original = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  if (!original) return res.status(404).json({ error: 'message not found' });
  if (!canViewScope(original, req)) return res.status(403).json({ error: 'cannot forward this message' });
  if (inEncryptedDm(original)) return res.status(400).json({ error: 'encrypted messages cannot be forwarded' });

  const { scopeType, scopeId, comment } = req.body || {};
  if (!['channel', 'thread', 'dm'].includes(scopeType)) return res.status(400).json({ error: 'invalid target' });
  const scopeIdNum = Number(scopeId);
  if (!Number.isInteger(scopeIdNum)) return res.status(400).json({ error: 'invalid target' });

  const access = canSendToScope(scopeType, scopeIdNum, req.user.id);
  if (!access.ok) return res.status(access.status).json({ error: access.error });
  if (access.ctx.dm?.e2ee_enabled) return res.status(400).json({ error: 'cannot forward into an encrypted conversation' });

  const content = comment ? String(comment).slice(0, 1000) : '';
  const info = db.prepare(
    'INSERT INTO messages (scope_type, scope_id, author_id, content, forwarded_from_message_id) VALUES (?, ?, ?, ?, ?)'
  ).run(scopeType, scopeIdNum, req.user.id, content, original.id);

  const message = serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid));
  access.ctx.broadcast({ type: 'message_create', message });
  res.status(201).json({ message });
});

router.put('/:id/reactions/:emoji', requireAuth, (req, res) => {
  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  if (!message) return res.status(404).json({ error: 'message not found' });
  if (!canViewScope(message, req)) return res.status(403).json({ error: 'cannot react here' });
  const serverId = timeoutServerIdForMessage(message);
  if (serverId) {
    const timeoutUntil = getMemberTimeout(serverId, req.user.id);
    if (timeoutUntil) return res.status(403).json({ error: 'you are timed out in this server', timeoutUntil });
  }

  // 34 fits a full custom-emoji shortcode (":" + up to 32-char name + ":"), not just a raw unicode glyph.
  const emoji = String(req.params.emoji || '').slice(0, 34);
  if (!emoji) return res.status(400).json({ error: 'emoji required' });
  // A member who has not accepted the server rules yet can look but not react.
  if (serverId && isPendingMember(serverId, req.user.id)) return res.status(403).json({ error: 'accept the server rules first' });

  db.prepare(
    'INSERT OR IGNORE INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)'
  ).run(message.id, req.user.id, emoji);
  reactionRoles.onReactionAdded(message, req.user.id, emoji);

  const updated = serializeMessage(message);
  broadcast(message, { type: 'message_update', message: updated });
  relayMessageMutation(message, 'reaction_add', { userUsername: req.user.username, emoji });
  res.json({ message: updated });
});

router.delete('/:id/reactions/:emoji', requireAuth, (req, res) => {
  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  if (!message) return res.status(404).json({ error: 'message not found' });
  if (!canViewScope(message, req)) return res.status(403).json({ error: 'cannot react here' });

  db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?')
    .run(message.id, req.user.id, String(req.params.emoji || '').slice(0, 34));
  reactionRoles.onReactionRemoved(message, req.user.id, String(req.params.emoji || '').slice(0, 34));

  const updated = serializeMessage(message);
  broadcast(message, { type: 'message_update', message: updated });
  relayMessageMutation(message, 'reaction_remove', { userUsername: req.user.username, emoji: String(req.params.emoji || '').slice(0, 34) });
  res.json({ message: updated });
});

const MAX_PINS_PER_SCOPE = 50;

router.put('/:id/pin', requireAuth, (req, res) => {
  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  if (!message) return res.status(404).json({ error: 'message not found' });
  if (message.event_type) return res.status(403).json({ error: 'system messages cannot be pinned' });
  if (!canPin(message, req)) return res.status(403).json({ error: 'not allowed to pin messages here' });
  if (!message.pinned_at) {
    const { c: pinCount } = db.prepare(
      'SELECT COUNT(*) AS c FROM messages WHERE scope_type = ? AND scope_id = ? AND pinned_at IS NOT NULL'
    ).get(message.scope_type, message.scope_id);
    if (pinCount >= MAX_PINS_PER_SCOPE) return res.status(400).json({ error: `pin limit reached (${MAX_PINS_PER_SCOPE})` });
    db.prepare("UPDATE messages SET pinned_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), pinned_by = ? WHERE id = ?")
      .run(req.user.id, message.id);
  }
  const updated = serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(message.id));
  broadcast(message, { type: 'message_update', message: updated });
  res.json({ message: updated });
});

router.delete('/:id/pin', requireAuth, (req, res) => {
  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  if (!message) return res.status(404).json({ error: 'message not found' });
  if (!canPin(message, req)) return res.status(403).json({ error: 'not allowed to unpin messages here' });
  db.prepare('UPDATE messages SET pinned_at = NULL, pinned_by = NULL WHERE id = ?').run(message.id);
  const updated = serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(message.id));
  broadcast(message, { type: 'message_update', message: updated });
  res.json({ message: updated });
});

// Registered as a query-parameterized route (not nested under each scope's own router) since
// pinning already spans channel/thread/dm generically here — same reasoning as PATCH/DELETE
// above operating on a bare message id rather than being duplicated per scope type.
router.get('/pins', requireAuth, (req, res) => {
  const scopeType = String(req.query.scopeType || '');
  const scopeId = Number(req.query.scopeId);
  if (!['channel', 'thread', 'dm'].includes(scopeType) || !Number.isInteger(scopeId)) {
    return res.status(400).json({ error: 'invalid scope' });
  }
  if (!canViewScopeById(scopeType, scopeId, req)) return res.status(403).json({ error: 'not allowed to view this' });
  const rows = db.prepare(
    'SELECT * FROM messages WHERE scope_type = ? AND scope_id = ? AND pinned_at IS NOT NULL ORDER BY pinned_at DESC'
  ).all(scopeType, scopeId);
  res.json({ messages: rows.map(serializeMessage) });
});

module.exports = router;
module.exports.deleteAttachmentFiles = deleteAttachmentFiles;
