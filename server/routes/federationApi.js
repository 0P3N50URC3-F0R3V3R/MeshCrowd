'use strict';

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, DATA_DIR } = require('../db');
const { verifyPayload, getOrCreateKeypair } = require('../lib/federationCrypto');
const { isSafePeerUrl } = require('../lib/federationSsrf');
const { load: loadConfig } = require('../lib/config');
const { verifyFederationRequest } = require('../middleware/federationVerify');
const { resolveOrCreateRemoteUser } = require('../lib/federationUsers');
const { getChannelPermissionBits } = require('../lib/channelAccess');
const { has, PERMISSIONS } = require('../lib/permissions');
const { pairKey } = require('../lib/friends');
const { sanitizeFilename, isAllowedUpload, effectiveMaxUploadMb } = require('../lib/uploads');
const { broadcastToChannel, broadcastToDm, notifyUser, notifySiteAdmins } = require('../socket/hub');
const { serializeMessage } = require('../lib/messages');
const { canDm } = require('./dms');
const { deleteAttachmentFiles } = require('./messages');
const { logFederationAudit } = require('../lib/federationAuditLog');
const { getMemberTimeout } = require('../lib/moderation');
const { ownDomain } = require('../lib/federationOutboxWorker');
const { CONTROL_EVENT_TYPES } = require('../lib/federationOutbox');
const { handleRpc, MUTATING_TYPES } = require('../lib/remoteChannelRpc');
const { sanitizeRemoteMessage } = require('../lib/remoteChannelEvents');
const { maxMessageChars } = require('../lib/messageLimits');

const router = express.Router();
const config = loadConfig();

// Populated by later tasks (10-13, 17): type -> (peer, payload) => void
const inboxHandlers = {};

// Pairing control: each moves only the sender's own row, and only along the transition it is
// entitled to ask for. A pending peer can never activate itself — peer_accept applies only to a row
// WE originated (outbound), which only the inviter's admin can resolve.
const peerUpdated = () => notifySiteAdmins({ type: 'federation_peer_update' });

inboxHandlers.peer_accept = (peer) => {
  const r = db.prepare(`UPDATE federation_peers SET status = 'active' WHERE id = ? AND status = 'pending' AND direction = 'outbound'`).run(peer.id);
  if (r.changes) peerUpdated();
};

inboxHandlers.peer_reject = (peer) => {
  const r = db.prepare(`UPDATE federation_peers SET status = 'revoked' WHERE id = ? AND status = 'pending' AND direction = 'outbound'`).run(peer.id);
  if (r.changes) peerUpdated();
};

inboxHandlers.peer_revoke = (peer) => {
  const r = db.prepare(`UPDATE federation_peers SET status = 'revoked' WHERE id = ? AND status IN ('pending', 'active')`).run(peer.id);
  db.prepare('DELETE FROM remote_memberships WHERE peer_id = ?').run(peer.id);
  if (r.changes) peerUpdated();
};

inboxHandlers.user_update = (peer, payload) => {
  resolveOrCreateRemoteUser(peer, payload);
};

inboxHandlers.friend_request = (peer, payload) => {
  const remote = resolveOrCreateRemoteUser(peer, { remoteId: payload.fromRemoteId, username: payload.fromUsername, displayName: payload.displayName });
  const local = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE AND is_bot = 0').get(payload.toUsername);
  if (!local) return; // target doesn't exist locally (deleted since?) — silently drop
  const [a, b] = pairKey(local.id, remote.id);
  const existing = db.prepare('SELECT 1 FROM friendships WHERE user_a = ? AND user_b = ?').get(a, b);
  if (existing) return;
  db.prepare('INSERT INTO friendships (user_a, user_b, status, requested_by) VALUES (?, ?, ?, ?)').run(a, b, 'pending', remote.id);
};

inboxHandlers.friend_accept = (peer, payload) => {
  const remote = resolveOrCreateRemoteUser(peer, { remoteId: payload.fromRemoteId, username: payload.fromUsername, displayName: payload.displayName });
  const local = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE AND is_bot = 0').get(payload.toUsername);
  if (!local) return;
  const [a, b] = pairKey(local.id, remote.id);
  // Only closes a request WE sent (requested_by = local user): a peer can never mint a friendship
  // out of nothing, which would bypass friends-only DM privacy.
  db.prepare(`UPDATE friendships SET status = 'accepted' WHERE user_a = ? AND user_b = ? AND status = 'pending' AND requested_by = ?`)
    .run(a, b, local.id);
};

