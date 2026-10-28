'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { PERMISSIONS, SITE_PERMISSIONS, has, hasSite } = require('../lib/permissions');
const { getMemberPermissionBits } = require('../lib/channelAccess');
const { AiError } = require('../lib/ai/errors');
const botStore = require('../lib/ai/botStore');
const providerStore = require('../lib/ai/providerStore');
const { mountBotCredentialRoutes } = require('./botCredentialRoutes');

const router = express.Router({ mergeParams: true });

function loadServer(req, res, next) {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(Number(req.params.id));
  if (!server) return res.status(404).json({ error: 'server not found' });
  if (server.kind !== 'chat') return res.status(404).json({ error: 'not available for sites' });
  const bits = req.sitePermissions || 0;
  req.siteAuthority = hasSite(bits, SITE_PERMISSIONS.MANAGE_AI);
  const member = db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(server.id, req.user.id);
  const canManage = req.siteAuthority
    || hasSite(bits, SITE_PERMISSIONS.MANAGE_ANY_SERVER)
    || (!!member && has(getMemberPermissionBits(server.id, req.user.id), PERMISSIONS.MANAGE_BOTS));
  if (!canManage) return res.status(403).json({ error: member ? 'missing permission' : 'not a member of this server' });
  req.server = server;
  next();
}

function loadBot(req, res, next) {
  const bot = botStore.getBotRow(Number(req.params.botId));
  if (!bot || bot.server_id !== req.server.id) return res.status(404).json({ error: 'bot not found' });
  req.bot = bot;
  next();
}

const guard = (fn) => async (req, res, next) => {
  try { await fn(req, res, next); } catch (err) {
    if (err instanceof AiError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
};

const auth = [requireAuth, loadServer];

router.get('/ai/providers', auth, (req, res) => {
  const rows = providerStore.listRows().filter((p) => p.enabled && (req.siteAuthority || p.server_admin_usable));
  res.json({ providers: rows.map(providerStore.serverShape) });
});

router.get('/bots', auth, (req, res) => {
  res.json({ bots: botStore.listBots(req.server.id) });
});

router.post('/bots', auth, guard((req, res) => {
  const bot = botStore.createBot({ serverId: req.server.id, actorId: req.user.id, body: req.body, siteAuthority: req.siteAuthority });
  res.status(201).json({ bot });
}));

router.patch('/bots/:botId', auth, loadBot, guard((req, res) => {
  res.json({ bot: botStore.updateBot(req.bot.id, { actorId: req.user.id, body: req.body, siteAuthority: req.siteAuthority }) });
}));

router.delete('/bots/:botId', auth, loadBot, guard((req, res) => {
  botStore.deleteBot(req.bot.id, req.user.id);
  res.json({ ok: true });
}));

router.post('/bots/:botId/avatar', auth, loadBot, botStore.uploadBotAvatar.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'avatar file required (png/jpg/gif/webp, max 5MB)' });
  res.json({ bot: botStore.setBotAvatar(req.bot, req.file) });
});

mountBotCredentialRoutes(router, [auth, loadBot]);

module.exports = router;
