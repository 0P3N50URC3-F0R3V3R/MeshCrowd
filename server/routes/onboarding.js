'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { PERMISSIONS, has } = require('../lib/permissions');
const { getMemberPermissionBits, isPendingMember } = require('../lib/channelAccess');
const { logAudit } = require('../lib/auditLog');
const { broadcastToServer } = require('../socket/hub');
const onboarding = require('../lib/onboarding');

const router = express.Router({ mergeParams: true });

function loadServer(req, res, next) {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(Number(req.params.id));
  if (!server || server.kind !== 'chat') return res.status(404).json({ error: 'server not found' });
  if (!db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(server.id, req.user.id)) return res.status(403).json({ error: 'not a member of this server' });
  req.server = server;
  req.canManage = server.owner_id === req.user.id || has(getMemberPermissionBits(server.id, req.user.id), PERMISSIONS.MANAGE_SERVER);
  next();
}

const guard = (fn) => (req, res, next) => {
  try { fn(req, res, next); } catch (err) {
    if (err instanceof onboarding.OnboardingError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
};

router.use(requireAuth, loadServer);

router.get('/', guard((req, res) => {
  const pending = isPendingMember(req.server.id, req.user.id);
  const out = { enabled: !!req.server.screening_enabled, pending, canManage: req.canManage };
  if (req.canManage) out.config = onboarding.getConfig(req.server.id);
  else if (out.enabled) Object.assign(out, onboarding.publicConfig(req.server.id));
  res.json(out);
}));

router.put('/', guard((req, res) => {
  if (!req.canManage) return res.status(403).json({ error: 'missing permission' });
  const config = onboarding.saveConfig(req.server.id, req.body);
  logAudit(req.server.id, req.user.id, 'onboarding_update', 'server', req.server.id, { enabled: config.enabled, questions: config.questions.length });
  res.json({ config });
}));

router.post('/accept', guard((req, res) => {
  const pending = isPendingMember(req.server.id, req.user.id);
  if (!pending) return res.json({ ok: true, roleIds: [] });
  const roleIds = onboarding.accept(req.server.id, req.user.id, req.body?.answers);
  if (roleIds.length) broadcastToServer(req.server.id, { type: 'member_role_update', userId: req.user.id, serverId: req.server.id });
  res.json({ ok: true, roleIds });
}));

module.exports = router;
