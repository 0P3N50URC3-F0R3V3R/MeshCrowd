'use strict';

const express = require('express');
const { seal } = require('../lib/atRest');
const { sealedDiskStorage, readAll } = require('../lib/fileSeal');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const multer = require('multer');
const { db, DATA_DIR } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { toPublicUser } = require('../lib/publicUser');
const { listMessages, serializeMessage } = require('../lib/messages');
const { areFriends, isBlocked } = require('../lib/friends');
const { broadcastToDm, notifyUser, notifyUserIds } = require('../socket/hub');
const { notifyDmMessage } = require('../lib/notifications');
const { onMessageCreated } = require('../lib/bots/events');
const voiceMessages = require('../lib/voiceMessages');
const { dmClosedServerIds } = require('../lib/serverPrefs');
const { searchMessages, parseFieldsParam } = require('../lib/search');
const { load: loadConfig } = require('../lib/config');
const { sanitizeFilename, liveUpload, rejectOversizedFiles } = require('../lib/uploads');
const { maybeFetchAndAttachEmbed } = require('../lib/linkPreview');
const prune = require('../lib/prune');
const { enqueueEvent } = require('../lib/federationOutbox');
const { ownDomain } = require('../lib/federationOutboxWorker');
const { maxMessageChars } = require('../lib/messageLimits');
const { stickersForUser, userCanUseSticker } = require('../lib/stickers');
const { afterResponse } = require('../lib/deferred');

const router = express.Router();
const config = loadConfig();

// Built per DESTINATION peer, not once for the whole channel: `inboxHandlers.dm_message_create`'s
// `resolveParticipant` (federationApi.js) only ever accepts a bare username (tried as local to the
// receiver) or a "name@domain" matching the SENDING peer's own domain — so what must be bare vs.
// qualified is relative to whichever peer this particular payload is headed to, not to us.
// The brief's original version got this backwards (qualifying OUR OWN local members as bare, and
// a remote member with their OWN home domain regardless of destination), which made the receiving
// handler's resolveParticipant fail to match either participant for even the plain 2-party case,
// so the whole DM relay was a silent no-op: `participants` ended up empty, the "author must be one
// of the participants" guard tripped, and the inbound handler returned before writing anything.
function federatedDmParticipants(dmChannelId, destinationPeerId) {
  const domain = ownDomain();
  return db.prepare(
    `SELECT u.username, u.home_instance_id, u.federated_uid
       FROM dm_members m JOIN users u ON u.id = m.user_id
      WHERE m.dm_channel_id = ?`
  ).all(dmChannelId).map((row) => {
    if (!row.home_instance_id) return `${row.username}@${domain}`; // genuinely local to us -> foreign to every peer
    if (row.home_instance_id === destinationPeerId) return row.federated_uid.split('@')[0]; // lives on the peer we're sending to -> bare
    // Cached from a THIRD peer (neither us nor the destination) — out of scope (see
    // resolveParticipant's comment in federationApi.js); qualifying with their own home domain at
    // least degrades safely, since the destination's domain check will just drop this entry.
    return row.federated_uid;
  });
}

const MAX_FEDERATED_ATTACHMENT_BYTES = 6 * 1024 * 1024; // ~8 MB once base64-encoded

