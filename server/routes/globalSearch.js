'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { PERMISSIONS, has } = require('../lib/permissions');
const { getChannelPermissionBits } = require('../lib/channelAccess');
const { searchMessages } = require('../lib/search');

const router = express.Router();

// The activity panel's search bar — scoped to one server (every channel and thread in it the
// requester can view), never DMs or other servers. `serverId` is required: the client sends
// whichever server the user was last looking at, since Home/Friends have no server of their own.
router.get('/', requireAuth, (req, res) => {
  const q = String(req.query.q || '');
  const limit = req.query.limit;
  const serverId = Number(req.query.serverId);
  if (!Number.isInteger(serverId)) return res.status(400).json({ error: 'serverId required' });

  const isMember = db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(serverId, req.user.id);
  if (!isMember) return res.status(403).json({ error: 'not a member of that server' });

  const visibleChannels = db.prepare('SELECT * FROM channels WHERE server_id = ?').all(serverId)
    .filter((ch) => has(getChannelPermissionBits(ch, req.user.id), PERMISSIONS.VIEW_CHANNEL))
    .filter((ch) => !nsfwBlock(ch, req.user.id));
  const channelIds = visibleChannels.map((ch) => ch.id);
  const channelNameById = new Map(visibleChannels.map((ch) => [ch.id, ch.name]));

  const threadRows = channelIds.length
    ? db.prepare(`SELECT id, channel_id FROM threads WHERE channel_id IN (${channelIds.map(() => '?').join(',')})`).all(...channelIds)
    : [];
  const threadChannelById = new Map(threadRows.map((t) => [t.id, t.channel_id]));

  const messages = [
    ...searchMessages('channel', channelIds, q, { limit }).map((m) => ({ ...m, channelId: m.scopeId, serverId, channelName: channelNameById.get(m.scopeId) })),
    ...searchMessages('thread', [...threadChannelById.keys()], q, { limit }).map((m) => {
      const channelId = threadChannelById.get(m.scopeId);
      return { ...m, channelId, serverId, channelName: channelNameById.get(channelId) };
    }),
  ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, Math.min(Number(limit) || 20, 50));

  res.json({ messages });
});

module.exports = router;
