'use strict';

const { AiError } = require('../lib/ai/errors');
const botStore = require('../lib/ai/botStore');
const webhooks = require('../lib/bots/webhooks');

const guard = (fn) => async (req, res, next) => {
  try { await fn(req, res, next); } catch (err) {
    if (err instanceof AiError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
};

// API token and webhook credential endpoints, shared by the server-scoped and the admin routers.
// `pre` is the middleware that authorises the caller and sets req.bot.
function mountBotCredentialRoutes(router, pre) {
  router.post('/bots/:botId/token', ...pre, guard((req, res) => {
    res.status(201).json(botStore.issueApiToken(req.bot.id, req.user.id));
  }));

  router.delete('/bots/:botId/token', ...pre, guard((req, res) => {
    res.json({ bot: botStore.revokeApiToken(req.bot.id, req.user.id) });
  }));

  router.post('/bots/:botId/webhook/secret', ...pre, guard((req, res) => {
    res.status(201).json(botStore.rotateWebhookSecret(req.bot.id, req.user.id));
  }));

  router.post('/bots/:botId/webhook/test', ...pre, guard(async (req, res) => {
    const row = botStore.getBotRow(req.bot.id);
    if (!row.webhook_url || !row.webhook_secret_enc) throw new AiError(400, 'set a webhook URL and generate a signing secret first');
    const result = await webhooks.sendTest(row);
    res.json({ ...result, bot: botStore.publicBot(botStore.getBotRow(row.id)) });
  }));
}

module.exports = { mountBotCredentialRoutes };
