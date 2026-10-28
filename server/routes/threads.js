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
const { toPublicUser } = require('../lib/publicUser');
const { broadcastToChannel } = require('../socket/hub');
const { parseMentions, notifyChannelMessage } = require('../lib/notifications');
const { onMessageCreated } = require('../lib/bots/events');
const automod = require('../lib/automod');
const voiceMessages = require('../lib/voiceMessages');
const { load: loadConfig } = require('../lib/config');
const { sanitizeFilename, isAllowedUpload, fixUtf8Filename, rejectOversizedFiles } = require('../lib/uploads');
const { getMemberTimeout } = require('../lib/moderation');
const { nsfwBlock } = require('../lib/ageGate');
const { verificationBlock } = require('../lib/verification');
const { logAudit } = require('../lib/auditLog');
const { maybeFetchAndAttachEmbed } = require('../lib/linkPreview');
const { wipeScope } = require('../lib/prune');
const { maxMessageChars } = require('../lib/messageLimits');

const router = express.Router({ mergeParams: true });
const config = loadConfig();

function loadChannel(req, res, next) {
  const channel = db.prepare('SELECT * FROM channels WHERE id = ? AND server_id = ?').get(req.params.channelId, req.params.id);
  if (!channel || channel.type === 'notes') return res.status(404).json({ error: 'channel not found' });
  req.channel = channel;
  next();
}

function requireChannelPerm(flag) {
  return (req, res, next) => {
    if (!has(getChannelPermissionBits(req.channel, req.user.id), flag)) {
      return res.status(403).json({ error: 'missing permission' });
    }
    next();
  };
}

function loadThread(req, res, next) {
  const thread = db.prepare('SELECT * FROM threads WHERE id = ? AND channel_id = ?').get(req.params.threadId, req.channel.id);
  if (!thread) return res.status(404).json({ error: 'thread not found' });
  req.thread = thread;
  next();
}

function shapeThread(row) {
  const messageCount = db.prepare('SELECT COUNT(*) AS c FROM messages WHERE scope_type = ? AND scope_id = ?').get('thread', row.id).c;
  const lastMessage = db.prepare('SELECT created_at FROM messages WHERE scope_type = ? AND scope_id = ? ORDER BY id DESC LIMIT 1').get('thread', row.id);
  const creator = db.prepare('SELECT * FROM users WHERE id = ?').get(row.created_by);
  const first = db.prepare('SELECT m.id, m.content, m.author_id, u.display_name AS author FROM messages m JOIN users u ON u.id = m.author_id WHERE m.scope_type = ? AND m.scope_id = ? ORDER BY m.id ASC LIMIT 1').get('thread', row.id);
  let thumbnail = null; let reactionCount = 0; let topEmoji = null;
  if (first) {
    thumbnail = db.prepare("SELECT file_path FROM attachments WHERE message_id = ? AND mime_type LIKE 'image/%' ORDER BY id ASC LIMIT 1").get(first.id)?.file_path || null;
    const top = db.prepare('SELECT emoji, COUNT(*) AS n FROM message_reactions WHERE message_id = ? GROUP BY emoji ORDER BY n DESC, MIN(created_at) ASC').all(first.id);
    reactionCount = top.reduce((sum, x) => sum + x.n, 0);
    topEmoji = top[0]?.emoji || null;
  }
  return {
    id: row.id,
    preview: first ? { author: first.author, authorId: first.author_id, content: String(first.content || '').slice(0, 200) } : null,
    thumbnail,
    reactionCount,
    topEmoji,
    channelId: row.channel_id,
    parentMessageId: row.parent_message_id,
    title: row.title,
    createdBy: toPublicUser(creator, {}),
    // The thread's own custom icon, set via POST /:threadId/icon — the creator's avatar is only
    // ever a client-side rendering fallback (see forum.js) when this is null, never stored here.
    iconPath: row.icon_path,
    archived: !!row.archived,
    pinned: !!row.pinned,
    createdAt: row.created_at,
    messageCount,
    lastMessageAt: lastMessage ? lastMessage.created_at : row.created_at,
  };
}

