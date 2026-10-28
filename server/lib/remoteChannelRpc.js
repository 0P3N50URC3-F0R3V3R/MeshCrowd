'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, DATA_DIR } = require('../db');
const { PERMISSIONS, has } = require('./permissions');
const { getChannelPermissionBits, removeMember } = require('./channelAccess');
const { serializeMessage } = require('./messages');
const { toPublicUser } = require('./publicUser');
const { broadcastToChannel, broadcastToServer } = require('../socket/hub');
const { getMemberTimeout, slowmodeRetryAfter } = require('./moderation');
const { parseMentions, notifyChannelMessage } = require('./notifications');
const { postServerEvent } = require('./systemMessages');
const { load: loadConfig } = require('./config');
const { sanitizeFilename, isAllowedUpload, effectiveMaxUploadMb } = require('./uploads');
const { maxMessageChars } = require('./messageLimits');
const {
  serializeRemoteMessage, relayRemoteChannelEvent, remoteIdentity, remoteImageType, REMOTE_ATTACHMENT_MAX_BYTES,
} = require('./remoteChannelEvents');

const config = loadConfig();
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const MIME_RE = /^[\w.+-]{1,50}\/[\w.+-]{1,50}$/;

const TEXT_CHANNEL_TYPES = new Set(['public', 'private', 'announcement', 'readonly']);
// A replayed signed envelope within the 5-minute window must not re-run these; reads are harmless.
const MUTATING_TYPES = new Set(['leave_server', 'channel_message_create', 'channel_message_edit', 'channel_message_delete', 'channel_reaction_add', 'channel_reaction_remove']);

const fail = (status, error, extra) => ({ ok: false, status, error, ...extra });

// The peer only asserts WHO is calling; everything they may do is decided here from our own
// server_members/roles/overrides rows for that cached user. A caller we have no cached row for, or
// who is not a member, learns nothing beyond 'not_member' (same answer for a missing server).
function resolveCaller(peer, payload) {
  const username = payload.username;
  if (typeof username !== 'string' || !username || username.length > 64 || username.includes('@')) return null;
  return db.prepare('SELECT * FROM users WHERE federated_uid = ? AND home_instance_id = ?').get(`${username}@${peer.domain}`, peer.id) || null;
}

function loadServer(peer, payload) {
  const user = resolveCaller(peer, payload);
  const server = Number.isInteger(payload.serverId) ? db.prepare('SELECT * FROM servers WHERE id = ?').get(payload.serverId) : null;
  const member = user && server && db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(server.id, user.id);
  return member ? { user, server } : null;
}

// A channel the caller cannot VIEW is indistinguishable from one that does not exist.
function loadChannel(ctx, payload) {
  const channel = Number.isInteger(payload.channelId)
    ? db.prepare('SELECT * FROM channels WHERE id = ? AND server_id = ?').get(payload.channelId, ctx.server.id) : null;
  if (!channel || !TEXT_CHANNEL_TYPES.has(channel.type)) return null;
  const bits = getChannelPermissionBits(channel, ctx.user.id);
  return has(bits, PERMISSIONS.VIEW_CHANNEL) ? { channel, bits } : null;
}

function loadChannelMessage(channel, payload) {
  if (!Number.isInteger(payload.messageId)) return null;
  return db.prepare(`SELECT * FROM messages WHERE id = ? AND scope_type = 'channel' AND scope_id = ? AND event_type IS NULL`).get(payload.messageId, channel.id) || null;
}

function withChannel(handler) {
  return (peer, payload) => {
    const ctx = loadServer(peer, payload);
    if (!ctx) return fail(403, 'not_member');
    const ch = loadChannel(ctx, payload);
    if (!ch) return fail(404, 'channel not found');
    return handler(ctx, ch, payload);
  };
}

function cleanEmoji(payload) {
  return String(payload.emoji || '').slice(0, 34);
}

