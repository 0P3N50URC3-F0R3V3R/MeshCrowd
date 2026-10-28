'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { PERMISSIONS, has } = require('../lib/permissions');
const { getMemberPermissionBits } = require('../lib/channelAccess');
const { logAudit } = require('../lib/auditLog');
const invites = require('../lib/serverInvites');

const router = express.Router({ mergeParams: true });

function loadServer(req, res, next) {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(Number(req.params.id));
  if (!server || server.kind !== 'chat') return res.status(404).json({ error: 'server not found' });
  const member = db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(server.id, req.user.id);
  if (!member) return res.status(403).json({ error: 'not a member of this server' });
  const bits = getMemberPermissionBits(server.id, req.user.id);
  req.server = server;
  req.canManage = has(bits, PERMISSIONS.MANAGE_SERVER);
  req.canCreate = has(bits, PERMISSIONS.CREATE_INVITE);
  next();
}

const guard = (fn) => (req, res, next) => {
  try { fn(req, res, next); } catch (err) {
    if (err instanceof invites.InviteError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
};

router.use(requireAuth, loadServer);

router.get('/', guard((req, res) => {
  if (!req.canCreate && !req.canManage) return res.status(403).json({ error: 'missing permission' });
  res.json({
    invites: invites.listInvites(req.server.id, { userId: req.user.id, all: req.canManage }),
    vanityCode: req.server.vanity_code || null,
    canManage: req.canManage,
  });
}));

router.post('/', guard((req, res) => {
  if (!req.canCreate && !req.canManage) return res.status(403).json({ error: 'missing permission' });
  const invite = invites.createInvite({ serverId: req.server.id, userId: req.user.id, maxUses: req.body?.maxUses, expiresInSeconds: req.body?.expiresInSeconds });
  logAudit(req.server.id, req.user.id, 'invite_create', 'invite', invite.id, { maxUses: invite.max_uses, expiresAt: invite.expires_at });
  res.status(201).json({ invite: invites.shape(invite) });
}));

router.delete('/:inviteId', guard((req, res) => {
  const row = invites.revokeInvite(req.server.id, Number(req.params.inviteId), { userId: req.user.id, canManage: req.canManage });
  logAudit(req.server.id, req.user.id, 'invite_revoke', 'invite', row.id, { code: row.code });
  res.json({ ok: true });
}));

router.put('/vanity', guard((req, res) => {
  if (!req.canManage) return res.status(403).json({ error: 'missing permission' });
  const code = invites.setVanity(req.server.id, req.body?.code);
  logAudit(req.server.id, req.user.id, 'vanity_set', 'server', req.server.id, { code });
  res.json({ vanityCode: code });
}));

module.exports = router;