inboxHandlers.friend_remove = (peer, payload) => {
  const remote = resolveOrCreateRemoteUser(peer, { remoteId: payload.fromRemoteId, username: payload.fromUsername, displayName: payload.displayName });
  const local = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE AND is_bot = 0').get(payload.toUsername);
  if (!local) return;
  const [a, b] = pairKey(local.id, remote.id);
  db.prepare('DELETE FROM friendships WHERE user_a = ? AND user_b = ?').run(a, b);
};

function resolveParticipant(peer, usernameOrFederated) {
  if (usernameOrFederated.includes('@')) {
    const [username, domain] = usernameOrFederated.split('@');
    // Only the authenticated sender's own domain may be asserted without re-verification here;
    // a participant on a THIRD domain would need its own peer record to resolve safely, and is
    // out of scope for a first pass (2-party or same-origin group DMs only).
    if (domain !== peer.domain) return null;
    return resolveOrCreateRemoteUser(peer, { remoteId: null, username });
  }
  return db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE AND is_bot = 0').get(usernameOrFederated);
}

function findExistingDmChannel(memberIds) {
  const sorted = [...new Set(memberIds)].sort((a, b) => a - b);
  const placeholders = sorted.map(() => '?').join(',');
  const candidates = db.prepare(
    `SELECT dm_channel_id FROM dm_members WHERE user_id IN (${placeholders})
     GROUP BY dm_channel_id HAVING COUNT(*) = ?`
  ).all(...sorted, sorted.length);
  for (const c of candidates) {
    const total = db.prepare('SELECT COUNT(*) AS n FROM dm_members WHERE dm_channel_id = ?').get(c.dm_channel_id).n;
    if (total === sorted.length) return c.dm_channel_id;
  }
  return null;
}

function createDmChannel(memberIds, createdBy) {
  // Deduped first: a payload whose participants resolve to the same user id twice (e.g. a bare
  // local username that also happens to collide with how a cache row was addressed) would
  // otherwise hit dm_members' PRIMARY KEY (dm_channel_id, user_id) mid-loop and throw — after the
  // dm_channels row is already committed, leaving an orphaned channel with a partial member list.
  const sorted = [...new Set(memberIds)].sort((a, b) => a - b);
  // dm_channels.created_by is NOT NULL with no DDL default, and is_group has no way to be inferred
  // after the fact — both must be supplied on insert, unlike the brief's `DEFAULT VALUES` (which
  // would throw a NOT NULL constraint failure on created_by for every brand-new channel).
  const info = db.prepare('INSERT INTO dm_channels (is_group, created_by) VALUES (?, ?)')
    .run(sorted.length > 2 ? 1 : 0, createdBy);
  for (const id of sorted) db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?)').run(info.lastInsertRowid, id);
  return info.lastInsertRowid;
}

