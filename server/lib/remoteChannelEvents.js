'use strict';

const path = require('node:path');
const { db } = require('../db');
const { PERMISSIONS, has } = require('./permissions');
const { getChannelPermissionBits } = require('./channelAccess');
const { serializeMessage } = require('./messages');
const { maxMessageChars } = require('./messageLimits');
const { enqueueEvent } = require('./federationOutbox');
const { ownDomain } = require('./federationOutboxWorker');
const { sanitizeFilename } = require('./uploads');

// Upper bound for one attachment transfer over the signed peer channel, in either direction. Base64
// inflates it by a third, which still fits the 12 MB RPC body and safeFetch response limits.
const REMOTE_ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;

// The only types a proxied remote file is ever served as; everything else is a forced download.
const REMOTE_IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

function remoteImageType(fileName) {
  return REMOTE_IMAGE_TYPES[path.extname(String(fileName || '')).toLowerCase()] || null;
}

// Where a user actually lives: a cached federated user carries its home username and domain.
function remoteIdentity(user) {
  const uid = user?.federated_uid;
  const at = uid ? uid.lastIndexOf('@') : -1;
  return at > 0 ? { username: uid.slice(0, at), domain: uid.slice(at + 1) } : { username: user?.username || '', domain: ownDomain() };
}

// The only shape of a channel message that ever leaves this instance for a remote member's home
// instance: without per-viewer or server-internal fields (attachments carry no URL; the home
// instance fetches them by id over RPC). `domain` is where the author actually lives, so the viewer
// can tell two same-named people on different instances apart.
function serializeRemoteMessage(row) {
  const m = serializeMessage(row);
  const author = db.prepare('SELECT username, federated_uid FROM users WHERE id = ?').get(row.author_id);
  const thread = row.scope_type === 'thread' ? db.prepare('SELECT channel_id FROM threads WHERE id = ?').get(row.scope_id) : null;
  const { username, domain } = remoteIdentity(author || { username: m.author.username });
  return {
    id: m.id,
    channelId: thread ? thread.channel_id : m.scopeId,
    threadId: thread ? row.scope_id : null,
    author: { id: m.author.id, username, displayName: m.author.displayName, domain },
    content: m.content,
    createdAt: m.createdAt,
    editedAt: m.editedAt,
    reactions: m.reactions,
    attachments: m.attachments.map((a) => ({ id: a.id, fileName: a.fileName, mimeType: a.mimeType, sizeBytes: a.sizeBytes })),
    unsupported: !m.content.trim() && m.attachments.length === 0,
  };
}

// One outbox row per remote home instance that has at least one member allowed to VIEW_CHANNEL.
// `viewers` names exactly those members (by their home-instance username) so the receiving
// instance never pushes a private channel's content to a different local user of that same
// instance who has no access here.
function relayRemoteChannelEvent(channel, kind, data) {
  const remoteMembers = db.prepare(
    `SELECT u.id AS userId, u.home_instance_id AS peerId, u.federated_uid AS uid FROM server_members m JOIN users u ON u.id = m.user_id
      WHERE m.server_id = ? AND u.home_instance_id IS NOT NULL AND u.federated_uid IS NOT NULL`
  ).all(channel.server_id);
  const viewersByPeer = new Map();
  for (const r of remoteMembers) {
    if (!has(getChannelPermissionBits(channel, r.userId), PERMISSIONS.VIEW_CHANNEL)) continue;
    if (!viewersByPeer.has(r.peerId)) viewersByPeer.set(r.peerId, []);
    viewersByPeer.get(r.peerId).push(r.uid.slice(0, r.uid.lastIndexOf('@')));
  }
  for (const [peerId, viewers] of viewersByPeer) {
    enqueueEvent(peerId, 'remote_channel_event', { serverId: channel.server_id, channelId: channel.id, kind, viewers, ...data });
  }
}

// Applied by the RECEIVING instance to anything a peer sent: remote content is hostile input.
function sanitizeRemoteMessage(m) {
  if (!m || typeof m !== 'object' || !Number.isInteger(m.id) || !Number.isInteger(m.channelId) || !m.author || typeof m.author !== 'object') return null;
  const str = (v, n) => String(v ?? '').slice(0, n);
  return {
    id: m.id,
    channelId: m.channelId,
    threadId: Number.isInteger(m.threadId) ? m.threadId : null,
    author: { id: Number(m.author.id) || 0, username: str(m.author.username, 64), displayName: str(m.author.displayName, 100), domain: str(m.author.domain, 255) },
    content: str(m.content, maxMessageChars()),
    createdAt: str(m.createdAt, 40),
    editedAt: m.editedAt ? str(m.editedAt, 40) : null,
    reactions: (Array.isArray(m.reactions) ? m.reactions.slice(0, 50) : []).map((r) => ({
      emoji: str(r?.emoji, 34), userIds: (Array.isArray(r?.userIds) ? r.userIds : []).filter(Number.isInteger).slice(0, 1000),
    })),
    // The type is derived here from the sanitized name, never taken from the peer: it decides
    // whether the client renders an <img>, and it is exactly what the download proxy will serve.
    attachments: (Array.isArray(m.attachments) ? m.attachments.slice(0, 10) : []).filter((a) => Number.isInteger(a?.id)).map((a) => {
      const fileName = sanitizeFilename(a.fileName);
      return { id: a.id, fileName, mimeType: remoteImageType(fileName) || 'application/octet-stream', sizeBytes: Number.isInteger(a.sizeBytes) && a.sizeBytes >= 0 ? a.sizeBytes : 0 };
    }),
    unsupported: !!m.unsupported,
  };
}

module.exports = {
  serializeRemoteMessage, relayRemoteChannelEvent, sanitizeRemoteMessage, remoteIdentity, remoteImageType, REMOTE_ATTACHMENT_MAX_BYTES,
};