// Validates every inbound file against this (owning) instance's own upload rules before anything
// is written. Returns { files } or a fail() result; one bad file refuses the whole message, since
// the caller gets a synchronous answer and can retry without it.
function decodeAttachments(list, bits) {
  if (list == null) return { files: [] };
  if (!Array.isArray(list) || list.length > 5) return fail(400, 'too many attachments');
  if (list.length && !has(bits, PERMISSIONS.ATTACH_FILES)) return fail(403, 'missing permission: Attach Files');
  const maxBytes = Math.min(effectiveMaxUploadMb(config.maxUploadMb) * 1024 * 1024, REMOTE_ATTACHMENT_MAX_BYTES);
  const files = [];
  let total = 0;
  for (const att of list) {
    if (!att || typeof att.fileName !== 'string' || typeof att.dataBase64 !== 'string') return fail(400, 'invalid attachment');
    if (!isAllowedUpload(att.fileName)) return fail(400, 'file type not allowed');
    const data = Buffer.from(att.dataBase64, 'base64');
    total += data.length;
    if (data.length === 0) return fail(400, 'invalid attachment');
    if (data.length > maxBytes || total > REMOTE_ATTACHMENT_MAX_BYTES) return fail(400, `attachment too large - max ${Math.floor(maxBytes / 1024 / 1024)}MB`);
    const mimeType = typeof att.mimeType === 'string' && MIME_RE.test(att.mimeType) ? att.mimeType : 'application/octet-stream';
    files.push({ fileName: sanitizeFilename(att.fileName), mimeType, data });
  }
  return { files };
}

