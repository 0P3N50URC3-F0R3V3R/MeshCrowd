'use strict';

const { db } = require('../../db');
const { serializeMessage } = require('../messages');
const { canSendToScope } = require('../scopeAccess');
const { parseMentions, notifyChannelMessage, notifyDmMessage } = require('../notifications');

const { maxMessageChars } = require('../messageLimits');

// Bots never get to ping the whole server: a zero-width space after the "@" stops the mention parser.
const defuseBroadcast = (text) => text.replace(/@(everyone|here)\b/gi, '@​$1');

class BotPostError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Posts a message as a bot into a channel, thread or 1:1 DM, through the same permission checks,
// broadcast and notification path a person's message takes.
function postAsBot(bot, { scopeType, scopeId, content, replyToMessageId, interaction }) {
  if (!['channel', 'thread', 'dm'].includes(scopeType)) throw new BotPostError(400, 'scopeType must be channel, thread or dm');
  if (!Number.isInteger(scopeId)) throw new BotPostError(400, 'scopeId must be a whole number');
  if (typeof content !== 'string' || !content.trim()) throw new BotPostError(400, 'content is required');
  if (content.length > maxMessageChars()) throw new BotPostError(400, `content must be at most ${maxMessageChars()} characters`);

  const access = canSendToScope(scopeType, scopeId, bot.user_id);
  if (!access.ok) throw new BotPostError(access.status, access.error);
  const { ctx } = access;
  if (ctx.channel && ctx.channel.server_id !== bot.server_id) throw new BotPostError(403, 'a bot can only post in its own server');
  if (ctx.channel && ctx.channel.type === 'notes') throw new BotPostError(403, 'bots cannot post in Notes channels');
  if (ctx.channel && ctx.channel.type === 'forum' && scopeType === 'channel') throw new BotPostError(400, 'post into a thread of a forum channel');
  if (ctx.dm && (ctx.dm.is_group || ctx.dm.e2ee_enabled || !bot.dm_enabled)) throw new BotPostError(403, 'this conversation does not accept bot messages');

  let replyTo = null;
  if (replyToMessageId !== undefined && replyToMessageId !== null) {
    const parent = db.prepare('SELECT id FROM messages WHERE id = ? AND scope_type = ? AND scope_id = ?').get(Number(replyToMessageId), scopeType, scopeId);
    if (!parent) throw new BotPostError(400, 'replyToMessageId is not in this conversation');
    replyTo = parent.id;
  }

  const text = defuseBroadcast(content);
  const info = db.prepare('INSERT INTO messages (scope_type, scope_id, author_id, content, reply_to_message_id, interaction_command, interaction_user_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(scopeType, scopeId, bot.user_id, text, replyTo, interaction ? interaction.command : null, interaction ? interaction.userId : null);
  const message = serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid));
  ctx.broadcast({ type: 'message_create', message });
  if (ctx.dm) {
    notifyDmMessage(ctx.dm, message);
  } else {
    const candidateUsers = db.prepare('SELECT u.id, u.username FROM server_members sm JOIN users u ON u.id = sm.user_id WHERE sm.server_id = ?').all(ctx.channel.server_id);
    const roles = db.prepare('SELECT id, name FROM roles WHERE server_id = ?').all(ctx.channel.server_id);
    notifyChannelMessage(ctx.channel, message, parseMentions(text, { candidateUsers, roles }));
  }
  return message;
}

function ownMessage(bot, messageId) {
  const row = db.prepare('SELECT * FROM messages WHERE id = ? AND author_id = ?').get(messageId, bot.user_id);
  if (!row) throw new BotPostError(404, 'message not found');
  const access = canSendToScope(row.scope_type, row.scope_id, bot.user_id);
  if (!access.ok) throw new BotPostError(access.status, access.error);
  return { row, ctx: access.ctx };
}

function editOwnMessage(bot, messageId, content) {
  if (typeof content !== 'string' || !content.trim() || content.length > maxMessageChars()) {
    throw new BotPostError(400, `content is required (at most ${maxMessageChars()} characters)`);
  }
  const { row, ctx } = ownMessage(bot, messageId);
  db.prepare("UPDATE messages SET content = ?, edited_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(defuseBroadcast(content), row.id);
  const message = serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(row.id));
  ctx.broadcast({ type: 'message_update', message });
  return message;
}

function deleteOwnMessage(bot, messageId) {
  const { row, ctx } = ownMessage(bot, messageId);
  db.prepare('DELETE FROM messages WHERE id = ?').run(row.id);
  ctx.broadcast({ type: 'message_delete', messageId: row.id, scopeType: row.scope_type, scopeId: row.scope_id });
}

module.exports = { BotPostError, postAsBot, editOwnMessage, deleteOwnMessage, defuseBroadcast };