inboxHandlers.dm_message_create = (peer, payload) => {
  const author = resolveOrCreateRemoteUser(peer, { remoteId: payload.fromRemoteId, username: payload.fromUsername, displayName: payload.displayName });
  let participants = (payload.participants || []).map((p) => resolveParticipant(peer, p)).filter(Boolean);
  if (!participants.some((p) => p.id === author.id)) return; // author must be one of the participants

  let dmChannelId = findExistingDmChannel(participants.map((p) => p.id));
  if (dmChannelId === null) {
    // Brand-new channel only: a peer naming a local username in `participants` must not be able to
    // force that local user into a conversation their own block list or dm_privacy setting would
    // otherwise refuse — apply the exact same consent gate dms.js's local DM-creation routes
    // (POST /, POST /group) enforce, from the remote author's perspective as the instigator.
    // Reusing an *existing* channel skips this: every real member already consented when it was
    // first created, by this same check or by a genuine local DM/group-DM creation.
    participants = participants.filter((p) => p.home_instance_id || canDm(author, p));
    const hasLocalRecipient = participants.some((p) => !p.home_instance_id);
    if (!hasLocalRecipient) return; // only remote-cache users left — nobody real here would ever see it
    dmChannelId = createDmChannel(participants.map((p) => p.id), author.id);
  }

  // Same bounds the local POST path enforces (dms.js: content.slice(0, maxMessageChars()), multer's
  // `files: 5` + rejectOversizedFiles, isAllowedUpload's extension denylist/allowlist) — remote
  // content must pass through identical sanitization to local content, not an honor system.
  // An attachment that fails a check is dropped individually rather than discarding the whole
  // message, so one bad attachment in a batch doesn't also swallow otherwise-valid text content.
  const content = String(payload.content || '').slice(0, maxMessageChars());
  const maxBytes = effectiveMaxUploadMb(config.maxUploadMb) * 1024 * 1024;
  const validAttachments = (payload.attachments || []).slice(0, 5).filter((att) => {
    if (!att?.fileName || !isAllowedUpload(att.fileName)) return false;
    const size = Buffer.byteLength(att.dataBase64 || '', 'base64');
    return size > 0 && size <= maxBytes;
  });

  const info = db.prepare(
    `INSERT INTO messages (scope_type, scope_id, author_id, content, federation_peer_id, federation_message_id) VALUES ('dm', ?, ?, ?, ?, ?)`
  ).run(dmChannelId, author.id, content, peer.id, payload.dmMessageId);

  if (validAttachments.length > 0) {
    const dir = path.join(DATA_DIR, 'attachments', `dm-${dmChannelId}`);
    fs.mkdirSync(dir, { recursive: true });
    for (const att of validAttachments) {
      const storedName = `${crypto.randomBytes(8).toString('hex')}-${sanitizeFilename(att.fileName)}`;
      fs.writeFileSync(path.join(dir, storedName), Buffer.from(att.dataBase64, 'base64'));
      // Matches the URL shape dms.js's own local upload path writes (`/uploads/attachments/dm-X/name`)
      // and that lib/messages.js's serializeMessage reads straight back as `attachment.url` — the
      // brief's `path.join('attachments', ...)` would instead store an OS-specific relative path
      // (backslashes on Windows) with no `/uploads/` prefix, breaking every attachment link.
      const relUrl = `/uploads/attachments/dm-${dmChannelId}/${storedName}`;
      db.prepare('INSERT INTO attachments (message_id, file_path, file_name, mime_type, size_bytes) VALUES (?, ?, ?, ?, ?)')
        .run(info.lastInsertRowid, relUrl, sanitizeFilename(att.fileName), att.mimeType || 'application/octet-stream', Buffer.byteLength(att.dataBase64, 'base64'));
    }
  }

  // serializeMessage, not the raw row: the client's ws:message_create handlers key off the
  // serialized shape (scopeType, author, attachments[]) exactly like dms.js's own local POST
  // broadcast does — broadcasting the raw row (author_id, scope_type) would silently render blank.
  broadcastToDm(dmChannelId, { type: 'message_create', dmChannelId, message: serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid)) });
};

function findFederatedMessage(peer, originMessageId) {
  return db.prepare('SELECT * FROM messages WHERE federation_peer_id = ? AND federation_message_id = ?').get(peer.id, originMessageId);
}

// Reactions, unlike edit/delete, are legitimately initiated by ANY DM participant from ANY
// instance, not just the message's true origin. findFederatedMessage alone only matches a row
// THIS instance cached as "received from peer X" — the one row it can never match is the TRUE
// origin's own locally-authored copy (federation_peer_id IS NULL there, by definition), so a
// reaction relayed back to the author's own home instance would otherwise silently vanish for
// them. Falls back to the local same-id row, but only once the sending peer is confirmed to
// actually have a cached member in that message's DM — otherwise any signed peer could react to
// an arbitrary local message id just by naming it.
function findMessageForReaction(peer, originMessageId) {
  const cached = findFederatedMessage(peer, originMessageId);
  if (cached) return cached;
  const own = db.prepare('SELECT * FROM messages WHERE federation_peer_id IS NULL AND id = ?').get(originMessageId);
  if (!own || own.scope_type !== 'dm') return null;
  const peerIsMember = db.prepare(
    `SELECT 1 FROM dm_members m JOIN users u ON u.id = m.user_id WHERE m.dm_channel_id = ? AND u.home_instance_id = ?`
  ).get(own.scope_id, peer.id);
  return peerIsMember ? own : null;
}

function resolveReactionUser(peer, userUsername) {
  return resolveParticipant(peer, userUsername.includes('@') ? userUsername : `${userUsername}@${peer.domain}`);
}

