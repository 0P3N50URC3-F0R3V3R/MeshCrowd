'use strict';

const express = require('express');
const { db } = require('../db');
const botStore = require('../lib/ai/botStore');
const { tokenFromHeader } = require('../lib/bots/tokens');
const { postAsBot, editOwnMessage, deleteOwnMessage, BotPostError } = require('../lib/bots/post');
const { listMessages } = require('../lib/messages');
const { canViewScope } = require('../lib/scopeAccess');
const { getChannelPermissionBits } = require('../lib/channelAccess');
const { PERMISSIONS, has } = require('../lib/permissions');
const commands = require('../lib/bots/commands');
const { notifyUserIds } = require('../socket/hub');
const crypto = require('node:crypto');
const { maxMessageChars } = require('../lib/messageLimits');

const router = express.Router();

// Sliding-window limiter keyed by bot (not by IP: a workflow tool shares one address with many bots).
function botLimiter({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [k, times] of hits) {
      const kept = times.filter((t) => t > cutoff);
      if (kept.length) hits.set(k, kept); else hits.delete(k);
    }
  }, windowMs).unref();
  return (req, res, next) => {
    const now = Date.now();
    const times = (hits.get(req.bot.id) || []).filter((t) => t > now - windowMs);
    if (times.length >= max) {
      res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({ error: 'rate limit exceeded' });
    }
    times.push(now);
    hits.set(req.bot.id, times);
    next();
  };
}

function botAuth(req, res, next) {
  const token = tokenFromHeader(req.get('authorization'));
  const bot = token ? botStore.findBotByToken(token) : null;
  if (!bot) {
    res.set('WWW-Authenticate', 'Bot');
    return res.status(401).json({ error: 'missing or invalid bot token' });
  }
  req.bot = bot;
  next();
}

const anyLimit = botLimiter({ windowMs: 60_000, max: 120 });
const writeLimit = botLimiter({ windowMs: 60_000, max: 30 });

router.use(botAuth, anyLimit);

const fail = (res, err) => {
  if (err instanceof BotPostError || err instanceof commands.CommandError) return res.status(err.status).json({ error: err.message });
  throw err;
};

router.get('/me', (req, res) => {
  const b = botStore.publicBot(req.bot);
  res.json({
    bot: {
      id: b.id,
      userId: b.userId,
      username: b.user.username,
      displayName: b.user.displayName,
      serverId: b.serverId,
      serverName: b.serverName,
      hasAi: b.hasAi,
      dmEnabled: b.dmEnabled,
      webhook: { enabled: b.webhook.enabled, scope: b.webhook.scope },
    },
  });
});

// The channels this bot can see (the same permission engine as for any member).
router.get('/channels', (req, res) => {
  const channels = db.prepare("SELECT * FROM channels WHERE server_id = ? AND type != 'notes' ORDER BY position ASC, id ASC").all(req.bot.server_id)
    .filter((c) => has(getChannelPermissionBits(c, req.bot.user_id), PERMISSIONS.VIEW_CHANNEL))
    .map((c) => ({ id: c.id, name: c.name, type: c.type, topic: c.topic }));
  res.json({ channels });
});

function checkDm(bot, ctx, res) {
  if (!ctx.dm) return true;
  if (ctx.dm.is_group || ctx.dm.e2ee_enabled || !bot.dm_enabled) {
    res.status(403).json({ error: 'this conversation does not accept bot access' });
    return false;
  }
  return true;
}

router.get('/messages', (req, res) => {
  const scopeType = String(req.query.scopeType || '');
  const scopeId = Number(req.query.scopeId);
  if (!['channel', 'thread', 'dm'].includes(scopeType) || !Number.isInteger(scopeId)) {
    return res.status(400).json({ error: 'scopeType (channel, thread or dm) and scopeId are required' });
  }
  const access = canViewScope(scopeType, scopeId, req.bot.user_id);
  if (!access.ok) return res.status(access.status).json({ error: access.error });
  if (access.ctx.channel && (access.ctx.channel.server_id !== req.bot.server_id || access.ctx.channel.type === 'notes')) {
    return res.status(403).json({ error: 'cannot view this' });
  }
  if (!checkDm(req.bot, access.ctx, res)) return;
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  res.json({ messages: listMessages(scopeType, scopeId, { before: req.query.before, limit }) });
});

router.post('/messages', writeLimit, (req, res) => {
  const b = req.body || {};
  try {
    const message = postAsBot(req.bot, { scopeType: b.scopeType, scopeId: Number(b.scopeId), content: b.content, replyToMessageId: b.replyToMessageId });
    res.status(201).json({ message });
  } catch (err) { fail(res, err); }
});

router.patch('/messages/:id', writeLimit, (req, res) => {
  try { res.json({ message: editOwnMessage(req.bot, Number(req.params.id), req.body?.content) }); } catch (err) { fail(res, err); }
});

router.delete('/messages/:id', writeLimit, (req, res) => {
  try { deleteOwnMessage(req.bot, Number(req.params.id)); res.json({ ok: true }); } catch (err) { fail(res, err); }
});

// Slash commands: the bot publishes its full list (replacing the previous one) ...
router.get('/commands', (req, res) => res.json({ commands: commands.listBotCommands(req.bot.id) }));

router.put('/commands', writeLimit, (req, res) => {
  try { res.json({ commands: commands.setCommands(req.bot.id, req.body?.commands) }); } catch (err) { fail(res, err); }
});

// ... and answers each use of one. A normal answer is posted as the bot; an ephemeral one goes to the
// user who ran the command only and is never stored.
router.post('/interactions/:id/respond', writeLimit, (req, res) => {
  const b = req.body || {};
  try {
    const row = commands.claimResponse(req.bot.id, req.params.id);
    if (b.ephemeral === true) {
      if (typeof b.content !== 'string' || !b.content.trim() || b.content.length > maxMessageChars()) throw new BotPostError(400, `content is required (at most ${maxMessageChars()} characters)`);
      const bot = botStore.publicBot(req.bot);
      const ephemeral = {
        id: crypto.randomBytes(8).toString('hex'),
        scopeType: row.scope_type,
        scopeId: row.scope_id,
        content: b.content,
        command: row.command,
        bot: { id: bot.userId, username: bot.user.username, displayName: bot.user.displayName, avatarPath: bot.user.avatarPath || null },
        createdAt: new Date().toISOString(),
      };
      notifyUserIds([row.user_id], { type: 'ephemeral_message', message: ephemeral });
      return res.status(201).json({ ephemeral: true, id: ephemeral.id });
    }
    const message = postAsBot(req.bot, { scopeType: row.scope_type, scopeId: row.scope_id, content: b.content, interaction: { command: row.command, userId: row.user_id } });
    res.status(201).json({ message });
  } catch (err) { fail(res, err); }
});

module.exports = router;
