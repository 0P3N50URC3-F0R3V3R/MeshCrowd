'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { PERMISSIONS, has } = require('../lib/permissions');
const { getMemberPermissionBits } = require('../lib/channelAccess');
const insights = require('../lib/insights');

const router = express.Router({ mergeParams: true });

router.use(requireAuth, (req, res, next) => {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(Number(req.params.id));
  if (!server || server.kind !== 'chat') return res.status(404).json({ error: 'server not found' });
  if (!db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(server.id, req.user.id)) return res.status(403).json({ error: 'not a member of this server' });
  if (!has(getMemberPermissionBits(server.id, req.user.id), PERMISSIONS.MANAGE_SERVER)) return res.status(403).json({ error: 'missing permission' });
  req.server = server;
  next();
});

router.get('/', (req, res) => {
  res.json({ insights: insights.getInsights(req.server.id, Number(req.query.days) || 30) });
});

module.exports = router;
