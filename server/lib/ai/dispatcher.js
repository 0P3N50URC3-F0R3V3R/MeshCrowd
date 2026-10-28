'use strict';

const { db } = require('../../db');
const { serializeMessage, listMessages } = require('../messages');
const { resolveScope } = require('../scopeAccess');
const { getChannelPermissionBits } = require('../channelAccess');
const { PERMISSIONS, has } = require('../permissions');
const { getMemberTimeout } = require('../moderation');
const { notifyChannelMessage, notifyDmMessage } = require('../notifications');
const logger = require('../logger');
const providers = require('./providers');
const { buildMessages } = require('./context');
const { cleanReply } = require('./sanitize');
const { ProviderQueue } = require('./queue');

const BUSY_TEXT = 'I am busy right now, please try again in a moment.';
const NO_ANSWER_TEXT = 'I had no answer for that.';
const INTERRUPTED_NOTE = '\n\n_(answer interrupted)_';

const settings = { cooldownMs: 10_000, editIntervalMs: 1000, typingIntervalMs: 4000 };
const queue = new ProviderQueue({ maxWaiting: 5 });
const lastUse = new Map();

const BOT_SELECT = `SELECT b.*, u.username, u.display_name AS bot_name, u.is_disabled AS user_disabled
  FROM bots b JOIN users u ON u.id = b.user_id`;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentionsUser = (content, username) => new RegExp(`(^|[^a-zA-Z0-9_.])@${escapeRe(username)}(?![a-zA-Z0-9_.])`, 'i').test(content || '');

function findTargets(message) {
  const ctx = resolveScope(message.scopeType, message.scopeId);
  if (!ctx) return null;
  if (message.scopeType === 'dm') {
    if (ctx.dm.is_group || ctx.dm.e2ee_enabled) return null;
    const other = db.prepare('SELECT user_id FROM dm_members WHERE dm_channel_id = ? AND user_id != ?').get(ctx.dm.id, message.author.id);
    if (!other) return null;
    const bot = db.prepare(`${BOT_SELECT} WHERE b.user_id = ? AND b.dm_enabled = 1 AND b.provider_id IS NOT NULL`).get(other.user_id);
    return bot ? { ctx, bots: [bot] } : null;
  }
  const channel = ctx.channel;
  if (channel.type === 'notes') return null;
  const candidates = db.prepare(`${BOT_SELECT} WHERE b.server_id = ? AND b.mention_enabled = 1 AND b.provider_id IS NOT NULL`).all(channel.server_id);
  const bots = candidates.filter((b) => (mentionsUser(message.content, b.username) || message.replyTo?.author?.id === b.user_id)
    && has(getChannelPermissionBits(channel, b.user_id), PERMISSIONS.VIEW_CHANNEL)
    && has(getChannelPermissionBits(channel, b.user_id), PERMISSIONS.SEND_MESSAGES));
  return bots.length ? { ctx, bots } : null;
}

function insertBotMessage(bot, trigger, ctx, content) {
  const replyTo = ctx.dm ? null : trigger.id;
  const info = db.prepare('INSERT INTO messages (scope_type, scope_id, author_id, content, reply_to_message_id) VALUES (?, ?, ?, ?, ?)')
    .run(trigger.scopeType, trigger.scopeId, bot.user_id, content, replyTo);
  const created = serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid));
  ctx.broadcast({ type: 'message_create', message: created });
  return created;
}

function updateBotMessage(id, content, ctx) {
  db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(content, id);
  const updated = serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(id));
  ctx.broadcast({ type: 'message_update', message: updated });
  return updated;
}

function notifyAsker(ctx, finalMessage, asker) {
  if (ctx.dm) notifyDmMessage(ctx.dm, finalMessage);
  else notifyChannelMessage(ctx.channel, finalMessage, { userIds: [asker.id], roleIds: [], everyone: false, here: false });
}