function relayDmMessageCreate(dm, author, message, files) {
  const remoteHomeIds = db.prepare(
    `SELECT DISTINCT u.home_instance_id AS id FROM dm_members m JOIN users u ON u.id = m.user_id
      WHERE m.dm_channel_id = ? AND u.home_instance_id IS NOT NULL`
  ).all(dm.id).map((r) => r.id);
  if (remoteHomeIds.length === 0) return;

  // Inline base64 must fit the peer's inbox body limit; past the budget the files are dropped and
  // the text says so, rather than the whole message dying on a 413 retry loop.
  const attachments = [];
  let budget = MAX_FEDERATED_ATTACHMENT_BYTES;
  let omitted = 0;
  for (const f of files || []) {
    if (f.size > budget) { omitted += 1; continue; }
    budget -= f.size;
    attachments.push({
      fileName: f.originalname,
      mimeType: f.mimetype,
      dataBase64: readAll(f.path).toString('base64'),
    });
  }
  // Federated peers have no sticker concept: it crosses as an ordinary image attachment.
  if (message.sticker) {
    try {
      const file = path.join(DATA_DIR, 'stickers', path.basename(message.sticker.imagePath));
      const ext = path.extname(file).slice(1).toLowerCase();
      const data = fs.readFileSync(file);
      if (data.length <= budget) {
        attachments.push({ fileName: `${message.sticker.name}.${ext}`, mimeType: `image/${ext === 'jpg' ? 'jpeg' : ext}`, dataBase64: data.toString('base64') });
      }
    } catch { /* sticker file gone: the text part still goes through */ }
  }
  const content = omitted ? `${message.content}
[${omitted} attachment(s) too large to send across instances]`.trim() : message.content;
  for (const peerId of remoteHomeIds) {
    enqueueEvent(peerId, 'dm_message_create', {
      fromRemoteId: author.id, fromUsername: author.username, displayName: author.display_name,
      participants: federatedDmParticipants(dm.id, peerId), content, attachments, dmMessageId: String(message.id),
    });
  }
}

function canDm(fromUser, toUser) {
  if (isBlocked(fromUser.id, toUser.id)) return false;
  if (toUser.dm_privacy === 'none') return false;
  if (toUser.dm_privacy === 'friends' && !areFriends(fromUser.id, toUser.id)) return false;
  if (closedByEveryShare(fromUser.id, toUser.id) && !areFriends(fromUser.id, toUser.id)) return false;
  return true;
}

// Per-server privacy: the target switched DMs off for every server they share with the sender.
function closedByEveryShare(fromId, toId) {
  const shared = db.prepare(
    `SELECT a.server_id FROM server_members a JOIN server_members b ON a.server_id = b.server_id AND b.user_id = ? WHERE a.user_id = ?`
  ).all(toId, fromId).map((r) => r.server_id);
  if (!shared.length) return false;
  const closed = dmClosedServerIds(toId);
  return shared.every((id) => closed.has(id));
}

function loadDm(req, res, next) {
  const dm = db.prepare('SELECT * FROM dm_channels WHERE id = ?').get(req.params.dmId);
  if (!dm) return res.status(404).json({ error: 'conversation not found' });
  const member = db.prepare('SELECT 1 FROM dm_members WHERE dm_channel_id = ? AND user_id = ?').get(dm.id, req.user.id);
  if (!member) return res.status(403).json({ error: 'not a member of this conversation' });
  req.dm = dm;
  next();
}

router.use(requireAuth);

router.get('/', (req, res) => {
  const hidden = new Set(db.prepare('SELECT dm_id FROM dm_prefs WHERE user_id = ? AND hidden = 1').all(req.user.id).map((r) => r.dm_id));
  const dmIds = db.prepare('SELECT dm_channel_id FROM dm_members WHERE user_id = ?').all(req.user.id).map((r) => r.dm_channel_id).filter((id) => !hidden.has(id));
  const dms = dmIds.map((id) => {
    const dm = db.prepare('SELECT * FROM dm_channels WHERE id = ?').get(id);
    const members = db.prepare(
      `SELECT u.* FROM dm_members dm JOIN users u ON u.id = dm.user_id WHERE dm.dm_channel_id = ? AND dm.user_id != ?`
    ).all(id, req.user.id).map((u) => toPublicUser(u, {}));
    const last = db.prepare('SELECT * FROM messages WHERE scope_type = ? AND scope_id = ? ORDER BY id DESC LIMIT 1').get('dm', id);
    // Every other member's read pointer (not just a single 1:1 peer) — powers both the 1:1
    // "Seen" tag and a Discord-style reader-avatar row for group DMs.
    const readStates = db.prepare(
      'SELECT user_id AS userId, COALESCE(seen_id, last_read_message_id) AS lastReadMessageId FROM read_state WHERE scope_type = ? AND scope_id = ? AND user_id != ?'
    ).all('dm', id, req.user.id);
    const closer = dm.closed_by ? db.prepare('SELECT * FROM users WHERE id = ?').get(dm.closed_by) : null;
    return { id: dm.id, closedBy: closer ? toPublicUser(closer, {}) : null, isGroup: !!dm.is_group, name: dm.name, createdBy: dm.created_by, members, lastMessage: last ? serializeMessage(last) : null, readStates };
  });
  res.json({ dms });
});

