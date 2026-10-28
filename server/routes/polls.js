'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { serializeMessage } = require('../lib/messages');
const { singleLine } = require('../lib/textSanitize');
const { canViewScope, canSendToScope } = require('../lib/scopeAccess');
const { getMemberTimeout } = require('../lib/moderation');

const router = express.Router();
router.use(requireAuth);

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 10;

router.post('/', (req, res) => {
  const { scopeType, scopeId, question, options, multiSelect } = req.body || {};
  if (!['channel', 'thread', 'dm'].includes(scopeType)) return res.status(400).json({ error: 'invalid scope' });
  const scopeIdNum = Number(scopeId);
  if (!Number.isInteger(scopeIdNum)) return res.status(400).json({ error: 'invalid scope' });

  const cleanQuestion = singleLine(question, 300);
  if (!cleanQuestion) return res.status(400).json({ error: 'question required' });
  const cleanOptions = Array.isArray(options)
    ? [...new Set(options.map((o) => singleLine(o, 100)).filter(Boolean))]
    : [];
  if (cleanOptions.length < MIN_OPTIONS || cleanOptions.length > MAX_OPTIONS) {
    return res.status(400).json({ error: `a poll needs ${MIN_OPTIONS}-${MAX_OPTIONS} options` });
  }

  const access = canSendToScope(scopeType, scopeIdNum, req.user.id);
  if (!access.ok) return res.status(access.status).json({ error: access.error });
  if (access.ctx.dm?.e2ee_enabled) return res.status(400).json({ error: 'polls are not supported in encrypted conversations' });

  const info = db.prepare('INSERT INTO messages (scope_type, scope_id, author_id, content) VALUES (?, ?, ?, ?)')
    .run(scopeType, scopeIdNum, req.user.id, cleanQuestion);
  const messageId = info.lastInsertRowid;

  const pollInfo = db.prepare('INSERT INTO polls (message_id, multi_select) VALUES (?, ?)').run(messageId, multiSelect ? 1 : 0);
  const pollId = pollInfo.lastInsertRowid;
  cleanOptions.forEach((label, i) => {
    db.prepare('INSERT INTO poll_options (poll_id, position, label) VALUES (?, ?, ?)').run(pollId, i, label);
  });

  const message = serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId));
  access.ctx.broadcast({ type: 'message_create', message });
  res.status(201).json({ message });
});

function loadPoll(req, res, next) {
  const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(req.params.pollId);
  if (!poll) return res.status(404).json({ error: 'poll not found' });
  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(poll.message_id);
  if (!message) return res.status(404).json({ error: 'poll not found' });
  req.poll = poll;
  req.pollMessage = message;
  next();
}

router.put('/:pollId/vote/:optionId', loadPoll, (req, res) => {
  const option = db.prepare('SELECT * FROM poll_options WHERE id = ? AND poll_id = ?').get(req.params.optionId, req.poll.id);
  if (!option) return res.status(404).json({ error: 'option not found' });

  // Voting only requires seeing the poll, same as reacting — not SEND_MESSAGES (a readonly/
  // announcement channel's members can still vote on a mod's poll there).
  const access = canViewScope(req.pollMessage.scope_type, req.pollMessage.scope_id, req.user.id);
  if (!access.ok) return res.status(access.status).json({ error: access.error });
  if (access.ctx.channel) {
    const timeoutUntil = getMemberTimeout(access.ctx.channel.server_id, req.user.id);
    if (timeoutUntil) return res.status(403).json({ error: 'you are timed out in this server', timeoutUntil });
  }

  if (!req.poll.multi_select) {
    db.prepare('DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?').run(req.poll.id, req.user.id);
  }
  db.prepare('INSERT OR IGNORE INTO poll_votes (poll_id, option_id, user_id) VALUES (?, ?, ?)').run(req.poll.id, option.id, req.user.id);

  const updated = serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(req.pollMessage.id));
  access.ctx.broadcast({ type: 'message_update', message: updated });
  res.json({ message: updated });
});

router.delete('/:pollId/vote/:optionId', loadPoll, (req, res) => {
  const option = db.prepare('SELECT * FROM poll_options WHERE id = ? AND poll_id = ?').get(req.params.optionId, req.poll.id);
  if (!option) return res.status(404).json({ error: 'option not found' });

  const access = canViewScope(req.pollMessage.scope_type, req.pollMessage.scope_id, req.user.id);
  if (!access.ok) return res.status(access.status).json({ error: access.error });

  db.prepare('DELETE FROM poll_votes WHERE poll_id = ? AND option_id = ? AND user_id = ?').run(req.poll.id, option.id, req.user.id);

  const updated = serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(req.pollMessage.id));
  access.ctx.broadcast({ type: 'message_update', message: updated });
  res.json({ message: updated });
});

module.exports = router;
