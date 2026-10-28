'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { hasSite, SITE_PERMISSIONS } = require('../lib/permissions');
const { AiError } = require('../lib/ai/errors');
const store = require('../lib/ai/providerStore');
const providers = require('../lib/ai/providers');
const secretBox = require('../lib/ai/secretBox');
const { validateBaseUrl } = require('../lib/ai/http');
const { db } = require('../db');
const botStore = require('../lib/ai/botStore');
const { mountBotCredentialRoutes } = require('./botCredentialRoutes');

const router = express.Router();

function requireAi(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'not authenticated' });
  if (!hasSite(req.sitePermissions || 0, SITE_PERMISSIONS.MANAGE_AI)) return res.status(403).json({ error: 'missing site permission' });
  next();
}

const guard = (fn) => async (req, res, next) => {
  try { await fn(req, res, next); } catch (err) {
    if (err instanceof AiError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
};

router.use(requireAuth, requireAi);

router.get('/providers', (req, res) => {
  res.json({ providers: store.listRows().map(store.adminShape) });
});

router.post('/providers', guard((req, res) => {
  res.status(201).json({ provider: store.adminShape(store.createProvider(req.body)) });
}));

router.post('/providers/test', guard(async (req, res) => {
  const { providerId, kind, baseUrl, apiKey } = req.body || {};
  if (kind !== 'ollama' && kind !== 'openai') throw new AiError(400, 'kind must be ollama or openai');
  let url;
  try { url = validateBaseUrl(baseUrl); } catch (err) { throw new AiError(400, err.message); }
  let keyEnc = null;
  if (typeof apiKey === 'string' && apiKey) keyEnc = secretBox.encrypt(apiKey);
  else if (apiKey === undefined && providerId !== undefined) keyEnc = store.getRow(Number(providerId))?.api_key_enc || null;
  const probe = { kind, base_url: url, api_key_enc: keyEnc, timeout_s: 10, scope: 'site' };
  const started = Date.now();
  try {
    const models = await providers.listModels(probe);
    res.json({ ok: true, models, latencyMs: Date.now() - started });
  } catch (err) {
    res.json({ ok: false, error: err.message, latencyMs: Date.now() - started });
  }
}));

router.patch('/providers/:id', guard((req, res) => {
  res.json({ provider: store.adminShape(store.updateProvider(Number(req.params.id), req.body)) });
}));

router.delete('/providers/:id', guard((req, res) => {
  store.deleteProvider(Number(req.params.id));
  res.json({ ok: true });
}));

router.get('/servers', (req, res) => {
  const rows = db.prepare("SELECT id, name FROM servers WHERE kind = 'chat' ORDER BY name COLLATE NOCASE ASC").all();
  res.json({ servers: rows });
});

router.get('/bots', (req, res) => {
  res.json({ bots: botStore.listBots() });
});

router.post('/bots', guard((req, res) => {
  const serverId = Number(req.body?.serverId);
  if (!Number.isInteger(serverId) || !db.prepare('SELECT 1 FROM servers WHERE id = ?').get(serverId)) throw new AiError(404, 'server not found');
  res.status(201).json({ bot: botStore.createBot({ serverId, actorId: req.user.id, body: req.body, siteAuthority: true }) });
}));

const loadAdminBot = (req, res, next) => {
  const bot = botStore.getBotRow(Number(req.params.botId));
  if (!bot) return res.status(404).json({ error: 'bot not found' });
  req.bot = bot;
  next();
};

router.patch('/bots/:botId', loadAdminBot, guard((req, res) => {
  res.json({ bot: botStore.updateBot(req.bot.id, { actorId: req.user.id, body: req.body, siteAuthority: true }) });
}));

router.delete('/bots/:botId', loadAdminBot, guard((req, res) => {
  botStore.deleteBot(req.bot.id, req.user.id);
  res.json({ ok: true });
}));

router.post('/bots/:botId/avatar', loadAdminBot, botStore.uploadBotAvatar.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'avatar file required (png/jpg/gif/webp, max 5MB)' });
  res.json({ bot: botStore.setBotAvatar(req.bot, req.file) });
});

mountBotCredentialRoutes(router, [loadAdminBot]);

module.exports = router;