router.post('/', (req, res) => {
  const targetId = Number(req.body?.userId);
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).json({ error: 'user not found' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'cannot DM yourself' });
  if (target.is_bot) {
    const bot = db.prepare('SELECT * FROM bots WHERE user_id = ?').get(target.id);
    const shares = bot && db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(bot.server_id, req.user.id);
    if (!bot || !shares) return res.status(404).json({ error: 'user not found' });
    if (!bot.dm_enabled) return res.status(403).json({ error: 'this bot does not accept direct messages' });
  } else if (!canDm(req.user, target)) {
    return res.status(403).json({ error: 'this user is not accepting messages from you' });
  }

  const existing = db.prepare(
    `SELECT dc.id FROM dm_channels dc
       JOIN dm_members m1 ON m1.dm_channel_id = dc.id AND m1.user_id = ?
       JOIN dm_members m2 ON m2.dm_channel_id = dc.id AND m2.user_id = ?
      WHERE dc.is_group = 0`
  ).get(req.user.id, target.id);
  if (existing) {
    db.prepare('UPDATE dm_prefs SET hidden = 0 WHERE user_id = ? AND dm_id = ?').run(req.user.id, existing.id);
    return res.json({ dmId: existing.id });
  }

  const info = db.prepare('INSERT INTO dm_channels (is_group, created_by) VALUES (0, ?)').run(req.user.id);
  const dmId = info.lastInsertRowid;
  db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?), (?, ?)')
    .run(dmId, req.user.id, dmId, target.id);
  notifyUser(target.id, {
    type: 'dm_create',
    dm: { id: dmId, isGroup: false, name: null, members: [toPublicUser(req.user, {})], lastMessage: null, readStates: [] },
  });
  res.status(201).json({ dmId });
});

router.post('/group', (req, res) => {
  const { userIds, name } = req.body || {};
  if (!Array.isArray(userIds) || userIds.length < 2) {
    return res.status(400).json({ error: 'group DM needs at least 2 other members' });
  }
  const uniqueIds = [...new Set(userIds.map(Number).filter((id) => Number.isInteger(id) && id !== req.user.id))];
  if (uniqueIds.length < 2) return res.status(400).json({ error: 'group DM needs at least 2 other members' });
  if (uniqueIds.length > 9) return res.status(400).json({ error: 'group DMs are limited to 10 members' });

  const targets = uniqueIds.map((id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id));
  const missing = targets.some((t) => !t);
  if (missing) return res.status(404).json({ error: 'one or more users not found' });
  if (targets.some((t) => t.is_bot)) return res.status(400).json({ error: 'bots cannot be added to group conversations' });
  const forbidden = targets.some((t) => !canDm(req.user, t));
  if (forbidden) return res.status(403).json({ error: 'one or more users are not accepting messages from you' });

  const info = db.prepare('INSERT INTO dm_channels (is_group, name, created_by) VALUES (1, ?, ?)')
    .run(String(name || '').slice(0, 100) || null, req.user.id);
  const dmId = info.lastInsertRowid;
  db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?)').run(dmId, req.user.id);
  for (const t of targets) {
    db.prepare('INSERT OR IGNORE INTO dm_members (dm_channel_id, user_id) VALUES (?, ?)').run(dmId, t.id);
  }

  const dm = db.prepare('SELECT * FROM dm_channels WHERE id = ?').get(dmId);
  for (const t of targets) {
    const members = db.prepare(
      `SELECT u.* FROM dm_members dm JOIN users u ON u.id = dm.user_id WHERE dm.dm_channel_id = ? AND dm.user_id != ?`
    ).all(dmId, t.id).map((u) => toPublicUser(u, {}));
    notifyUser(t.id, { type: 'dm_create', dm: { id: dm.id, isGroup: true, name: dm.name, createdBy: dm.created_by, members, lastMessage: null, readStates: [] } });
  }
  res.status(201).json({ dmId });
});

