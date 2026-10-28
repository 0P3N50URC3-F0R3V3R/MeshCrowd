'use strict';

const express = require('express');
const multer = require('multer');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { callPeer } = require('../lib/federationRpc');
const { singleLine } = require('../lib/textSanitize');
const { load: loadConfig } = require('../lib/config');
const { sanitizeFilename, isAllowedUpload, fixUtf8Filename, effectiveMaxUploadMb } = require('../lib/uploads');
const { sanitizeRemoteMessage, remoteImageType, REMOTE_ATTACHMENT_MAX_BYTES } = require('../lib/remoteChannelEvents');
const { maxMessageChars } = require('../lib/messageLimits');

const router = express.Router();
router.use(requireAuth);

const config = loadConfig();
const REACHABLE_WINDOW_MS = 90_000;
const FILE_RPC_TIMEOUT_MS = 30_000;
const PASSTHROUGH_STATUSES = new Set([400, 403, 404, 413, 429]);
const MEMBER_STATUSES = new Set(['online', 'idle', 'dnd', 'offline']);

// Held in memory only long enough to forward to the owning instance, which stores the file.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Math.min(config.maxUploadMb * 1024 * 1024, REMOTE_ATTACHMENT_MAX_BYTES), files: 5 },
  fileFilter: (req, file, cb) => {
    file.originalname = fixUtf8Filename(file.originalname);
    cb(null, isAllowedUpload(file.originalname));
  },
});

router.get('/servers', (req, res) => {
  const rows = db.prepare(
    `SELECT m.peer_id, m.remote_server_id, m.name, m.icon_path, p.domain, p.last_seen_at
       FROM remote_memberships m JOIN federation_peers p ON p.id = m.peer_id
      WHERE m.user_id = ? AND p.status = 'active' ORDER BY m.id ASC`
  ).all(req.user.id);
  res.json({
    servers: rows.map((r) => ({
      peerId: r.peer_id,
      serverId: r.remote_server_id,
      name: r.name,
      iconPath: r.icon_path,
      domain: r.domain,
      reachable: !!r.last_seen_at && Date.now() - new Date(r.last_seen_at).getTime() < REACHABLE_WINDOW_MS,
    })),
  });
});

// Every route below acts only on a ledger row owned by the requesting user, on an active peer.
router.use('/:peerId/:serverId', (req, res, next) => {
  const peerId = Number(req.params.peerId);
  const serverId = Number(req.params.serverId);
  if (!Number.isInteger(peerId) || !Number.isInteger(serverId)) return res.status(404).json({ error: 'remote server not found' });
  const membership = db.prepare(
    `SELECT m.*, p.public_url, p.domain FROM remote_memberships m JOIN federation_peers p ON p.id = m.peer_id
      WHERE m.user_id = ? AND m.peer_id = ? AND m.remote_server_id = ? AND p.status = 'active'`
  ).get(req.user.id, peerId, serverId);
  if (!membership) return res.status(404).json({ error: 'remote server not found' });
  req.membership = membership;
  next();
});

function dropMembership(membership) {
  db.prepare('DELETE FROM remote_memberships WHERE id = ?').run(membership.id);
}

// Runs one RPC as the requesting user. Sends the error response itself and returns null on any
// failure so each route only handles its success path.
async function rpc(req, res, type, payload, options) {
  const peer = { public_url: req.membership.public_url };
  const result = await callPeer(peer, type, {
    ...payload,
    serverId: req.membership.remote_server_id,
    username: req.user.username,
    displayName: req.user.display_name,
    remoteId: req.user.id,
  }, options);
  if (result.ok) return result;
  if (result.error === 'not_member') {
    dropMembership(req.membership);
    res.status(404).json({ error: 'remote server not found' });
    return null;
  }
  const status = PASSTHROUGH_STATUSES.has(result.status) ? result.status : 502;
  const body = { error: status === 502 ? 'unreachable' : String(result.error || 'request failed').slice(0, 200) };
  if (result.retryAfter) body.retryAfter = result.retryAfter;
  if (result.timeoutUntil) body.timeoutUntil = result.timeoutUntil;
  res.status(status).json(body);
  return null;
}

const intParam = (v) => (/^\d{1,15}$/.test(String(v)) ? Number(v) : null);

