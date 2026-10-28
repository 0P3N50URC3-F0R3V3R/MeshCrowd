'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { getPref, setPref, VALID_PREFS } = require('../lib/notifications');
const { muteExpiry } = require('../lib/userMeta');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT scope_type, scope_id, pref, muted_until FROM notification_prefs WHERE user_id = ?').all(req.user.id);
  res.json({ prefs: rows.map((r) => ({ scopeType: r.scope_type, scopeId: r.scope_id, pref: r.pref, mutedUntil: r.muted_until })) });
});

router.put('/:scopeType/:scopeId', (req, res) => {
  const { scopeType, scopeId } = req.params;
  const { pref } = req.body || {};
  if (!VALID_PREFS.has(pref)) return res.status(400).json({ error: 'pref must be one of all|mentions|mute' });

  if (scopeType === 'channel') {
    const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(scopeId);
    if (!channel) return res.status(404).json({ error: 'channel not found' });
    const isMember = db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(channel.server_id, req.user.id);
    if (!isMember) return res.status(403).json({ error: 'not a member of this server' });
  } else if (scopeType === 'dm') {
    const isMember = db.prepare('SELECT 1 FROM dm_members WHERE dm_channel_id = ? AND user_id = ?').get(scopeId, req.user.id);
    if (!isMember) return res.status(403).json({ error: 'not a member of this conversation' });
  } else {
    return res.status(400).json({ error: 'scopeType must be channel or dm' });
  }

  const mutedUntil = pref === 'mute' ? muteExpiry(req.body || {}) : null;
  setPref(req.user.id, scopeType, Number(scopeId), pref, mutedUntil);
  res.json({ ok: true, pref: getPref(req.user.id, scopeType, Number(scopeId)), mutedUntil });
});

module.exports = router;
