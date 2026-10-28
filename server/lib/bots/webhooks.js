'use strict';

const crypto = require('node:crypto');
const { db } = require('../../db');
const secretBox = require('../ai/secretBox');
const { aiRequest, readBody } = require('../ai/http');
const logger = require('../logger');

const settings = { timeoutMs: 10_000, backoffMs: [0, 5_000, 30_000], maxPending: 50 };
const queues = new Map(); // botId -> { pending: [], running: boolean }

class WebhookUrlError extends Error {}

// Unlike an AI provider's base URL, a webhook URL may carry a path and a query (n8n puts its
// token there), but never credentials.
function validateWebhookUrl(raw) {
  let u;
  try { u = new URL(String(raw ?? '').trim()); } catch { throw new WebhookUrlError('invalid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new WebhookUrlError('URL must be http or https');
  if (!u.hostname) throw new WebhookUrlError('invalid URL');
  if (u.username || u.password) throw new WebhookUrlError('URL must not contain credentials');
  if (u.hash) throw new WebhookUrlError('URL must not contain a fragment');
  const out = u.toString();
  if (out.length > 500) throw new WebhookUrlError('URL is too long');
  return out;
}

// Signature = HMAC-SHA256(secret, "<timestamp>.<raw body>"); the receiver recomputes it and also
// rejects stale timestamps to stop replays.
const sign = (secret, timestamp, body) => `sha256=${crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;

async function attempt(bot, delivery) {
  let secret;
  try { secret = secretBox.decrypt(bot.webhook_secret_enc); } catch { return { ok: false, error: 'the signing secret is unreadable' }; }
  const body = JSON.stringify(delivery.payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  try {
    const res = await aiRequest(bot.webhook_url, {
      method: 'POST',
      body,
      allowPrivate: !!bot.webhook_allow_private,
      signal: AbortSignal.timeout(settings.timeoutMs),
      headers: {
        'user-agent': 'MeshCrowd-Bot/1',
        'x-meshcrowd-event': delivery.payload.type,
        'x-meshcrowd-delivery': delivery.id,
        'x-meshcrowd-timestamp': timestamp,
        'x-meshcrowd-signature': sign(secret, timestamp, body),
      },
    });
    try { await readBody(res, 65536); } catch { /* the reply body is not used */ }
    const ok = res.statusCode >= 200 && res.statusCode < 300;
    return { ok, status: res.statusCode, retry: !ok && (res.statusCode >= 500 || res.statusCode === 429 || res.statusCode === 408), error: ok ? undefined : `HTTP ${res.statusCode}` };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { ok: false, retry: true, error: timedOut ? 'timed out' : (err && err.message === 'address is not public' ? 'address is not public' : 'could not connect') };
  }
}

function record(botId, result) {
  const text = result.ok ? `ok ${result.status}` : `failed: ${result.error}`;
  db.prepare('UPDATE bots SET webhook_last_status = ?, webhook_last_at = ? WHERE id = ?').run(text, new Date().toISOString(), botId);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function deliver(botId, delivery) {
  for (let i = 0; i < settings.backoffMs.length; i++) {
    if (settings.backoffMs[i]) await sleep(settings.backoffMs[i]);
    const bot = db.prepare('SELECT * FROM bots WHERE id = ?').get(botId);
    if (!bot || !bot.webhook_enabled || !bot.webhook_url || !bot.webhook_secret_enc) return;
    const result = await attempt(bot, delivery);
    record(botId, result);
    if (result.ok || !result.retry) {
      if (!result.ok) logger.warn(`[bots] webhook for bot ${botId} failed: ${result.error}`);
      return;
    }
  }
  logger.warn(`[bots] webhook for bot ${botId} gave up after ${settings.backoffMs.length} attempts`);
}

async function drain(botId) {
  const q = queues.get(botId);
  if (!q || q.running) return;
  q.running = true;
  try {
    while (q.pending.length) await deliver(botId, q.pending.shift());
  } finally {
    q.running = false;
    if (!q.pending.length) queues.delete(botId);
  }
}

// Events for one bot are delivered in order; a slow receiver cannot grow the queue past maxPending.
function enqueue(botId, payload) {
  let q = queues.get(botId);
  if (!q) { q = { pending: [], running: false }; queues.set(botId, q); }
  if (q.pending.length >= settings.maxPending) q.pending.shift();
  q.pending.push({ id: crypto.randomUUID(), payload });
  drain(botId).catch((err) => logger.error(`[bots] webhook queue failure: ${err.message}`));
}

// One immediate, un-retried request for the "Send test event" button.
async function sendTest(bot) {
  const payload = { type: 'ping', bot: { id: bot.id, userId: bot.user_id, username: bot.username }, message: 'MeshCrowd test event' };
  const result = await attempt(bot, { id: crypto.randomUUID(), payload });
  record(bot.id, result);
  return { ok: result.ok, status: result.status ?? null, error: result.error ?? null };
}

function _reset() { queues.clear(); }

module.exports = { WebhookUrlError, validateWebhookUrl, sign, enqueue, sendTest, settings, _reset, _queues: queues };