router.delete('/:dmId/members/me', loadDm, (req, res) => {
  db.prepare('DELETE FROM dm_members WHERE dm_channel_id = ? AND user_id = ?').run(req.dm.id, req.user.id);
  // Nobody left to see it — wipe the conversation for good instead of leaving an orphaned,
  // unreachable row (and its messages/attachments, which have no cascade path of their own).
  const remaining = db.prepare('SELECT COUNT(*) AS n FROM dm_members WHERE dm_channel_id = ?').get(req.dm.id).n;
  if (remaining === 0) {
    prune.wipeScope('dm', req.dm.id);
    db.prepare('DELETE FROM dm_channels WHERE id = ?').run(req.dm.id);
  } else if (!req.dm.is_group) {
    // The other side keeps the history until they choose to keep or delete it; they are asked.
    db.prepare('UPDATE dm_channels SET closed_by = ? WHERE id = ?').run(req.user.id, req.dm.id);
    const closedBy = toPublicUser(req.user, {});
    for (const m of db.prepare('SELECT user_id FROM dm_members WHERE dm_channel_id = ?').all(req.dm.id)) {
      notifyUser(m.user_id, { type: 'dm_closed', dmId: req.dm.id, closedBy });
    }
  }
  res.json({ ok: true });
});

// Group creator only — deletes the conversation outright for every member, not just yourself.
// Never available on a 1:1 DM: neither side is more "the creator" than the other there, so the
// existing leave-for-yourself route above is the only lever a 1:1 participant gets.
router.delete('/:dmId', loadDm, requireGroupCreator, (req, res) => {
  const memberIds = db.prepare('SELECT user_id FROM dm_members WHERE dm_channel_id = ?').all(req.dm.id).map((r) => r.user_id);
  prune.wipeScope('dm', req.dm.id);
  db.prepare('DELETE FROM dm_channels WHERE id = ?').run(req.dm.id);
  notifyUserIds(memberIds, { type: 'dm_delete', dmId: req.dm.id });
  res.json({ ok: true });
});

router.get('/stickers', (req, res) => {
  res.json({ stickers: stickersForUser(req.user.id) });
});

router.get('/:dmId/messages', loadDm, (req, res) => {
  const messages = listMessages('dm', req.dm.id, { before: req.query.before, after: req.query.after, limit: req.query.limit, around: req.query.around });
  res.json({ messages });
});

router.get('/:dmId/search', loadDm, (req, res) => {
  const fields = parseFieldsParam(req.query.fields);
  const messages = searchMessages('dm', [req.dm.id], req.query.q, { limit: req.query.limit, fields });
  res.json({ messages });
});

// DM files are sealed while they stream to disk and stored under a random name; the real name lives
// sealed in the database and the file is only served to conversation members (routes/dmFiles.js).
const storage = sealedDiskStorage({
  destination: (req) => path.join(DATA_DIR, 'attachments', `dm-${req.dm.id}`),
  filename: () => `${crypto.randomBytes(12).toString('hex')}.bin`,
});
const upload = liveUpload({ storage });