async function respond(bot, provider, trigger, ctx) {
  const rawHtml = !!(ctx.channel && db.prepare('SELECT raw_html_enabled FROM servers WHERE id = ?').get(ctx.channel.server_id)?.raw_html_enabled);
  const server = ctx.channel ? db.prepare('SELECT name FROM servers WHERE id = ?').get(ctx.channel.server_id) : null;
  const history = listMessages(trigger.scopeType, trigger.scopeId, { limit: bot.context_messages });
  const messages = buildMessages({
    bot: { displayName: bot.bot_name, persona: bot.persona, userId: bot.user_id },
    serverName: server?.name || '',
    channelName: ctx.channel?.name || '',
    dmWith: ctx.dm ? trigger.author.displayName : null,
    history,
  });

  const sendTyping = () => {
    if (trigger.scopeType !== 'thread') ctx.broadcast({ type: 'typing', scopeType: trigger.scopeType, scopeId: trigger.scopeId, userId: bot.user_id });
  };
  sendTyping();
  const typingTimer = setInterval(sendTyping, settings.typingIntervalMs);

  let reply = null;
  let text = '';
  let dirty = false;
  const flush = () => {
    if (!reply || !dirty) return;
    dirty = false;
    updateBotMessage(reply.id, cleanReply(text, { rawHtml }), ctx);
  };
  const editTimer = setInterval(flush, settings.editIntervalMs);

  let failure = null;
  try {
    const result = await providers.chat({
      provider,
      model: bot.model,
      messages,
      onToken: (token, full) => {
        text = full;
        if (!reply) {
          clearInterval(typingTimer);
          reply = insertBotMessage(bot, trigger, ctx, cleanReply(full, { rawHtml }));
        } else dirty = true;
      },
    });
    text = result.text;
  } catch (err) {
    failure = err;
  } finally {
    clearInterval(typingTimer);
    clearInterval(editTimer);
  }

  if (failure) {
    logger.warn(`[ai] bot ${bot.id} provider call failed: ${failure.message}`);
    const reason = failure instanceof providers.ProviderError ? failure.message : 'the AI provider is unavailable';
    if (reply) updateBotMessage(reply.id, cleanReply(text + INTERRUPTED_NOTE, { rawHtml }), ctx);
    else notifyAsker(ctx, insertBotMessage(bot, trigger, ctx, `Sorry, I could not answer: ${reason}.`), trigger.author);
    return;
  }
  if (!text.trim()) {
    notifyAsker(ctx, insertBotMessage(bot, trigger, ctx, NO_ANSWER_TEXT), trigger.author);
    return;
  }
  const finalMessage = reply ? updateBotMessage(reply.id, cleanReply(text, { rawHtml }), ctx) : insertBotMessage(bot, trigger, ctx, cleanReply(text, { rawHtml }));
  notifyAsker(ctx, finalMessage, trigger.author);
}

async function handle(bot, message, ctx) {
  if (bot.user_disabled) return;
  const provider = db.prepare('SELECT * FROM ai_providers WHERE id = ?').get(bot.provider_id);
  if (!provider || !provider.enabled) return;
  if (ctx.channel && getMemberTimeout(ctx.channel.server_id, message.author.id)) return;

  const now = Date.now();
  const key = `${bot.id}:${message.author.id}`;
  const last = lastUse.get(key);
  if (last !== undefined && now - last < settings.cooldownMs) return;
  lastUse.set(key, now);
  if (lastUse.size > 1000) {
    for (const [k, t] of lastUse) if (now - t > settings.cooldownMs) lastUse.delete(k);
  }

  const job = queue.submit(provider.id, provider.concurrency, () => respond(bot, provider, message, ctx));
  if (!job) {
    notifyAsker(ctx, insertBotMessage(bot, message, ctx, BUSY_TEXT), message.author);
    return;
  }
  await job;
}

async function maybeRespond(message) {
  try {
    if (!message || message.author?.isBot || message.isWebhook || message.eventType || message.isEncrypted) return;
    if (!String(message.content || '').trim()) return;
    const found = findTargets(message);
    if (!found) return;
    await Promise.all(found.bots.map((bot) => handle(bot, message, found.ctx).catch((err) => {
      logger.error(`[ai] bot ${bot.id} failed: ${err.message}`);
    })));
  } catch (err) {
    logger.error(`[ai] dispatcher failure: ${err.message}`);
  }
}

function _resetState() {
  lastUse.clear();
  queue.reset();
}

module.exports = { maybeRespond, mentionsUser, _settings: settings, _queue: queue, _resetState };