function storeAttachments(channel, messageId, files) {
  if (!files.length) return;
  const dir = path.join(DATA_DIR, 'attachments', `channel-${channel.id}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) {
    const storedName = `${crypto.randomBytes(8).toString('hex')}-${f.fileName}`;
    fs.writeFileSync(path.join(dir, storedName), f.data);
    db.prepare('INSERT INTO attachments (message_id, file_path, file_name, mime_type, size_bytes) VALUES (?, ?, ?, ?, ?)')
      .run(messageId, `/uploads/attachments/channel-${channel.id}/${storedName}`, f.fileName, f.mimeType, f.data.length);
  }
}

// Same path resolution deleteAttachmentFiles uses, but refuses anything that escapes the folder.
function readStoredFile(relUrl, folder) {
  const root = path.join(DATA_DIR, folder);
  const abs = path.join(DATA_DIR, String(relUrl || '').replace(/^\/uploads\//, ''));
  if (!abs.startsWith(root + path.sep)) return null;
  try { return fs.readFileSync(abs); } catch { return null; }
}

function loadThread(channel, payload) {
  return Number.isInteger(payload.threadId)
    ? db.prepare('SELECT * FROM threads WHERE id = ? AND channel_id = ?').get(payload.threadId, channel.id) || null : null;
}

function pageMessages(scopeType, scopeId, payload) {
  const before = Number.isInteger(payload.before) && payload.before > 0 ? payload.before : null;
  const limit = Math.min(Math.max(Number.isInteger(payload.limit) ? payload.limit : 50, 1), 100);
  const rows = before
    ? db.prepare(`SELECT * FROM messages WHERE scope_type = ? AND scope_id = ? AND event_type IS NULL AND id < ? ORDER BY id DESC LIMIT ?`).all(scopeType, scopeId, before, limit)
    : db.prepare(`SELECT * FROM messages WHERE scope_type = ? AND scope_id = ? AND event_type IS NULL ORDER BY id DESC LIMIT ?`).all(scopeType, scopeId, limit);
  return { ok: true, messages: rows.reverse().map(serializeRemoteMessage), hasMore: rows.length === limit };
}

function reactionUpdate(channel, row) {
  const updated = db.prepare('SELECT * FROM messages WHERE id = ?').get(row.id);
  broadcastToChannel(channel, { type: 'message_update', message: serializeMessage(updated) });
  const message = serializeRemoteMessage(updated);
  relayRemoteChannelEvent(channel, 'reaction_update', { message });
  return { ok: true, message };
}

const rpcHandlers = {
  server_info(peer, payload) {
    const ctx = loadServer(peer, payload);
    if (!ctx) return fail(403, 'not_member');
    const channels = db.prepare('SELECT * FROM channels WHERE server_id = ? ORDER BY position ASC, id ASC').all(ctx.server.id)
      .filter((ch) => TEXT_CHANNEL_TYPES.has(ch.type))
      .map((ch) => ({ ch, bits: getChannelPermissionBits(ch, ctx.user.id) }))
      .filter(({ bits }) => has(bits, PERMISSIONS.VIEW_CHANNEL))
      .map(({ ch, bits }) => ({ id: ch.id, name: ch.name, type: ch.type, canSend: has(bits, PERMISSIONS.SEND_MESSAGES) }));
    return {
      ok: true,
      server: { id: ctx.server.id, name: ctx.server.name, description: ctx.server.description, iconPath: ctx.server.icon_path || null },
      channels,
      selfUserId: ctx.user.id,
    };
  },

  // Public-safe fields only: no email, bio, roles, nicknames or local ids beyond the member's own.
  list_members(peer, payload) {
    const ctx = loadServer(peer, payload);
    if (!ctx) return fail(403, 'not_member');
    const rows = db.prepare(
      'SELECT u.* FROM server_members sm JOIN users u ON u.id = sm.user_id WHERE sm.server_id = ? ORDER BY u.display_name COLLATE NOCASE ASC, u.id ASC LIMIT 1000'
    ).all(ctx.server.id);
    return {
      ok: true,
      members: rows.map((u) => ({
        id: u.id,
        ...remoteIdentity(u),
        displayName: u.display_name,
        status: toPublicUser(u, {}).status,
        hasAvatar: !!u.avatar_path,
        isOwner: u.id === ctx.server.owner_id,
      })),
    };
  },

  member_avatar(peer, payload) {
    const ctx = loadServer(peer, payload);
    if (!ctx) return fail(403, 'not_member');
    const target = Number.isInteger(payload.userId)
      ? db.prepare('SELECT u.avatar_path FROM server_members sm JOIN users u ON u.id = sm.user_id WHERE sm.server_id = ? AND u.id = ?').get(ctx.server.id, payload.userId) : null;
    const fileName = target?.avatar_path ? path.basename(target.avatar_path) : '';
    const data = fileName && remoteImageType(fileName) ? readStoredFile(target.avatar_path, 'avatars') : null;
    if (!data || data.length > MAX_AVATAR_BYTES) return fail(404, 'avatar not found');
    return { ok: true, fileName, dataBase64: data.toString('base64') };
  },

  list_messages: withChannel((ctx, { channel }, payload) => pageMessages('channel', channel.id, payload)),

  list_threads: withChannel((ctx, { channel }) => {
    const threads = db.prepare('SELECT * FROM threads WHERE channel_id = ? ORDER BY id DESC LIMIT 200').all(channel.id).map((row) => {
      const stats = db.prepare(`SELECT COUNT(*) AS n, MAX(created_at) AS last FROM messages WHERE scope_type = 'thread' AND scope_id = ? AND event_type IS NULL`).get(row.id);
      const creator = db.prepare('SELECT display_name FROM users WHERE id = ?').get(row.created_by);
      return {
        id: row.id, title: row.title, archived: !!row.archived, createdAt: row.created_at,
        lastMessageAt: stats.last || row.created_at, messageCount: stats.n, createdBy: creator?.display_name || '',
      };
    });
    threads.sort((a, b) => new Date(b.lastMessageAt) - new Date(a.lastMessageAt));
    return { ok: true, threads };
  }),

  list_thread_messages: withChannel((ctx, { channel }, payload) => {
    const thread = loadThread(channel, payload);
    if (!thread) return fail(404, 'thread not found');
    return pageMessages('thread', thread.id, payload);
  }),

  // Only an attachment on a message in this channel (or one of its threads) the caller can VIEW.
  get_attachment: withChannel((ctx, { channel }, payload) => {
    const att = Number.isInteger(payload.attachmentId) ? db.prepare(
      `SELECT a.* FROM attachments a JOIN messages m ON m.id = a.message_id
        WHERE a.id = ? AND ((m.scope_type = 'channel' AND m.scope_id = ?) OR (m.scope_type = 'thread' AND m.scope_id IN (SELECT id FROM threads WHERE channel_id = ?)))`
    ).get(payload.attachmentId, channel.id, channel.id) : null;
    if (!att) return fail(404, 'attachment not found');
    if (att.size_bytes > REMOTE_ATTACHMENT_MAX_BYTES) return fail(413, 'attachment too large to fetch remotely');
    const data = readStoredFile(att.file_path, 'attachments');
    if (!data) return fail(404, 'attachment not found');
    if (data.length > REMOTE_ATTACHMENT_MAX_BYTES) return fail(413, 'attachment too large to fetch remotely');
    return { ok: true, fileName: att.file_name, mimeType: att.mime_type, dataBase64: data.toString('base64') };
  }),

  channel_message_create: withChannel((ctx, { channel, bits }, payload) => {
    if (!has(bits, PERMISSIONS.SEND_MESSAGES)) return fail(403, 'missing permission');
    const timeoutUntil = getMemberTimeout(ctx.server.id, ctx.user.id);
    if (timeoutUntil) return fail(403, 'timed_out', { timeoutUntil });
    const retryAfter = slowmodeRetryAfter(channel, ctx.user.id);
    if (retryAfter > 0) return fail(429, 'slowmode', { retryAfter });
    const content = String(payload.content || '').slice(0, maxMessageChars());
    const decoded = decodeAttachments(payload.attachments, bits);
    if (!decoded.files) return decoded;
    if (!content.trim() && decoded.files.length === 0) return fail(400, 'content required');

    const info = db.prepare(`INSERT INTO messages (scope_type, scope_id, author_id, content) VALUES ('channel', ?, ?, ?)`).run(channel.id, ctx.user.id, content);
    storeAttachments(channel, info.lastInsertRowid, decoded.files);
    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid);
    const local = serializeMessage(row);
    broadcastToChannel(channel, { type: 'message_create', message: local });
    const message = serializeRemoteMessage(row);
    relayRemoteChannelEvent(channel, 'message_create', { message });

    const candidateUsers = db.prepare('SELECT u.id, u.username FROM server_members sm JOIN users u ON u.id = sm.user_id WHERE sm.server_id = ?').all(ctx.server.id);
    const roles = db.prepare('SELECT id, name FROM roles WHERE server_id = ?').all(ctx.server.id);
    notifyChannelMessage(channel, local, parseMentions(content, { candidateUsers, roles }));
    return { ok: true, message };
  }),

  channel_message_edit: withChannel((ctx, { channel }, payload) => {
    const row = loadChannelMessage(channel, payload);
    if (!row) return fail(404, 'message not found');
    if (row.author_id !== ctx.user.id) return fail(403, 'not your message');
    const content = String(payload.content || '').slice(0, maxMessageChars());
    if (!content.trim()) return fail(400, 'content required');
    db.prepare(`UPDATE messages SET content = ?, edited_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(content, row.id);
    const updated = db.prepare('SELECT * FROM messages WHERE id = ?').get(row.id);
    broadcastToChannel(channel, { type: 'message_update', message: serializeMessage(updated) });
    const message = serializeRemoteMessage(updated);
    relayRemoteChannelEvent(channel, 'message_update', { message });
    return { ok: true, message };
  }),

  channel_message_delete: withChannel((ctx, { channel }, payload) => {
    const row = loadChannelMessage(channel, payload);
    if (!row) return fail(404, 'message not found');
    if (row.author_id !== ctx.user.id) return fail(403, 'not your message');
    // Lazy: routes/messages.js itself requires lib code this file's siblings depend on.
    require('../routes/messages').deleteAttachmentFiles(row.id);
    db.prepare('DELETE FROM messages WHERE id = ?').run(row.id);
    broadcastToChannel(channel, { type: 'message_delete', messageId: row.id, scopeType: 'channel', scopeId: channel.id });
    relayRemoteChannelEvent(channel, 'message_delete', { messageId: row.id });
    return { ok: true };
  }),

  channel_reaction_add: withChannel((ctx, { channel }, payload) => {
    const row = loadChannelMessage(channel, payload);
    if (!row) return fail(404, 'message not found');
    const emoji = cleanEmoji(payload);
    if (!emoji) return fail(400, 'emoji required');
    const timeoutUntil = getMemberTimeout(ctx.server.id, ctx.user.id);
    if (timeoutUntil) return fail(403, 'timed_out', { timeoutUntil });
    db.prepare('INSERT OR IGNORE INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)').run(row.id, ctx.user.id, emoji);
    return reactionUpdate(channel, row);
  }),

  channel_reaction_remove: withChannel((ctx, { channel }, payload) => {
    const row = loadChannelMessage(channel, payload);
    if (!row) return fail(404, 'message not found');
    db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(row.id, ctx.user.id, cleanEmoji(payload));
    return reactionUpdate(channel, row);
  }),

  leave_server(peer, payload) {
    const ctx = loadServer(peer, payload);
    if (!ctx) return fail(403, 'not_member');
    removeMember(ctx.server.id, ctx.user.id);
    broadcastToServer(ctx.server.id, { type: 'member_leave', userId: ctx.user.id, serverId: ctx.server.id });
    postServerEvent(ctx.server.id, 'member_leave', ctx.user.id);
    return { ok: true };
  },
};

function handleRpc(peer, type, payload) {
  const handler = Object.hasOwn(rpcHandlers, type) ? rpcHandlers[type] : null;
  return handler ? handler(peer, payload) : fail(400, 'unknown rpc type');
}

module.exports = { handleRpc, MUTATING_TYPES };
