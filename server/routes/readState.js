'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { has, PERMISSIONS } = require('../lib/permissions');
const { getChannelPermissionBits } = require('../lib/channelAccess');
const { broadcastToDm } = require('../socket/hub');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT scope_type, scope_id, last_read_message_id FROM read_state WHERE user_id = ?').all(req.user.id);
  res.json({ state: rows.map((r) => ({ scopeType: r.scope_type, scopeId: r.scope_id, lastReadMessageId: r.last_read_message_id })) });
});

router.put('/:scopeType/:scopeId', (req, res) => {
  const { scopeType } = req.params;
  const scopeId = Number(req.params.scopeId);
  const messageId = Number(req.body?.messageId);
  if (!['channel', 'dm'].includes(scopeType) || !Number.isInteger(scopeId) || !Number.isInteger(messageId) || messageId < 0) {
    return res.status(400).json({ error: 'invalid read-state update' });
  }

  if (scopeType === 'channel') {
    const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(scopeId);
    if (!channel || !has(getChannelPermissionBits(channel, req.user.id), PERMISSIONS.VIEW_CHANNEL)) {
      return res.status(403).json({ error: 'no access to this channel' });
    }
  } else {
    const member = db.prepare('SELECT 1 FROM dm_members WHERE dm_channel_id = ? AND user_id = ?').get(scopeId, req.user.id);
    if (!member) return res.status(403).json({ error: 'not a member of this conversation' });
  }

  // `force` lets "mark as unread" move the pointer backwards; everything else only advances it.
  const force = req.body?.force === true;
  db.prepare(
    `INSERT INTO read_state (user_id, scope_type, scope_id, last_read_message_id, updated_at)
     VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(user_id, scope_type, scope_id) DO UPDATE SET
       last_read_message_id = CASE WHEN ? THEN excluded.last_read_message_id ELSE MAX(last_read_message_id, excluded.last_read_message_id) END,
       updated_at = excluded.updated_at`
  ).run(req.user.id, scopeType, scopeId, messageId, force ? 1 : 0);

  // Lets the other side of a DM show a live "Seen" marker — channels don't get this broadcast,
  // there's no per-message "seen by" concept for a multi-member room, just each viewer's own
  // unread state (which they already have locally the moment they open the channel).
  if (scopeType === 'dm') {
    broadcastToDm(scopeId, { type: 'dm_read', dmId: scopeId, userId: req.user.id, messageId });
  }
  res.json({ ok: true });
});

module.exports = router;
