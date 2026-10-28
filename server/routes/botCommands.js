'use strict';

const express = require('express');
const { rateLimit } = require('../middleware/rateLimit');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { canSendToScope } = require('../lib/scopeAccess');
const { nsfwBlock } = require('../lib/ageGate');
const { verificationBlock } = require('../lib/verification');
const commands = require('../lib/bots/commands');
const webhooks = require('../lib/bots/webhooks');

const router = express.Router({ mergeParams: true });

function loadServer(req, res, next) {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(Number(req.params.id));
  if (!server || server.kind !== 'chat') return res.status(404).json({ error: 'server not found' });
  if (!db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(server.id, req.user.id)) return res.status(403).json({ error: 'not a member of this server' });
  req.server = server;
  next();
}

router.use(requireAuth, loadServer);

router.get('/', (req, res) => res.json({ commands: commands.listServerCommands(req.server.id) }));

router.post('/invoke', rateLimit({ windowMs: 10_000, max: 10 }), (req, res) => {
  const b = req.body || {};
  try {
    const channelId = Number(b.channelId);
    const botId = Number(b.botId);
    const name = typeof b.command === 'string' ? b.command.toLowerCase() : '';
    const channel = Number.isInteger(channelId) ? db.prepare('SELECT * FROM channels WHERE id = ? AND server_id = ?').get(channelId, req.server.id) : null;
    if (!channel || channel.type === 'notes' || channel.type === 'forum') throw new commands.CommandError(400, 'pick a text channel');
    const access = canSendToScope('channel', channel.id, req.user.id);
    if (!access.ok) throw new commands.CommandError(access.status, access.error);
    const gate = nsfwBlock(channel, req.user.id) || verificationBlock(req.server.id, req.user.id);
    if (gate) throw new commands.CommandError(gate.status, gate.body.error);

    const available = commands.listServerCommands(req.server.id).find((c) => c.botId === botId && c.name === name);
    if (!available) throw new commands.CommandError(404, 'command not found');
    const options = commands.coerceOptions(available, b.options);
    const bot = db.prepare('SELECT * FROM bots WHERE id = ?').get(botId);

    const interaction = commands.createInteraction({ botId, userId: req.user.id, scopeType: 'channel', scopeId: channel.id, command: name });
    webhooks.enqueue(botId, {
      type: 'command',
      bot: { id: bot.id, userId: bot.user_id, username: available.botUsername },
      server: { id: req.server.id, name: req.server.name },
      channel: { id: channel.id, name: channel.name, type: channel.type },
      user: { id: req.user.id, username: req.user.username, displayName: req.user.display_name || req.user.username },
      command: name,
      options,
      interaction: { id: interaction.id, expiresAt: interaction.expiresAt },
    });
    res.status(202).json({ interactionId: interaction.id, expiresAt: interaction.expiresAt });
  } catch (err) {
    if (err instanceof commands.CommandError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

module.exports = router;
