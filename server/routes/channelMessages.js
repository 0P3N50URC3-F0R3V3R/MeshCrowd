'use strict';

const express = require('express');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');
const { db, DATA_DIR } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { PERMISSIONS, has } = require('../lib/permissions');
const { getChannelPermissionBits } = require('../lib/channelAccess');
const { listMessages, serializeMessage } = require('../lib/messages');
const { broadcastToChannel } = require('../socket/hub');
const { parseMentions, notifyChannelMessage } = require('../lib/notifications');
const { onMessageCreated } = require('../lib/bots/events');
const automod = require('../lib/automod');
const { nsfwBlock } = require('../lib/ageGate');
const { verificationBlock } = require('../lib/verification');
const voiceMessages = require('../lib/voiceMessages');
const { load: loadConfig } = require('../lib/config');
const { sanitizeFilename, isAllowedUpload, fixUtf8Filename, rejectOversizedFiles } = require('../lib/uploads');
const { getMemberTimeout, slowmodeRetryAfter } = require('../lib/moderation');
const { maybeFetchAndAttachEmbed } = require('../lib/linkPreview');
const { serializeRemoteMessage, relayRemoteChannelEvent } = require('../lib/remoteChannelEvents');
const { maxMessageChars } = require('../lib/messageLimits');

const router = express.Router({ mergeParams: true });
const config = loadConfig();

function loadChannel(req, res, next) {
  const channel = db.prepare('SELECT * FROM channels WHERE id = ? AND server_id = ?')
    .get(req.params.channelId, req.params.id);
  if (!channel || channel.type === 'notes') return res.status(404).json({ error: 'channel not found' });
  const isMember = db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?')
    .get(channel.server_id, req.user.id);
  if (!isMember) return res.status(403).json({ error: 'not a member of this server' });
  req.channel = channel;
  next();
}

function requireChannelPerm(flag) {
  return (req, res, next) => {
    const bits = getChannelPermissionBits(req.channel, req.user.id);
    if (!has(bits, flag)) return res.status(403).json({ error: 'missing permission' });
    next();
  };
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(DATA_DIR, 'attachments', `channel-${req.channel.id}`);
    require('node:fs').mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, `${crypto.randomBytes(8).toString('hex')}-${sanitizeFilename(file.originalname)}`),
});
const upload = multer({
  storage,
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 5 },
  fileFilter: (req, file, cb) => {
    file.originalname = fixUtf8Filename(file.originalname);
    cb(null, isAllowedUpload(file.originalname));
  },
});

router.use(requireAuth, loadChannel);

router.get('/', requireChannelPerm(PERMISSIONS.VIEW_CHANNEL), (req, res) => {
  const gate = nsfwBlock(req.channel, req.user.id);
  if (gate) return res.status(gate.status).json(gate.body);
  const messages = listMessages('channel', req.channel.id, { before: req.query.before, after: req.query.after, limit: req.query.limit, around: req.query.around });
  res.json({ messages });
});

function blockIfRestricted(req, res, next) {
  const timeoutUntil = getMemberTimeout(req.channel.server_id, req.user.id);
  if (timeoutUntil) return res.status(403).json({ error: 'you are timed out in this server', timeoutUntil });
  const gate = nsfwBlock(req.channel, req.user.id) || verificationBlock(req.channel.server_id, req.user.id);
  if (gate) return res.status(gate.status).json(gate.body);
  const retryAfter = slowmodeRetryAfter(req.channel, req.user.id);
  if (retryAfter > 0) return res.status(429).json({ error: 'slowmode is active', retryAfter });
  next();
}

router.post('/', requireChannelPerm(PERMISSIONS.SEND_MESSAGES), blockIfRestricted, upload.array('files', 5), (req, res) => {
  if (req.files?.length && rejectOversizedFiles(req, res, config.maxUploadMb)) return;
  const content = String(req.body?.content || '').slice(0, maxMessageChars());
  let stickerId = null;
  if (req.body?.stickerId) {
    const sticker = db.prepare('SELECT id FROM stickers WHERE id = ? AND server_id = ?').get(Number(req.body.stickerId), req.channel.server_id);
    if (!sticker) return res.status(400).json({ error: 'sticker not found on this server' });
    stickerId = sticker.id;
  }
  if (!content.trim() && (!req.files || req.files.length === 0) && !stickerId) {
    return res.status(400).json({ error: 'message must have content, an attachment, or a sticker' });
  }
  if (req.files && req.files.length > 0 && !has(getChannelPermissionBits(req.channel, req.user.id), PERMISSIONS.ATTACH_FILES)) {
    return res.status(403).json({ error: 'missing permission: Attach Files' });
  }
  const blocked = automod.evaluate({ channel: req.channel, user: req.user, content });
  if (blocked) {
    for (const f of req.files || []) { try { require('node:fs').unlinkSync(f.path); } catch { /* already gone */ } }
    return res.status(403).json({ error: blocked.message, automod: true });
  }
  let voiceMs = null;
  try { voiceMs = voiceMessages.parseVoiceUpload(req.body, req.files); } catch (err) {
    voiceMessages.discardFiles(req.files);
    return res.status(err.status || 400).json({ error: err.message });
  }
  let replyToId = null;
  if (req.body?.replyToMessageId) {
    const parent = db.prepare('SELECT id FROM messages WHERE id = ? AND scope_type = ? AND scope_id = ?')
      .get(Number(req.body.replyToMessageId), 'channel', req.channel.id);
    if (parent) replyToId = parent.id;
  }
  const info = db.prepare('INSERT INTO messages (scope_type, scope_id, author_id, content, reply_to_message_id, sticker_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run('channel', req.channel.id, req.user.id, content, replyToId, stickerId);

  for (const f of req.files || []) {
    const rel = `/uploads/attachments/channel-${req.channel.id}/${f.filename}`;
    db.prepare('INSERT INTO attachments (message_id, file_path, file_name, mime_type, size_bytes, voice_ms) VALUES (?, ?, ?, ?, ?, ?)')
      .run(info.lastInsertRowid, rel, f.originalname, voiceMs ? voiceMessages.cleanMime(f.mimetype) : f.mimetype, f.size, voiceMs);
  }

  const message = serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid));
  broadcastToChannel(req.channel, { type: 'message_create', message });
  relayRemoteChannelEvent(req.channel, 'message_create', { message: serializeRemoteMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(message.id)) });
  maybeFetchAndAttachEmbed(message, (payload) => broadcastToChannel(req.channel, payload)).catch(() => {});

  const candidateUsers = db.prepare(
    `SELECT u.id, u.username FROM server_members sm JOIN users u ON u.id = sm.user_id WHERE sm.server_id = ?`
  ).all(req.channel.server_id);
  const roles = db.prepare('SELECT id, name FROM roles WHERE server_id = ?').all(req.channel.server_id);
  const mentions = parseMentions(content, { candidateUsers, roles });
  notifyChannelMessage(req.channel, message, mentions);
  onMessageCreated(message);

  res.status(201).json({ message });
});

module.exports = router;
