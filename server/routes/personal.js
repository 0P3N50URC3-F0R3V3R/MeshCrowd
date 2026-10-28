'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { serializeMessage } = require('../lib/messages');
const { canViewMessage, muteExpiry } = require('../lib/userMeta');
const { singleLine } = require('../lib/textSanitize');

const router = express.Router();
// Mounted at /api, so auth is scoped to this router's own paths; a bare router.use() would 401 every
// public /api route registered after it (config, login-params, ...).
router.use(['/user-annotations', '/dm-prefs', '/bookmarks', '/reminders'], requireAuth);

const MAX_NOTE = 256;
const MAX_NICKNAME = 32;

// ---- notes / nicknames / ignore, all private to the viewer ----

router.get('/user-annotations', (req, res) => {
  const rows = db.prepare('SELECT target_id, note, nickname, ignored FROM user_annotations WHERE user_id = ?').all(req.user.id);
  res.json({ annotations: rows.map((r) => ({ targetId: r.target_id, note: r.note, nickname: r.nickname, ignored: !!r.ignored })) });
});

router.put('/user-annotations/:targetId', (req, res) => {
  const targetId = Number(req.params.targetId);
  if (!Number.isInteger(targetId) || targetId === req.user.id) return res.status(400).json({ error: 'invalid user' });
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(targetId)) return res.status(404).json({ error: 'user not found' });
  const b = req.body || {};
  const cur = db.prepare('SELECT * FROM user_annotations WHERE user_id = ? AND target_id = ?').get(req.user.id, targetId)
    || { note: null, nickname: null, ignored: 0 };
  const next = { note: cur.note, nickname: cur.nickname, ignored: cur.ignored };
  if ('note' in b) {
    if (b.note !== null && typeof b.note !== 'string') return res.status(400).json({ error: 'note must be a string or null' });
    next.note = b.note === null ? null : (b.note.trim().slice(0, MAX_NOTE) || null);
  }
  if ('nickname' in b) {
    if (b.nickname !== null && typeof b.nickname !== 'string') return res.status(400).json({ error: 'nickname must be a string or null' });
    next.nickname = b.nickname === null ? null : (singleLine(b.nickname, MAX_NICKNAME) || null);
  }
  if ('ignored' in b) {
    if (typeof b.ignored !== 'boolean') return res.status(400).json({ error: 'ignored must be a boolean' });
    next.ignored = b.ignored ? 1 : 0;
  }
  if (next.note === null && next.nickname === null && !next.ignored) {
    db.prepare('DELETE FROM user_annotations WHERE user_id = ? AND target_id = ?').run(req.user.id, targetId);
  } else {
    db.prepare(
      `INSERT INTO user_annotations (user_id, target_id, note, nickname, ignored) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, target_id) DO UPDATE SET note = excluded.note, nickname = excluded.nickname, ignored = excluded.ignored`
    ).run(req.user.id, targetId, next.note, next.nickname, next.ignored);
  }
  res.json({ annotation: { targetId, note: next.note, nickname: next.nickname, ignored: !!next.ignored } });
});

// ---- DM list: pin / favorite / close ----

router.get('/dm-prefs', (req, res) => {
  const rows = db.prepare('SELECT dm_id, pinned, favorite, hidden FROM dm_prefs WHERE user_id = ?').all(req.user.id);
  res.json({ prefs: rows.map((r) => ({ dmId: r.dm_id, pinned: !!r.pinned, favorite: !!r.favorite, hidden: !!r.hidden })) });
});

