'use strict';

const express = require('express');
const crypto = require('node:crypto');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { PERMISSIONS, has } = require('../lib/permissions');
const { getChannelPermissionBits } = require('../lib/channelAccess');
const { toPublicUser } = require('../lib/publicUser');
const { broadcastToServer, notifyUser } = require('../socket/hub');
const { postServerEvent } = require('../lib/systemMessages');

const router = express.Router({ mergeParams: true });

function loadChannel(req, res, next) {
  const channel = db.prepare('SELECT * FROM channels WHERE id = ? AND server_id = ?').get(req.params.channelId, req.params.id);
  if (!channel) return res.status(404).json({ error: 'channel not found' });
  const isMember = db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(channel.server_id, req.user.id);
  if (!isMember) return res.status(403).json({ error: 'not a member of this server' });
  req.channel = channel;
  next();
}

// Managing a channel's invites lives behind the same permission as managing the channel itself
// (matches where the UI surfaces it, in channel settings) rather than the lighter CREATE_INVITE
// used for the server-wide code — a channel invite is effectively a targeted access grant.
function requireManage(req, res, next) {
  if (!has(getChannelPermissionBits(req.channel, req.user.id), PERMISSIONS.MANAGE_CHANNELS)) {
    return res.status(403).json({ error: 'missing permission' });
  }
  next();
}

router.use(requireAuth, loadChannel, requireManage);

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM channel_invites WHERE channel_id = ? ORDER BY id DESC').all(req.channel.id);
  res.json({ invites: rows.map(shape) });
});

router.post('/', (req, res) => {
  const maxUses = req.body?.maxUses === undefined || req.body.maxUses === null ? null : Number(req.body.maxUses);
  const expiresInHours = req.body?.expiresInHours === undefined || req.body.expiresInHours === null ? null : Number(req.body.expiresInHours);
  if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1)) return res.status(400).json({ error: 'invalid maxUses' });
  if (expiresInHours !== null && (!Number.isFinite(expiresInHours) || expiresInHours <= 0)) return res.status(400).json({ error: 'invalid expiresInHours' });

  const code = crypto.randomBytes(6).toString('hex');
  const expiresAt = expiresInHours !== null ? new Date(Date.now() + expiresInHours * 3600_000).toISOString() : null;
  const info = db.prepare('INSERT INTO channel_invites (channel_id, code, created_by, max_uses, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(req.channel.id, code, req.user.id, maxUses, expiresAt);
  res.status(201).json({ invite: shape(db.prepare('SELECT * FROM channel_invites WHERE id = ?').get(info.lastInsertRowid)) });
});

// One-click invite: grants a specific user access immediately instead of making them redeem a
// code. Same underlying grant as POST /api/servers/channel-invites/:code/join (join the server
// if needed, then a channel_user_overrides VIEW_CHANNEL row) — this just skips the code step
// since the inviter already has permission to manage this channel.
router.post('/direct', (req, res) => {
  const targetId = Number(req.body?.userId);
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  if (!target || target.is_bot) return res.status(404).json({ error: 'user not found' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'cannot invite yourself' });

  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.channel.server_id);
  const banned = db.prepare('SELECT 1 FROM server_bans WHERE server_id = ? AND user_id = ?').get(server.id, target.id);
  if (banned) return res.status(403).json({ error: 'this user is banned from the server' });

  const alreadyMember = db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(server.id, target.id);
  if (!alreadyMember) {
    db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(server.id, target.id);
    broadcastToServer(server.id, { type: 'member_join', serverId: server.id, user: toPublicUser(target, {}) });
    postServerEvent(server.id, 'member_join', target.id);
  }

  db.prepare(
    `INSERT INTO channel_user_overrides (channel_id, user_id, allow, deny) VALUES (?, ?, ?, 0)
     ON CONFLICT(channel_id, user_id) DO UPDATE SET allow = allow | excluded.allow`
  ).run(req.channel.id, target.id, PERMISSIONS.VIEW_CHANNEL);

  notifyUser(target.id, {
    type: 'channel_invite_received',
    server: { id: server.id, name: server.name },
    channelId: req.channel.id,
    channelName: req.channel.name,
    invitedBy: toPublicUser(req.user, {}),
  });
  res.json({ ok: true });
});

router.delete('/:inviteId', (req, res) => {
  const invite = db.prepare('SELECT * FROM channel_invites WHERE id = ? AND channel_id = ?').get(req.params.inviteId, req.channel.id);
  if (!invite) return res.status(404).json({ error: 'invite not found' });
  db.prepare('DELETE FROM channel_invites WHERE id = ?').run(invite.id);
  res.json({ ok: true });
});

function shape(row) {
  return { id: row.id, code: row.code, maxUses: row.max_uses, uses: row.uses, expiresAt: row.expires_at, createdAt: row.created_at };
}

module.exports = router;