inboxHandlers.dm_message_edit = (peer, payload) => {
  const msg = findFederatedMessage(peer, payload.originMessageId);
  if (!msg) return;
  // Same cap as the local PATCH /:id route (messages.js) — remote content gets no less scrutiny
  // than a local edit. A blank-after-trim edit is dropped rather than applied, same as the local
  // route's 400 (there is no requester here to reject, so silently keep the prior content).
  const content = String(payload.content || '').slice(0, maxMessageChars());
  if (!content.trim()) return;
  db.prepare(`UPDATE messages SET content = ?, edited_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(content, msg.id);
  const updated = serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(msg.id));
  broadcastToDm(msg.scope_id, { type: 'message_update', message: updated });
};

inboxHandlers.dm_message_delete = (peer, payload) => {
  const msg = findFederatedMessage(peer, payload.originMessageId);
  if (!msg) return;
  // Hard delete, matching the local DELETE /:id route (messages.js) exactly. deleted_at is a dead
  // column nothing in this codebase reads or filters on (not serializeMessage, not listMessages,
  // not the web client) — setting it, as the brief's literal code does, would leave the message
  // fully visible with its original content the next time any client re-fetches history.
  deleteAttachmentFiles(msg.id);
  db.prepare('DELETE FROM messages WHERE id = ?').run(msg.id);
  broadcastToDm(msg.scope_id, { type: 'message_delete', messageId: msg.id, scopeType: msg.scope_type, scopeId: msg.scope_id });
};

inboxHandlers.dm_reaction_add = (peer, payload) => {
  const msg = findMessageForReaction(peer, payload.originMessageId);
  if (!msg) return;
  const user = resolveReactionUser(peer, payload.userUsername);
  if (!user) return;
  // Same cap as the local PUT /:id/reactions/:emoji route.
  const emoji = String(payload.emoji || '').slice(0, 34);
  if (!emoji) return;
  db.prepare('INSERT OR IGNORE INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)').run(msg.id, user.id, emoji);
  // message_update with the full serialized message, not a dedicated 'reaction_add' event — the
  // web client's ws bus (web/js/views/chat.js) only ever dispatches message_create/update/delete,
  // the exact same convention the local PUT reactions route itself uses.
  const updated = serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(msg.id));
  broadcastToDm(msg.scope_id, { type: 'message_update', message: updated });
};

inboxHandlers.dm_reaction_remove = (peer, payload) => {
  const msg = findMessageForReaction(peer, payload.originMessageId);
  if (!msg) return;
  const user = resolveReactionUser(peer, payload.userUsername);
  if (!user) return;
  const emoji = String(payload.emoji || '').slice(0, 34);
  db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(msg.id, user.id, emoji);
  const updated = serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(msg.id));
  broadcastToDm(msg.scope_id, { type: 'message_update', message: updated });
};

// Inbound post from a remote member into a channel this (receiving) instance actually owns —
// payload.channelId is a LOCAL id here, meaningful only because the receiver is the server's
// home/owning instance (the only place a `channels` row for it exists). The opposite direction
// (owner -> member's home instance) uses remote_channel_event instead, never this type.
function channelMessageCreate(peer, payload) {
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(payload.channelId);
  if (!channel || !['public', 'private', 'announcement', 'readonly'].includes(channel.type)) return { ok: false, error: 'channel not found' };
  const author = resolveOrCreateRemoteUser(peer, { remoteId: payload.remoteId, username: payload.username, displayName: payload.displayName });
  const isMember = db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(channel.server_id, author.id);
  if (!isMember) return { ok: false, error: 'not a member' };
  const authorBits = getChannelPermissionBits(channel, author.id);
  if (!has(authorBits, PERMISSIONS.VIEW_CHANNEL) || !has(authorBits, PERMISSIONS.SEND_MESSAGES)) return { ok: false, error: 'missing permission' };
  if (getMemberTimeout(channel.server_id, author.id)) return { ok: false, error: 'timed out' };
  // Required, not defaulted to a synthetic id: a message stored under an id the true origin
  // doesn't recognize could never be found again by findFederatedChannelMessage on a later
  // edit/delete/reaction, matching every other handler here that bails on missing required data
  // rather than inventing a placeholder.
  if (!payload.channelMessageId) return { ok: false, error: 'missing channelMessageId' };

  // Same message-length bound the local POST / route (channelMessages.js) applies — remote content
  // gets no less scrutiny than a local post (same gap class Tasks 12/13 found and fixed for the
  // DM equivalent).
  const content = String(payload.content || '').slice(0, maxMessageChars());
  if (!content.trim()) return { ok: false, error: 'content required' };

  const info = db.prepare(
    `INSERT INTO messages (scope_type, scope_id, author_id, content, federation_peer_id, federation_message_id) VALUES ('channel', ?, ?, ?, ?, ?)`
  ).run(channel.id, author.id, content, peer.id, String(payload.channelMessageId));
  // serializeMessage, not the raw row — the client's ws:message_create handler keys off
  // scopeType/scopeId/attachments[] (camelCase), absent on a raw DB row. Same Bug-5 fix Task 13
  // already applied to the DM equivalent of this broadcast.
  const message = serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid));
  broadcastToChannel(channel, { type: 'message_create', message });
  return { ok: true, message };
}
inboxHandlers.channel_message_create = channelMessageCreate;

router.post('/channel-message', verifyFederationRequest, (req, res) => {
  if (req.federationPeer.status !== 'active') return res.status(401).json({ error: 'invalid request' });
  res.json(channelMessageCreate(req.federationPeer, req.body.payload));
});

// Same (peer.id, federation_message_id) compound-key translation Task 13's findFederatedMessage
// established for DMs, scoped to scope_type = 'channel' — already proven to correctly stop peer
// A from editing/deleting a message that originated from peer B (Task 13 tested this explicitly
// for DMs with the identical pattern); not re-tested here since it's the same code shape, not new
// logic.
function findFederatedChannelMessage(peer, originMessageId) {
  return db.prepare(`SELECT * FROM messages WHERE scope_type = 'channel' AND federation_peer_id = ? AND federation_message_id = ?`)
    .get(peer.id, originMessageId);
}

// A remote author who has since been kicked/banned or lost VIEW_CHANNEL keeps no write access to old messages.
function authorCanStillView(msg) {
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(msg.scope_id);
  return !!channel && has(getChannelPermissionBits(channel, msg.author_id), PERMISSIONS.VIEW_CHANNEL);
}

inboxHandlers.channel_message_edit = (peer, payload) => {
  const msg = findFederatedChannelMessage(peer, payload.originMessageId);
  if (!msg || !authorCanStillView(msg)) return;
  // Same cap as the local PATCH /:id route (messages.js) — matches Task 13's dm_message_edit fix.
  const content = String(payload.content || '').slice(0, maxMessageChars());
  if (!content.trim()) return;
  db.prepare(`UPDATE messages SET content = ?, edited_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(content, msg.id);
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(msg.scope_id);
  if (channel) broadcastToChannel(channel, { type: 'message_update', message: serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(msg.id)) });
};