router.post('/:dmId/messages', loadDm, upload.array('files', 5), (req, res) => {
  if (req.files?.length && rejectOversizedFiles(req, res)) return;
  if (!req.dm.is_group) {
    const otherRow = db.prepare(
      'SELECT user_id FROM dm_members WHERE dm_channel_id = ? AND user_id != ?'
    ).get(req.dm.id, req.user.id);
    if (!otherRow) return res.status(409).json({ error: 'the other participant closed this conversation' });
    if (otherRow && isBlocked(req.user.id, otherRow.user_id)) {
      return res.status(403).json({ error: 'you cannot message this user' });
    }
  }
  const content = String(req.body?.content || '').slice(0, maxMessageChars());
  let stickerId = null;
  if (req.body?.stickerId) {
    if (!userCanUseSticker(req.user.id, req.body.stickerId)) return res.status(400).json({ error: 'sticker not available' });
    stickerId = Number(req.body.stickerId);
  }
  if (!content.trim() && (!req.files || req.files.length === 0) && !stickerId) {
    return res.status(400).json({ error: 'message must have content, an attachment, or a sticker' });
  }
  let voiceMs = null;
  try { voiceMs = voiceMessages.parseVoiceUpload(req.body, req.files); } catch (err) {
    voiceMessages.discardFiles(req.files);
    return res.status(err.status || 400).json({ error: err.message });
  }
  let replyToId = null;
  if (req.body?.replyToMessageId) {
    const parent = db.prepare('SELECT id FROM messages WHERE id = ? AND scope_type = ? AND scope_id = ?')
      .get(Number(req.body.replyToMessageId), 'dm', req.dm.id);
    if (parent) replyToId = parent.id;
  }
  const info = db.prepare('INSERT INTO messages (scope_type, scope_id, author_id, content, reply_to_message_id, sticker_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run('dm', req.dm.id, req.user.id, seal(content), replyToId, stickerId);

  for (const f of req.files || []) {
    const rel = `/uploads/attachments/dm-${req.dm.id}/${f.filename}`;
    db.prepare('INSERT INTO attachments (message_id, file_path, file_name, mime_type, size_bytes, voice_ms) VALUES (?, ?, ?, ?, ?, ?)')
      .run(info.lastInsertRowid, rel, seal(sanitizeFilename(f.originalname)), voiceMs ? voiceMessages.cleanMime(f.mimetype) : f.mimetype, f.size, voiceMs);
  }

  const message = serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid));
  broadcastToDm(req.dm.id, { type: 'message_create', message });
  relayDmMessageCreate(req.dm, req.user, message, req.files);
  maybeFetchAndAttachEmbed(message, (payload) => broadcastToDm(req.dm.id, payload)).catch(() => {});
  res.status(201).json({ message });
  afterResponse('dm-message', () => {
    notifyDmMessage(req.dm, message);
    return onMessageCreated(message);
  });
});

// Group creator only — never available on a 1:1 DM (its only lever is leave, above), and never
// assignable to anyone else the way server permissions are: groups have no role system. Guards
// both the prune routes below and the full-delete route above.
function requireGroupCreator(req, res, next) {
  if (!req.dm.is_group) return res.status(403).json({ error: 'not available on a 1:1 conversation' });
  if (req.dm.created_by !== req.user.id) return res.status(403).json({ error: 'only the group creator can do this' });
  next();
}

function parseDmPruneBody(body) {
  if (!body?.cutoff || Number.isNaN(new Date(body.cutoff).getTime())) return { error: 'a valid cutoff date is required' };
  return { cutoffAt: new Date(body.cutoff).toISOString(), purgeAttachments: !!body.purgeAttachments };
}

router.post('/:dmId/prune/preview', loadDm, requireGroupCreator, (req, res) => {
  const parsed = parseDmPruneBody(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const pairs = prune.resolveScopePairs('dm', [req.dm.id]);
  res.json(prune.previewPrune(pairs, parsed.cutoffAt, parsed.purgeAttachments));
});

router.post('/:dmId/prune/execute', loadDm, requireGroupCreator, (req, res) => {
  const parsed = parseDmPruneBody(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const result = prune.executePrune({
    scopeKind: 'dm', ids: [req.dm.id], cutoffAt: parsed.cutoffAt, purgeAttachments: parsed.purgeAttachments,
    notify: 'immediate', requestedBy: req.user.id, serverId: null,
  });
  res.json(result);
});

module.exports = router;
// Shared with federationApi.js's inbound dm_message_create handler, so a federated peer is held
// to the exact same block/dm_privacy consent gate a local DM-creation request already enforces —
// see that handler's call site for why it's only applied when a NEW channel is about to be created.
module.exports.canDm = canDm;