// Serves bytes a peer returned as if they were a local attachment: the browser only ever sees this
// instance's URL, the name is re-sanitized, the type comes from that name (raster images inline,
// everything else a forced download) and the sandbox CSP stops it running as active content.
function sendProxiedFile(res, result, { imagesOnly = false } = {}) {
  const fileName = sanitizeFilename(result.fileName);
  const imageType = remoteImageType(fileName);
  if (typeof result.dataBase64 !== 'string' || (imagesOnly && !imageType)) return res.status(502).json({ error: 'unreachable' });
  res.setHeader('Content-Type', imageType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `${imageType ? 'inline' : 'attachment'}; filename="${fileName}"`);
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.send(Buffer.from(result.dataBase64, 'base64'));
}

router.get('/:peerId/:serverId/members', async (req, res) => {
  const result = await rpc(req, res, 'list_members', {});
  if (!result) return;
  const str = (v, n) => String(v ?? '').slice(0, n);
  res.json({
    members: (Array.isArray(result.members) ? result.members : []).slice(0, 1000).filter((m) => Number.isInteger(m?.id)).map((m) => ({
      id: m.id,
      username: str(m.username, 64),
      displayName: singleLine(str(m.displayName, 100), 100),
      domain: str(m.domain, 255),
      status: MEMBER_STATUSES.has(m.status) ? m.status : 'offline',
      hasAvatar: !!m.hasAvatar,
      isOwner: !!m.isOwner,
    })),
  });
});

router.get('/:peerId/:serverId/members/:userId/avatar', async (req, res) => {
  const userId = intParam(req.params.userId);
  if (userId === null) return res.status(404).json({ error: 'avatar not found' });
  const result = await rpc(req, res, 'member_avatar', { userId });
  if (!result) return;
  sendProxiedFile(res, result, { imagesOnly: true });
});

router.get('/:peerId/:serverId/channels/:channelId/attachments/:attachmentId', async (req, res) => {
  const channelId = intParam(req.params.channelId);
  const attachmentId = intParam(req.params.attachmentId);
  if (channelId === null || attachmentId === null) return res.status(404).json({ error: 'attachment not found' });
  const result = await rpc(req, res, 'get_attachment', { channelId, attachmentId }, { timeoutMs: FILE_RPC_TIMEOUT_MS });
  if (!result) return;
  sendProxiedFile(res, result);
});

router.get('/:peerId/:serverId/channels/:channelId/threads', async (req, res) => {
  const channelId = intParam(req.params.channelId);
  if (channelId === null) return res.status(404).json({ error: 'channel not found' });
  const result = await rpc(req, res, 'list_threads', { channelId });
  if (!result) return;
  const str = (v, n) => String(v ?? '').slice(0, n);
  res.json({
    threads: (Array.isArray(result.threads) ? result.threads : []).slice(0, 200).filter((th) => Number.isInteger(th?.id)).map((th) => ({
      id: th.id,
      title: singleLine(str(th.title, 100), 100),
      archived: !!th.archived,
      createdAt: str(th.createdAt, 40),
      lastMessageAt: str(th.lastMessageAt, 40),
      messageCount: Number.isInteger(th.messageCount) ? th.messageCount : 0,
      createdBy: singleLine(str(th.createdBy, 100), 100),
    })),
  });
});

router.get('/:peerId/:serverId/channels/:channelId/threads/:threadId/messages', async (req, res) => {
  const channelId = intParam(req.params.channelId);
  const threadId = intParam(req.params.threadId);
  if (channelId === null || threadId === null) return res.status(404).json({ error: 'thread not found' });
  const result = await rpc(req, res, 'list_thread_messages', { channelId, threadId, before: intParam(req.query.before), limit: intParam(req.query.limit) });
  if (!result) return;
  res.json({ messages: (Array.isArray(result.messages) ? result.messages : []).map(sanitizeRemoteMessage).filter(Boolean), hasMore: !!result.hasMore });
});

router.get('/:peerId/:serverId', async (req, res) => {
  const result = await rpc(req, res, 'server_info', {});
  if (!result) return;
  const name = singleLine(String(result.server?.name ?? ''), 100);
  const iconPath = result.server?.iconPath ? String(result.server.iconPath).slice(0, 255) : null;
  db.prepare('UPDATE remote_memberships SET name = ?, icon_path = ? WHERE id = ?').run(name || req.membership.name, iconPath, req.membership.id);
  res.json({
    peerId: req.membership.peer_id,
    domain: req.membership.domain,
    server: { id: req.membership.remote_server_id, name: name || req.membership.name, description: String(result.server?.description ?? '').slice(0, 500) },
    channels: (Array.isArray(result.channels) ? result.channels : []).slice(0, 500).map((c) => ({
      id: Number(c.id), name: singleLine(String(c.name ?? ''), 100), type: String(c.type), canSend: !!c.canSend,
    })),
    selfUserId: Number(result.selfUserId) || 0,
  });
});