inboxHandlers.channel_message_delete = (peer, payload) => {
  const msg = findFederatedChannelMessage(peer, payload.originMessageId);
  if (!msg || !authorCanStillView(msg)) return;
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(msg.scope_id);
  // Unlinks the on-disk attachment files first, matching the local DELETE /:id route and Task
  // 13's dm_message_delete fix — a hard DELETE alone only removes the DB rows (cascaded), not
  // the files themselves.
  deleteAttachmentFiles(msg.id);
  db.prepare('DELETE FROM messages WHERE id = ?').run(msg.id);
  if (channel) broadcastToChannel(channel, { type: 'message_delete', messageId: msg.id, scopeType: 'channel', scopeId: msg.scope_id });
};

inboxHandlers.channel_reaction_add = (peer, payload) => {
  const msg = findFederatedChannelMessage(peer, payload.originMessageId);
  if (!msg) return;
  const user = resolveParticipant(peer, payload.userUsername.includes('@') ? payload.userUsername : `${payload.userUsername}@${peer.domain}`);
  if (!user) return;
  // Same cap as the local PUT /:id/reactions/:emoji route — matches Task 13's dm_reaction_add fix.
  const emoji = String(payload.emoji || '').slice(0, 34);
  if (!emoji) return;
  db.prepare('INSERT OR IGNORE INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)').run(msg.id, user.id, emoji);
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(msg.scope_id);
  if (channel) broadcastToChannel(channel, { type: 'message_update', message: serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(msg.id)) });
};

inboxHandlers.channel_reaction_remove = (peer, payload) => {
  const msg = findFederatedChannelMessage(peer, payload.originMessageId);
  if (!msg) return;
  const user = resolveParticipant(peer, payload.userUsername.includes('@') ? payload.userUsername : `${payload.userUsername}@${peer.domain}`);
  if (!user) return;
  const emoji = String(payload.emoji || '').slice(0, 34);
  db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(msg.id, user.id, emoji);
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(msg.scope_id);
  if (channel) broadcastToChannel(channel, { type: 'message_update', message: serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(msg.id)) });
};

// Owner instance -> member's home instance. Stores nothing: the event is pushed live to the local
// users who joined that remote server AND that the owner reported as allowed to view the channel
// (so one local user's access never exposes a private channel to another local user).
const REMOTE_EVENT_KINDS = new Set(['message_create', 'message_update', 'message_delete', 'reaction_update']);

