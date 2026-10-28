'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { pollOutbox } = require('../lib/notifications');

const router = express.Router();
router.use(requireAuth);

// Cursor-based catch-up for clients with no open WebSocket (the Android background checker):
// GET ?since=<lastSeenId> returns everything newer, oldest first, plus latestId to advance the
// cursor even on an empty page.
router.get('/poll', (req, res) => {
  const since = Number(req.query.since);
  const { notifications, latestId } = pollOutbox(req.user.id, Number.isInteger(since) && since >= 0 ? since : 0);
  res.json({ notifications, latestId });
});

module.exports = router;