// Leaving first asks the owner to drop the member row; the local ledger entry goes only once that
// succeeded (or the owner already considers us a non-member, which rpc() handles by dropping it).
router.delete('/:peerId/:serverId', async (req, res) => {
  const result = await rpc(req, res, 'leave_server', {});
  if (!result) return;
  dropMembership(req.membership);
  res.json({ ok: true });
});

const messages = '/:peerId/:serverId/channels/:channelId/messages';

router.get(messages, async (req, res) => {
  const channelId = intParam(req.params.channelId);
  if (channelId === null) return res.status(404).json({ error: 'channel not found' });
  const result = await rpc(req, res, 'list_messages', { channelId, before: intParam(req.query.before), limit: intParam(req.query.limit) });
  if (!result) return;
  res.json({ messages: (Array.isArray(result.messages) ? result.messages : []).map(sanitizeRemoteMessage).filter(Boolean), hasMore: !!result.hasMore });
});

router.post(messages, upload.array('files', 5), async (req, res) => {
  const channelId = intParam(req.params.channelId);
  if (channelId === null) return res.status(404).json({ error: 'channel not found' });
  const content = String(req.body?.content || '').slice(0, maxMessageChars());
  const files = req.files || [];
  if (!content.trim() && files.length === 0) return res.status(400).json({ error: 'content required' });
  const maxBytes = Math.min(effectiveMaxUploadMb(config.maxUploadMb) * 1024 * 1024, REMOTE_ATTACHMENT_MAX_BYTES);
  if (files.some((f) => f.size > maxBytes) || files.reduce((n, f) => n + f.size, 0) > REMOTE_ATTACHMENT_MAX_BYTES) {
    return res.status(400).json({ error: `attachments too large - max ${Math.floor(REMOTE_ATTACHMENT_MAX_BYTES / 1024 / 1024)}MB in total` });
  }
  const attachments = files.map((f) => ({ fileName: sanitizeFilename(f.originalname), mimeType: f.mimetype, dataBase64: f.buffer.toString('base64') }));
  const result = await rpc(req, res, 'channel_message_create', { channelId, content, ...(attachments.length ? { attachments } : {}) },
    attachments.length ? { timeoutMs: FILE_RPC_TIMEOUT_MS } : undefined);
  if (!result) return;
  { const message = sanitizeRemoteMessage(result.message); if (!message) return res.status(502).json({ error: 'unreachable' }); res.status(201).json({ message }); }
});

router.patch(`${messages}/:messageId`, async (req, res) => {
  const channelId = intParam(req.params.channelId);
  const messageId = intParam(req.params.messageId);
  if (channelId === null || messageId === null) return res.status(404).json({ error: 'message not found' });
  const content = String(req.body?.content || '').slice(0, maxMessageChars());
  if (!content.trim()) return res.status(400).json({ error: 'content required' });
  const result = await rpc(req, res, 'channel_message_edit', { channelId, messageId, content });
  if (!result) return;
  { const message = sanitizeRemoteMessage(result.message); if (!message) return res.status(502).json({ error: 'unreachable' }); res.json({ message }); }
});

router.delete(`${messages}/:messageId`, async (req, res) => {
  const channelId = intParam(req.params.channelId);
  const messageId = intParam(req.params.messageId);
  if (channelId === null || messageId === null) return res.status(404).json({ error: 'message not found' });
  if (!(await rpc(req, res, 'channel_message_delete', { channelId, messageId }))) return;
  res.json({ ok: true });
});

function reactionRoute(type) {
  return async (req, res) => {
    const channelId = intParam(req.params.channelId);
    const messageId = intParam(req.params.messageId);
    if (channelId === null || messageId === null) return res.status(404).json({ error: 'message not found' });
    const result = await rpc(req, res, type, { channelId, messageId, emoji: String(req.params.emoji || '').slice(0, 34) });
    if (!result) return;
    { const message = sanitizeRemoteMessage(result.message); if (!message) return res.status(502).json({ error: 'unreachable' }); res.json({ message }); }
  };
}
router.put(`${messages}/:messageId/reactions/:emoji`, reactionRoute('channel_reaction_add'));
router.delete(`${messages}/:messageId/reactions/:emoji`, reactionRoute('channel_reaction_remove'));

module.exports = router;