inboxHandlers.remote_channel_event = (peer, payload) => {
  if (!REMOTE_EVENT_KINDS.has(payload.kind) || !Number.isInteger(payload.serverId) || !Number.isInteger(payload.channelId) || !Array.isArray(payload.viewers)) return;
  const viewers = new Set(payload.viewers.filter((v) => typeof v === 'string'));
  const event = { type: 'remote_channel_event', peerId: peer.id, serverId: payload.serverId, channelId: payload.channelId, kind: payload.kind };
  if (payload.kind === 'message_delete') {
    if (!Number.isInteger(payload.messageId)) return;
    event.messageId = payload.messageId;
  } else {
    event.message = sanitizeRemoteMessage(payload.message);
    if (!event.message || event.message.channelId !== payload.channelId) return;
  }
  const members = db.prepare(
    `SELECT u.id, u.username FROM remote_memberships m JOIN users u ON u.id = m.user_id WHERE m.peer_id = ? AND m.remote_server_id = ?`
  ).all(peer.id, payload.serverId);
  for (const u of members) {
    if (viewers.has(u.username)) notifyUser(u.id, event);
  }
};

// A cross-instance server invite: `code` is the invite code the owning (this) instance minted,
// `payload.username`/`remoteId`/`displayName` identify the redeeming user on the ORIGIN instance
// (peer). Returns a value synchronously (unlike the fire-and-forget inboxHandlers above) because
// the caller is the redeeming instance's own /join route, which needs a direct success/failure +
// server/channel summary to hand back to its own user — not a queued event with no reply.
function redeemInvite(peer, payload) {
  const server = db.prepare('SELECT * FROM servers WHERE invite_code = ?').get(payload.code);
  if (!server) return { ok: false, error: 'invite not found' };

  // Only matches if this federated_uid already has a local cache row — a user who has never been
  // seen before can't already be banned, so the subquery resolving to NULL (no match) is correct,
  // not a gap: `user_id = NULL` matches no row in server_bans either way.
  const banned = db.prepare('SELECT 1 FROM server_bans WHERE server_id = ? AND user_id = (SELECT id FROM users WHERE federated_uid = ?)')
    .get(server.id, `${payload.username}@${peer.domain}`);
  if (banned) return { ok: false, error: 'banned' };

  const remote = resolveOrCreateRemoteUser(peer, { remoteId: payload.remoteId, username: payload.username, displayName: payload.displayName });
  const already = db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(server.id, remote.id);
  if (!already) db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(server.id, remote.id);

  // Filtered to what the resolved remote member can actually VIEW_CHANNEL, exactly like the local
  // GET /:id route (servers.js) filters its own channel list by role/override permissions — a
  // private channel the @everyone role can't see must not be named in this response either, or a
  // federated joiner would learn private channels exist (and their ids) before ever having
  // permission to view them, which a locally-joining member never learns from GET /:id.
  // server_id is selected (and kept on `ch`) only because getChannelPermissionBits needs it to
  // look up the channel's owning server — stripped back out below so the response shape matches
  // the brief's {id, name, type}.
  const channels = db.prepare('SELECT id, name, type, server_id FROM channels WHERE server_id = ? ORDER BY position ASC, id ASC').all(server.id)
    .filter((ch) => has(getChannelPermissionBits(ch, remote.id), PERMISSIONS.VIEW_CHANNEL))
    .map((ch) => ({ id: ch.id, name: ch.name, type: ch.type }));
  return { ok: true, server: { id: server.id, name: server.name, description: server.description }, channels };
}
inboxHandlers.redeem_invite = redeemInvite;

router.post('/redeem-invite', verifyFederationRequest, (req, res) => {
  if (req.federationPeer.status !== 'active') return res.status(401).json({ error: 'invalid request' });
  const result = redeemInvite(req.federationPeer, req.body.payload ?? {});
  res.json(result);
});