function canManageThread(req) {
  return req.thread.created_by === req.user.id || has(getChannelPermissionBits(req.channel, req.user.id), PERMISSIONS.MANAGE_CHANNELS);
}

router.use(requireAuth, loadChannel, requireChannelPerm(PERMISSIONS.VIEW_CHANNEL));

router.get('/', (req, res) => {
  const threads = db.prepare('SELECT * FROM threads WHERE channel_id = ? ORDER BY id DESC').all(req.channel.id).map(shapeThread);
  threads.sort((a, b) => new Date(b.lastMessageAt) - new Date(a.lastMessageAt));
  res.json({ threads });
});

function blockIfTimedOut(req, res, next) {
  const timeoutUntil = getMemberTimeout(req.channel.server_id, req.user.id);
  if (timeoutUntil) return res.status(403).json({ error: 'you are timed out in this server', timeoutUntil });
  const gate = nsfwBlock(req.channel, req.user.id) || verificationBlock(req.channel.server_id, req.user.id);
  if (gate) return res.status(gate.status).json(gate.body);
  next();
}

router.post('/', requireChannelPerm(PERMISSIONS.SEND_MESSAGES), blockIfTimedOut, (req, res) => {
  const title = String(req.body?.title || '').trim().slice(0, 100);
  const content = String(req.body?.content || '').trim().slice(0, maxMessageChars());
  if (!title) return res.status(400).json({ error: 'title required' });
  if (!content) return res.status(400).json({ error: 'the first message cannot be empty' });

  let parentMessageId = null;
  if (req.body?.parentMessageId !== undefined && req.body?.parentMessageId !== null) {
    const parent = db.prepare('SELECT * FROM messages WHERE id = ? AND scope_type = ? AND scope_id = ?')
      .get(Number(req.body.parentMessageId), 'channel', req.channel.id);
    if (!parent) return res.status(404).json({ error: 'parent message not found in this channel' });
    parentMessageId = parent.id;
  }

  const info = db.prepare('INSERT INTO threads (channel_id, parent_message_id, title, created_by) VALUES (?, ?, ?, ?)')
    .run(req.channel.id, parentMessageId, title, req.user.id);
  const threadId = info.lastInsertRowid;

  const msgInfo = db.prepare('INSERT INTO messages (scope_type, scope_id, author_id, content) VALUES (?, ?, ?, ?)')
    .run('thread', threadId, req.user.id, content);
  const message = serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(msgInfo.lastInsertRowid));

  const thread = shapeThread(db.prepare('SELECT * FROM threads WHERE id = ?').get(threadId));
  broadcastToChannel(req.channel, { type: 'thread_create', channelId: req.channel.id, thread });
  broadcastToChannel(req.channel, { type: 'message_create', message });
  maybeFetchAndAttachEmbed(message, (payload) => broadcastToChannel(req.channel, payload)).catch(() => {});
  res.status(201).json({ thread, message });
});