router.put('/dm-prefs/:dmId', (req, res) => {
  const dmId = Number(req.params.dmId);
  if (!Number.isInteger(dmId)) return res.status(400).json({ error: 'invalid conversation' });
  if (!db.prepare('SELECT 1 FROM dm_members WHERE dm_channel_id = ? AND user_id = ?').get(dmId, req.user.id)) {
    return res.status(403).json({ error: 'not a member of this conversation' });
  }
  const b = req.body || {};
  const cur = db.prepare('SELECT * FROM dm_prefs WHERE user_id = ? AND dm_id = ?').get(req.user.id, dmId) || { pinned: 0, favorite: 0, hidden: 0 };
  const next = { pinned: cur.pinned, favorite: cur.favorite, hidden: cur.hidden };
  for (const key of ['pinned', 'favorite', 'hidden']) {
    if (key in b) {
      if (typeof b[key] !== 'boolean') return res.status(400).json({ error: `${key} must be a boolean` });
      next[key] = b[key] ? 1 : 0;
    }
  }
  db.prepare(
    `INSERT INTO dm_prefs (user_id, dm_id, pinned, favorite, hidden) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, dm_id) DO UPDATE SET pinned = excluded.pinned, favorite = excluded.favorite, hidden = excluded.hidden`
  ).run(req.user.id, dmId, next.pinned, next.favorite, next.hidden);
  res.json({ pref: { dmId, pinned: !!next.pinned, favorite: !!next.favorite, hidden: !!next.hidden } });
});

// ---- bookmarks ----

function locate(message) {
  if (message.scope_type === 'dm') return { serverId: null, channelId: null, label: null };
  const channel = message.scope_type === 'channel'
    ? db.prepare('SELECT c.id, c.name, s.id AS server_id, s.name AS server_name FROM channels c JOIN servers s ON s.id = c.server_id WHERE c.id = ?').get(message.scope_id)
    : db.prepare('SELECT c.id, c.name, s.id AS server_id, s.name AS server_name FROM threads t JOIN channels c ON c.id = t.channel_id JOIN servers s ON s.id = c.server_id WHERE t.id = ?').get(message.scope_id);
  if (!channel) return { serverId: null, channelId: null, label: null };
  return { serverId: channel.server_id, channelId: channel.id, label: `${channel.server_name} > #${channel.name}` };
}

router.get('/bookmarks', (req, res) => {
  const rows = db.prepare(
    `SELECT m.*, b.created_at AS bookmarked_at FROM message_bookmarks b JOIN messages m ON m.id = b.message_id
      WHERE b.user_id = ? ORDER BY b.created_at DESC`
  ).all(req.user.id);
  const bookmarks = rows.filter((m) => canViewMessage(req.user.id, m)).map((m) => ({
    message: serializeMessage(m), scopeType: m.scope_type, scopeId: m.scope_id, bookmarkedAt: m.bookmarked_at, ...locate(m),
  }));
  res.json({ bookmarks });
});

router.get('/bookmarks/ids', (req, res) => {
  res.json({ ids: db.prepare('SELECT message_id FROM message_bookmarks WHERE user_id = ?').all(req.user.id).map((r) => r.message_id) });
});

router.put('/bookmarks/:messageId', (req, res) => {
  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.messageId);
  if (!message || !canViewMessage(req.user.id, message)) return res.status(404).json({ error: 'message not found' });
  db.prepare('INSERT OR IGNORE INTO message_bookmarks (user_id, message_id) VALUES (?, ?)').run(req.user.id, message.id);
  res.json({ ok: true });
});

router.delete('/bookmarks/:messageId', (req, res) => {
  db.prepare('DELETE FROM message_bookmarks WHERE user_id = ? AND message_id = ?').run(req.user.id, Number(req.params.messageId));
  res.json({ ok: true });
});

// ---- reminders ----

router.post('/reminders', (req, res) => {
  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.body?.messageId);
  if (!message || !canViewMessage(req.user.id, message)) return res.status(404).json({ error: 'message not found' });
  const remindAt = muteExpiry({ minutes: Number(req.body?.minutes) });
  if (!remindAt) return res.status(400).json({ error: 'minutes must be a positive number' });
  const info = db.prepare('INSERT INTO message_reminders (user_id, message_id, remind_at) VALUES (?, ?, ?)').run(req.user.id, message.id, remindAt);
  res.status(201).json({ reminder: { id: info.lastInsertRowid, messageId: message.id, remindAt } });
});

router.get('/reminders', (req, res) => {
  const rows = db.prepare('SELECT id, message_id, remind_at FROM message_reminders WHERE user_id = ? AND delivered_at IS NULL ORDER BY remind_at').all(req.user.id);
  res.json({ reminders: rows.map((r) => ({ id: r.id, messageId: r.message_id, remindAt: r.remind_at })) });
});

router.delete('/reminders/:id', (req, res) => {
  db.prepare('DELETE FROM message_reminders WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
  res.json({ ok: true });
});

module.exports = router;