// GET-safe counterpart to verifyFederationRequest: a GET carries no body, so the signed
// payload is { domain, timestamp } from the query string instead of the inbox's
// { event_id, type, origin_domain, created_at, payload }. Same tolerance and style as that
// middleware's replay window (-30s clock skew, +5min signature lifetime) for consistency, and
// the same single generic 401 message on every failure branch (missing fields, stale
// timestamp, unknown/inactive peer, bad signature) so an unauthenticated caller can't learn
// which domains are registered as peers by comparing responses.
function verifyFederationGet(req, res, next) {
  const { domain, timestamp, signature } = req.query;
  // Express parses a repeated query key (?domain=a&domain=b) as an array, and ?domain[]=a as an
  // object — the brief's literal `!domain` check lets either through (both are truthy), and
  // db.prepare(...).get(domain) then throws ("Unknown named parameter '0'"), crashing out past
  // every 401 branch into Express's default handler: an unauthenticated 500 with a stack trace
  // (including the server's absolute filesystem path) in the response body. Requiring all three
  // to be plain strings up front closes that off without changing behavior for any well-formed
  // request.
  if (typeof domain !== 'string' || typeof timestamp !== 'string' || typeof signature !== 'string') {
    return res.status(401).json({ error: 'invalid request' });
  }
  if (!domain || !timestamp || !signature) return res.status(401).json({ error: 'invalid request' });
  const age = Date.now() - new Date(timestamp).getTime();
  if (!Number.isFinite(age) || age < -30_000 || age > 5 * 60 * 1000) return res.status(401).json({ error: 'invalid request' });
  const peer = db.prepare(`SELECT * FROM federation_peers WHERE domain = ? AND status = 'active'`).get(domain);
  if (!peer) return res.status(401).json({ error: 'invalid request' });
  if (!verifyPayload({ domain, timestamp }, signature, peer.their_pubkey)) return res.status(401).json({ error: 'invalid request' });
  req.federationPeer = peer;
  next();
}

// A pure read of already-public data (servers a peer could already discover by any member
// mentioning the invite link) with no mutation and no side effect to replay — unlike /inbox,
// there is no event_id/dedup table here and none is needed: replaying a captured
// domain+timestamp+signature within its 5-minute window just re-returns the same public list.
router.get('/servers', verifyFederationGet, (req, res) => {
  // 'public' is the only visibility value servers.js ever exposes to a directory/search (see its
  // own GET /search and GET /:id/preview routes) — 'private' is the sole other value the schema
  // allows, so there is no third "unlisted but joinable" state being missed here.
  const rows = db.prepare(`SELECT id, name, description, auto_join, icon_path FROM servers WHERE visibility = 'public' AND kind = 'chat'`).all();
  res.json({ servers: rows.map((s) => ({ id: s.id, name: s.name, description: s.description, autoJoin: !!s.auto_join, iconPath: s.icon_path })) });
});

// Reachability heartbeat counterpart to federationHeartbeat.js's pingOnce: a peer that can reach
// us and produce a validly-signed request is, by definition, up — no payload beyond the generic
// verifyFederationGet checks is needed.
router.get('/ping', verifyFederationGet, (req, res) => res.json({ ok: true }));

router.post('/handshake', async (req, res) => {
  const { token, domain, publicUrl, pubkey, signature } = req.body || {};
  if (!token || !domain || !publicUrl || !pubkey || !signature) {
    logFederationAudit('federation_handshake_failure', 'federation_peer', null, { reason: 'missing_fields', domain });
    return res.status(400).json({ error: 'missing fields' });
  }

  const invite = db.prepare('SELECT * FROM federation_invites WHERE token = ?').get(token);
  if (!invite || invite.used_at || new Date(invite.expires_at).getTime() < Date.now()) {
    logFederationAudit('federation_handshake_failure', 'federation_peer', null, { reason: 'invalid_or_expired_invite', domain });
    return res.status(400).json({ error: 'invalid or expired invite' });
  }

  // Verified with the *claimed* pubkey from this same request — proves the caller holds the
  // matching private key, which is all a first handshake can establish (trust-on-first-use).
  const payload = { token, domain, publicUrl, pubkey };
  if (!verifyPayload(payload, signature, pubkey)) {
    logFederationAudit('federation_handshake_failure', 'federation_peer', null, { reason: 'signature_verification_failed', domain });
    return res.status(401).json({ error: 'signature verification failed' });
  }

  // The claimed domain must be the host the caller actually serves from, must not be this instance,
  // and must not already belong to a peer holding a different key — otherwise one invite token could
  // overwrite an existing peer's key and inherit all of its cached users.
  let publicHost = null;
  try { publicHost = new URL(publicUrl).host; } catch { /* rejected below */ }
  if (!publicHost || publicHost !== domain || domain === ownDomain()) {
    logFederationAudit('federation_handshake_failure', 'federation_peer', null, { reason: 'domain_mismatch', domain });
    return res.status(400).json({ error: 'domain must match the public URL host' });
  }
  const known = db.prepare('SELECT their_pubkey FROM federation_peers WHERE domain = ?').get(domain);
  if (known && known.their_pubkey !== pubkey) {
    logFederationAudit('federation_handshake_failure', 'federation_peer', null, { reason: 'domain_key_conflict', domain });
    return res.status(409).json({ error: 'domain already paired with a different key' });
  }

  // Claimed before the async URL check so two concurrent handshakes cannot redeem one token.
  const claimed = db.prepare('UPDATE federation_invites SET used_at = ? WHERE id = ? AND used_at IS NULL').run(new Date().toISOString(), invite.id);
  if (!claimed.changes) return res.status(400).json({ error: 'invalid or expired invite' });

  if (!(await isSafePeerUrl(publicUrl))) {
    db.prepare('UPDATE federation_invites SET used_at = NULL WHERE id = ?').run(invite.id);
    logFederationAudit('federation_handshake_failure', 'federation_peer', null, { reason: 'unsafe_public_url', domain });
    return res.status(400).json({ error: 'public URL is not a permitted federation target' });
  }

  db.prepare(
    `INSERT INTO federation_peers (domain, public_url, their_pubkey, status, direction, last_seen_at) VALUES (?, ?, ?, 'pending', 'inbound', ?)
     ON CONFLICT(domain) DO UPDATE SET
       public_url = excluded.public_url, their_pubkey = excluded.their_pubkey,
       status = CASE WHEN federation_peers.status = 'active' AND federation_peers.their_pubkey = excluded.their_pubkey THEN 'active' ELSE excluded.status END,
       direction = CASE WHEN federation_peers.status = 'active' AND federation_peers.their_pubkey = excluded.their_pubkey THEN federation_peers.direction ELSE excluded.direction END,
       last_seen_at = excluded.last_seen_at`
  ).run(domain, publicUrl, pubkey, new Date().toISOString());

  // lastInsertRowid from the upsert above is unreliable when it took the ON CONFLICT DO UPDATE
  // branch (a peer re-handshaking) rather than a genuine INSERT — look the real row up by domain.
  const peerRow = db.prepare('SELECT id FROM federation_peers WHERE domain = ?').get(domain);
  logFederationAudit('federation_handshake_success', 'federation_peer', peerRow.id, { domain });
  peerUpdated();

  const { publicKeyPem } = getOrCreateKeypair();
  const config = loadConfig();
  res.json({ ok: true, domain: config.federationPublicUrl ? new URL(config.federationPublicUrl).host : config.publicHost, pubkey: publicKeyPem });
});