router.patch('/:threadId', loadThread, (req, res) => {
  const wantsPin = req.body?.pinned !== undefined;
  const onlyPin = wantsPin && req.body.title === undefined && req.body.archived === undefined;
  if (wantsPin && !has(getChannelPermissionBits(req.channel, req.user.id), PERMISSIONS.MANAGE_MESSAGES)) {
    return res.status(403).json({ error: 'missing permission' });
  }
  if (!onlyPin && !canManageThread(req)) return res.status(403).json({ error: 'missing permission' });

  const updates = []; const params = [];
  if (wantsPin) { updates.push('pinned = ?'); params.push(req.body.pinned ? 1 : 0); }
  if (req.body?.title !== undefined) { updates.push('title = ?'); params.push(String(req.body.title).trim().slice(0, 100)); }
  if (req.body?.archived !== undefined) { updates.push('archived = ?'); params.push(req.body.archived ? 1 : 0); }
  if (updates.length) {
    params.push(req.thread.id);
    db.prepare(`UPDATE threads SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }
  const thread = shapeThread(db.prepare('SELECT * FROM threads WHERE id = ?').get(req.thread.id));
  broadcastToChannel(req.channel, { type: 'thread_update', channelId: req.channel.id, thread });
  res.json({ thread });
});

router.delete('/:threadId', loadThread, requireThreadManage, (req, res) => {
  wipeScope('thread', req.thread.id);
  if (req.thread.icon_path) {
    try { require('node:fs').unlinkSync(path.join(DATA_DIR, 'threadicons', path.basename(req.thread.icon_path))); } catch { /* already gone */ }
  }
  db.prepare('DELETE FROM threads WHERE id = ?').run(req.thread.id);
  logAudit(req.channel.server_id, req.user.id, 'thread_delete', 'channel', req.channel.id, { title: req.thread.title });
  broadcastToChannel(req.channel, { type: 'thread_delete', channelId: req.channel.id, threadId: req.thread.id });
  res.json({ ok: true });
});

router.get('/:threadId', loadThread, (req, res) => {
  res.json({ thread: shapeThread(req.thread) });
});

const ICON_ALLOWED = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const threadIconUpload = multer({
  storage: multer.diskStorage({
    destination: path.join(DATA_DIR, 'threadicons'),
    filename: (req, file, cb) => cb(null, `${req.params.threadId}-${crypto.randomBytes(6).toString('hex')}.png`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ICON_ALLOWED.has(file.mimetype)),
});

function requireThreadManage(req, res, next) {
  if (!canManageThread(req)) return res.status(403).json({ error: 'missing permission' });
  next();
}

router.post('/:threadId/icon', loadThread, requireThreadManage, threadIconUpload.single('icon'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'icon file required' });
  const rel = `/uploads/threadicons/${req.file.filename}`;
  if (req.thread.icon_path) {
    try { require('node:fs').unlinkSync(path.join(DATA_DIR, 'threadicons', path.basename(req.thread.icon_path))); } catch { /* already gone */ }
  }
  db.prepare('UPDATE threads SET icon_path = ? WHERE id = ?').run(rel, req.thread.id);
  const thread = shapeThread(db.prepare('SELECT * FROM threads WHERE id = ?').get(req.thread.id));
  broadcastToChannel(req.channel, { type: 'thread_update', channelId: req.channel.id, thread });
  res.json({ thread });
});

router.get('/:threadId/messages', loadThread, (req, res) => {
  const gate = nsfwBlock(req.channel, req.user.id);
  if (gate) return res.status(gate.status).json(gate.body);
  const messages = listMessages('thread', req.thread.id, { before: req.query.before, after: req.query.after, limit: req.query.limit, around: req.query.around });
  res.json({ messages });
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(DATA_DIR, 'attachments', `thread-${req.thread.id}`);
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

router.post('/:threadId/messages', loadThread, requireChannelPerm(PERMISSIONS.SEND_MESSAGES), blockIfTimedOut, upload.array('files', 5), (req, res) => {
  if (req.files?.length && rejectOversizedFiles(req, res, config.maxUploadMb)) return;
  if (req.thread.archived) return res.status(403).json({ error: 'this thread is archived' });
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
      .get(Number(req.body.replyToMessageId), 'thread', req.thread.id);
    if (parent) replyToId = parent.id;
  }
  const info = db.prepare('INSERT INTO messages (scope_type, scope_id, author_id, content, reply_to_message_id, sticker_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run('thread', req.thread.id, req.user.id, content, replyToId, stickerId);

  for (const f of req.files || []) {
    const rel = `/uploads/attachments/thread-${req.thread.id}/${f.filename}`;
    db.prepare('INSERT INTO attachments (message_id, file_path, file_name, mime_type, size_bytes, voice_ms) VALUES (?, ?, ?, ?, ?, ?)')
      .run(info.lastInsertRowid, rel, f.originalname, voiceMs ? voiceMessages.cleanMime(f.mimetype) : f.mimetype, f.size, voiceMs);
  }

  const message = serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid));
  broadcastToChannel(req.channel, { type: 'message_create', message });
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
module.exports.shapeThread = shapeThread;
