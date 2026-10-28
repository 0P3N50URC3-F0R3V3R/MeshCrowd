'use strict';

const { db } = require('../../db');
const { resolveScope } = require('../scopeAccess');
const { getChannelPermissionBits } = require('../channelAccess');
const { PERMISSIONS, has } = require('../permissions');
const logger = require('../logger');
const dispatcher = require('../ai/dispatcher');
const webhooks = require('./webhooks');

const WEBHOOK_BOTS = `SELECT b.*, u.username, u.display_name AS bot_name FROM bots b JOIN users u ON u.id = b.user_id
  WHERE u.is_disabled = 0 AND b.webhook_enabled = 1 AND b.webhook_url IS NOT NULL AND b.webhook_secret_enc IS NOT NULL`;

function messageView(message) {
  return {
    id: message.id,
    content: message.content,
    createdAt: message.createdAt,
    author: { id: message.author.id, username: message.author.username, displayName: message.author.displayName, isBot: !!message.author.isBot },
    replyToMessageId: message.replyTo ? message.replyTo.id : null,
    attachments: (message.attachments || []).map((a) => ({ name: a.fileName, url: a.url, mimeType: a.mimeType, sizeBytes: a.sizeBytes })),
  };
}

function buildPayload({ bot, trigger, message, ctx }) {
  const server = ctx.channel ? db.prepare('SELECT id, name FROM servers WHERE id = ?').get(ctx.channel.server_id) : null;
  return {
    type: 'message_create',
    trigger,
    bot: { id: bot.id, userId: bot.user_id, username: bot.username },
    server: server ? { id: server.id, name: server.name } : null,
    channel: ctx.channel ? { id: ctx.channel.id, name: ctx.channel.name, type: ctx.channel.type } : null,
    threadId: ctx.thread ? ctx.thread.id : null,
    dmId: ctx.dm ? ctx.dm.id : null,
    message: messageView(message),
  };
}

// Which webhook bots should hear about this message, and why. Mirrors the AI dispatcher's
// triggers so a bot with both jobs reacts to the same messages in both.
function webhookTargets(message, ctx) {
  if (ctx.dm) {
    if (ctx.dm.is_group || ctx.dm.e2ee_enabled) return [];
    const other = db.prepare('SELECT user_id FROM dm_members WHERE dm_channel_id = ? AND user_id != ?').get(ctx.dm.id, message.author.id);
    if (!other) return [];
    const bot = db.prepare(`${WEBHOOK_BOTS} AND b.user_id = ? AND b.dm_enabled = 1`).get(other.user_id);
    return bot ? [{ bot, trigger: 'dm' }] : [];
  }
  const channel = ctx.channel;
  if (!channel || channel.type === 'notes') return [];
  const out = [];
  for (const bot of db.prepare(`${WEBHOOK_BOTS} AND b.server_id = ?`).all(channel.server_id)) {
    const bits = getChannelPermissionBits(channel, bot.user_id);
    if (!has(bits, PERMISSIONS.VIEW_CHANNEL)) continue;
    const mentioned = dispatcher.mentionsUser(message.content, bot.username) || message.replyTo?.author?.id === bot.user_id;
    if (mentioned) out.push({ bot, trigger: 'mention' });
    else if (bot.webhook_scope === 'all') out.push({ bot, trigger: 'message' });
  }
  return out;
}

function deliverWebhooks(message) {
  if (!message || message.author?.isBot || message.isWebhook || message.eventType || message.isEncrypted) return;
  const ctx = resolveScope(message.scopeType, message.scopeId);
  if (!ctx) return;
  for (const { bot, trigger } of webhookTargets(message, ctx)) {
    webhooks.enqueue(bot.id, buildPayload({ bot, trigger, message, ctx }));
  }
}

// The single hook the message routes call after a message is stored and broadcast. Never throws.
async function onMessageCreated(message) {
  try { deliverWebhooks(message); } catch (err) { logger.error(`[bots] webhook dispatch failure: ${err.message}`); }
  await dispatcher.maybeRespond(message);
}

module.exports = { onMessageCreated, deliverWebhooks, webhookTargets, buildPayload };
