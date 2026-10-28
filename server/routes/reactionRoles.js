'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { PERMISSIONS, has } = require('../lib/permissions');
const { getMemberPermissionBits } = require('../lib/channelAccess');
const { logAudit } = require('../lib/auditLog');
const reactionRoles = require('../lib/reactionRoles');

const router = express.Router({ mergeParams: true });

function loadServer(req, res, next) {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(Number(req.params.id));
  if (!server || server.kind !== 'chat') return res.status(404).json({ error: 'server not found' });
  if (!db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(server.id, req.user.id)) return res.status(403).json({ error: 'not a member of this server' });
  if (!has(getMemberPermissionBits(server.id, req.user.id), PERMISSIONS.MANAGE_ROLES)) return res.status(403).json({ error: 'missing permission' });
  req.server = server;
  next();
}

const guard = (fn) => (req, res, next) => {
  try { fn(req, res, next); } catch (err) {
    if (err instanceof reactionRoles.ReactionRoleError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
};

router.use(requireAuth, loadServer);

router.get('/', guard((req, res) => res.json({ reactionRoles: reactionRoles.list(req.server.id) })));

router.post('/', guard((req, res) => {
  const b = req.body || {};
  const created = reactionRoles.create({ serverId: req.server.id, userId: req.user.id, channelId: b.channelId, messageId: b.messageId, emoji: b.emoji, roleId: b.roleId, exclusive: !!b.exclusive });
  logAudit(req.server.id, req.user.id, 'reaction_role_create', 'reaction_role', created.id, { emoji: created.emoji, role: created.roleName });
  res.status(201).json({ reactionRole: created });
}));

router.delete('/:id', guard((req, res) => {
  reactionRoles.remove(req.server.id, Number(req.params.id));
  logAudit(req.server.id, req.user.id, 'reaction_role_delete', 'reaction_role', Number(req.params.id), null);
  res.json({ ok: true });
}));

module.exports = router;
