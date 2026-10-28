'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { LEVELS, FOREVER, listServerPrefs, setServerPref } = require('../lib/serverPrefs');

const router = express.Router();
router.use(requireAuth);

const MAX_MUTE_MS = 366 * 24 * 3600 * 1000;

router.get('/', (req, res) => {
  res.json({ prefs: listServerPrefs(req.user.id) });
});

// Body: any of notifLevel ('all'|'mentions'|'mute'|null), mute ({ minutes } | { forever: true } |
// null to unmute), hideMutedChannels, showAllChannels, allowDms.
router.put('/:serverId', (req, res) => {
  const serverId = Number(req.params.serverId);
  if (!Number.isInteger(serverId)) return res.status(400).json({ error: 'invalid server id' });
  if (!db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(serverId, req.user.id)) {
    return res.status(403).json({ error: 'not a member of this server' });
  }
  const b = req.body || {};
  const patch = {};
  if ('notifLevel' in b) {
    if (b.notifLevel !== null && !LEVELS.has(b.notifLevel)) return res.status(400).json({ error: 'notifLevel must be all|mentions|mute or null' });
    patch.notifLevel = b.notifLevel;
  }
  if ('mute' in b) {
    if (b.mute === null) patch.mutedUntil = null;
    else if (b.mute && b.mute.forever === true) patch.mutedUntil = FOREVER;
    else if (b.mute && Number.isFinite(b.mute.minutes) && b.mute.minutes > 0) {
      patch.mutedUntil = new Date(Date.now() + Math.min(b.mute.minutes * 60_000, MAX_MUTE_MS)).toISOString();
    } else return res.status(400).json({ error: 'mute must be null, { forever: true } or { minutes }' });
  }
  for (const key of ['hideMutedChannels', 'showAllChannels', 'allowDms']) {
    if (key in b) {
      if (typeof b[key] !== 'boolean') return res.status(400).json({ error: `${key} must be a boolean` });
      patch[key] = b[key];
    }
  }
  res.json({ pref: setServerPref(req.user.id, serverId, patch) });
});

module.exports = router;