// Synchronous request/response for a paired peer's users acting on servers THIS instance owns.
// Identity is asserted by the peer; every permission is re-derived locally (remoteChannelRpc.js).
router.post('/rpc', verifyFederationRequest, (req, res) => {
  const peer = req.federationPeer;
  if (peer.status !== 'active') return res.status(401).json({ error: 'invalid request' });
  const { event_id, type, payload } = req.body;
  if (typeof type !== 'string' || (payload != null && (typeof payload !== 'object' || Array.isArray(payload)))) {
    return res.status(400).json({ ok: false, status: 400, error: 'invalid request' });
  }
  if (MUTATING_TYPES.has(type)) {
    const already = db.prepare('SELECT 1 FROM federation_inbox_seen WHERE peer_id = ? AND event_id = ?').get(peer.id, event_id);
    if (already) return res.json({ ok: false, status: 409, error: 'replay' });
    db.prepare('INSERT INTO federation_inbox_seen (peer_id, event_id) VALUES (?, ?)').run(peer.id, event_id);
  }
  db.prepare('UPDATE federation_peers SET last_seen_at = ? WHERE id = ?').run(new Date().toISOString(), peer.id);
  res.json(handleRpc(peer, type, payload ?? {}));
});

router.post('/inbox', verifyFederationRequest, (req, res) => {
  const { event_id, type, payload } = req.body;
  if (req.federationPeer.status === 'pending' && !CONTROL_EVENT_TYPES.has(type)) {
    return res.status(403).json({ error: 'peer not active' });
  }
  const already = db.prepare('SELECT 1 FROM federation_inbox_seen WHERE peer_id = ? AND event_id = ?')
    .get(req.federationPeer.id, event_id);
  if (already) return res.json({ ok: true }); // idempotent replay ack

  db.prepare('INSERT INTO federation_inbox_seen (peer_id, event_id) VALUES (?, ?)').run(req.federationPeer.id, event_id);
  db.prepare('UPDATE federation_peers SET last_seen_at = ? WHERE id = ?').run(new Date().toISOString(), req.federationPeer.id);

  const handler = Object.hasOwn(inboxHandlers, type) ? inboxHandlers[type] : undefined;
  if (handler) handler(req.federationPeer, payload ?? {});
  // Unknown type: acknowledged but dropped (never processed) — matches the spec's
  // "unknown event type is dropped and logged, not best-effort processed."
  res.json({ ok: true });
});

module.exports = router;
module.exports.inboxHandlers = inboxHandlers;
