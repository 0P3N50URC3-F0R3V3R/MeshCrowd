'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const MAX_EVIDENCE_CHARS = 4000;
const REASONS = new Set(['spam', 'harassment', 'other']);

// Anyone can file a report about anyone else — filing one doesn't require any shared server/DM,
// same as Discord (reporting works even after you've blocked someone or left the server together).
router.post('/', requireAuth, (req, res) => {
  const reportedUserId = Number(req.body?.reportedUserId);
  const reason = String(req.body?.reason || '');
  // Rendered as a block of text in the admin queue (not inline), so unlike singleLine() fields
  // this keeps newlines — same treatment as message content, just capped and trimmed.
  const details = String(req.body?.details || '').trim().slice(0, 500);
  const messageId = req.body?.messageId !== undefined && req.body?.messageId !== null ? Number(req.body.messageId) : null;

  if (!Number.isInteger(reportedUserId)) return res.status(400).json({ error: 'reportedUserId required' });
  if (reportedUserId === req.user.id) return res.status(400).json({ error: 'cannot report yourself' });
  if (!REASONS.has(reason)) return res.status(400).json({ error: 'reason must be one of spam|harassment|other' });
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(reportedUserId);
  if (!target) return res.status(404).json({ error: 'user not found' });

  let validMessageId = null;
  let evidence = null;
  if (messageId !== null) {
    const message = db.prepare('SELECT id, scope_type, scope_id, is_encrypted FROM messages WHERE id = ? AND author_id = ?').get(messageId, reportedUserId);
    if (message) validMessageId = message.id; // silently drop a stale/mismatched message reference rather than error
    // Only a participant can have read the message, so only a participant's disclosure counts as evidence.
    const raw = req.body?.plaintextEvidence;
    if (message?.is_encrypted && typeof raw === 'string' && raw.trim()
      && db.prepare('SELECT 1 FROM dm_members WHERE dm_channel_id = ? AND user_id = ?').get(message.scope_id, req.user.id)) {
      evidence = raw.trim().slice(0, MAX_EVIDENCE_CHARS);
    }
  }

  db.prepare(
    'INSERT INTO reports (reporter_id, reported_user_id, message_id, reason, details, plaintext_evidence) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(req.user.id, reportedUserId, validMessageId, reason, details, evidence);
  res.status(201).json({ ok: true });
});

module.exports = router;
