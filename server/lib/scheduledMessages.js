'use strict';

const { db } = require('../db');
const { serializeMessage } = require('./messages');
const { maxMessageChars } = require('./messageLimits');
const { canSendToScope } = require('./scopeAccess');
const { parseMentions, notifyChannelMessage, notifyDmMessage } = require('./notifications');
const { maybeFetchAndAttachEmbed } = require('./linkPreview');
const { serializeRemoteMessage, relayRemoteChannelEvent } = require('./remoteChannelEvents');
const { onMessageCreated } = require('./bots/events');
const automod = require('./automod');
const logger = require('./logger');

const MAX_PENDING = 50;
const MIN_DELAY_MS = 30_000;
const MAX_AHEAD_MS = 366 * 24 * 3600_000;
const FAILED_KEEP_MS = 7 * 24 * 3600_000;
const STALE_MS = 7 * 24 * 3600_000; // a message this overdue (server was off) is not sent any more
const TICK_MS = 10_000;
const MAX_PER_TICK = 50;

class ScheduleError extends Error {
  constructor(status, message) { super(message); this.name = 'ScheduleError'; this.status = status; }
}

function shape(row) {
  let where = null;
  if (row.scope_type === 'dm') {
    const members = db.prepare('SELECT u.display_name FROM dm_members m JOIN users u ON u.id = m.user_id WHERE m.dm_channel_id = ? AND m.user_id != ?').all(row.scope_id, row.user_id);
    where = members.map((m) => m.display_name).join(', ') || null;
  } else {
    const ch = row.scope_type === 'channel'
      ? db.prepare('SELECT name FROM channels WHERE id = ?').get(row.scope_id)
      : db.prepare('SELECT c.name FROM threads t JOIN channels c ON c.id = t.channel_id WHERE t.id = ?').get(row.scope_id);
    where = ch ? `#${ch.name}` : null;
  }
  return { id: row.id, scopeType: row.scope_type, scopeId: row.scope_id, where, content: row.content, replyToMessageId: row.reply_to_message_id, sendAt: row.send_at, status: row.status === 'sending' ? 'pending' : row.status, error: row.error };
}

function parseSendAt(raw) {
  const t = new Date(String(raw ?? '')).getTime();
  if (!Number.isFinite(t)) throw new ScheduleError(400, 'sendAt must be a date and time');
  const delta = t - Date.now();
  if (delta < MIN_DELAY_MS) throw new ScheduleError(400, 'pick a time at least a minute from now');
  if (delta > MAX_AHEAD_MS) throw new ScheduleError(400, 'a message can be scheduled at most a year ahead');
  return new Date(t).toISOString();
}

function checkContent(content) {
  if (typeof content !== 'string' || !content.trim()) throw new ScheduleError(400, 'content is required');
  if (content.length > maxMessageChars()) throw new ScheduleError(400, `content must be at most ${maxMessageChars()} characters`);
}

// The conversation must exist, accept this user now, and be something the sender can build on later.
function checkTarget(user, scopeType, scopeId, replyToMessageId) {
  if (!['channel', 'thread', 'dm'].includes(scopeType)) throw new ScheduleError(400, 'scopeType must be channel, thread or dm');
  if (!Number.isInteger(scopeId)) throw new ScheduleError(400, 'scopeId must be a whole number');
  const access = canSendToScope(scopeType, scopeId, user.id);
  if (!access.ok) throw new ScheduleError(access.status, access.error);
  const { ctx } = access;
  if (ctx.channel && (ctx.channel.type === 'notes' || (scopeType === 'channel' && ctx.channel.type === 'forum'))) throw new ScheduleError(400, 'messages cannot be scheduled here');
  if (ctx.dm) {
    if (ctx.dm.e2ee_enabled) throw new ScheduleError(400, 'messages in an end-to-end encrypted conversation cannot be scheduled');
    if (db.prepare('SELECT 1 FROM dm_members m JOIN users u ON u.id = m.user_id WHERE m.dm_channel_id = ? AND u.home_instance_id IS NOT NULL').get(ctx.dm.id)) {
      throw new ScheduleError(400, 'messages to contacts on another instance cannot be scheduled');
    }
  }
  if (replyToMessageId !== undefined && replyToMessageId !== null) {
    if (!db.prepare('SELECT 1 FROM messages WHERE id = ? AND scope_type = ? AND scope_id = ?').get(Number(replyToMessageId), scopeType, scopeId)) throw new ScheduleError(400, 'replyToMessageId is not in this conversation');
  }
}

function create(user, { scopeType, scopeId, content, sendAt, replyToMessageId }) {
  checkContent(content);
  const at = parseSendAt(sendAt);
  checkTarget(user, scopeType, scopeId, replyToMessageId);
  if (db.prepare("SELECT COUNT(*) AS n FROM scheduled_messages WHERE user_id = ? AND status != 'failed'").get(user.id).n >= MAX_PENDING) throw new ScheduleError(409, `you can have at most ${MAX_PENDING} scheduled messages`);
  const info = db.prepare('INSERT INTO scheduled_messages (user_id, scope_type, scope_id, content, reply_to_message_id, send_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(user.id, scopeType, scopeId, content, replyToMessageId ?? null, at);
  return shape(db.prepare('SELECT * FROM scheduled_messages WHERE id = ?').get(Number(info.lastInsertRowid)));
}

function list(userId) {
  return db.prepare("SELECT * FROM scheduled_messages WHERE user_id = ? ORDER BY send_at ASC, id ASC").all(userId).map(shape);
}

function update(user, id, { content, sendAt }) {
  const row = db.prepare("SELECT * FROM scheduled_messages WHERE id = ? AND user_id = ? AND status = 'pending'").get(id, user.id);
  if (!row) throw new ScheduleError(404, 'scheduled message not found');
  const nextContent = content !== undefined ? content : row.content;
  checkContent(nextContent);
  const at = sendAt !== undefined ? parseSendAt(sendAt) : row.send_at;
  db.prepare('UPDATE scheduled_messages SET content = ?, send_at = ? WHERE id = ?').run(nextContent, at, id);
  return shape(db.prepare('SELECT * FROM scheduled_messages WHERE id = ?').get(id));
}

function cancel(userId, id) {
  const info = db.prepare("DELETE FROM scheduled_messages WHERE id = ? AND user_id = ? AND status IN ('pending', 'failed')").run(id, userId);
  if (Number(info.changes) !== 1) throw new ScheduleError(404, 'scheduled message not found');
}

class Refused extends Error {}

function send(row) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  if (!user || user.is_disabled) throw new Refused('the account is disabled');
  const access = canSendToScope(row.scope_type, row.scope_id, user.id);
  if (!access.ok) throw new Refused(access.error === 'not found' ? 'the conversation no longer exists' : access.error);
  const { ctx } = access;
  if (ctx.channel && ctx.channel.type === 'notes') throw new Refused('messages cannot be sent here');
  if (ctx.dm && (ctx.dm.e2ee_enabled || db.prepare('SELECT 1 FROM dm_members m JOIN users u ON u.id = m.user_id WHERE m.dm_channel_id = ? AND u.home_instance_id IS NOT NULL').get(ctx.dm.id))) throw new Refused('this conversation cannot receive scheduled messages');
  if (ctx.channel) {
    const blocked = automod.evaluate({ channel: ctx.channel, user, content: row.content });
    if (blocked) throw new Refused(blocked.message);
  }
  let replyTo = null;
  if (row.reply_to_message_id && db.prepare('SELECT 1 FROM messages WHERE id = ? AND scope_type = ? AND scope_id = ?').get(row.reply_to_message_id, row.scope_type, row.scope_id)) replyTo = row.reply_to_message_id;

  const info = db.prepare('INSERT INTO messages (scope_type, scope_id, author_id, content, reply_to_message_id) VALUES (?, ?, ?, ?, ?)').run(row.scope_type, row.scope_id, user.id, row.content, replyTo);
  const message = serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid));
  ctx.broadcast({ type: 'message_create', message });
  maybeFetchAndAttachEmbed(message, (payload) => ctx.broadcast(payload)).catch(() => {});
  if (ctx.dm) {
    notifyDmMessage(ctx.dm, message);
  } else {
    if (row.scope_type === 'channel') relayRemoteChannelEvent(ctx.channel, 'message_create', { message: serializeRemoteMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(message.id)) });
    const candidateUsers = db.prepare('SELECT u.id, u.username FROM server_members sm JOIN users u ON u.id = sm.user_id WHERE sm.server_id = ?').all(ctx.channel.server_id);
    const roles = db.prepare('SELECT id, name FROM roles WHERE server_id = ?').all(ctx.channel.server_id);
    notifyChannelMessage(ctx.channel, message, parseMentions(row.content, { candidateUsers, roles }));
  }
  onMessageCreated(message);
}

function deliverDue(now = new Date()) {
  const iso = now.toISOString();
  const due = db.prepare("SELECT * FROM scheduled_messages WHERE status = 'pending' AND send_at <= ? ORDER BY send_at ASC LIMIT ?").all(iso, MAX_PER_TICK);
  let sent = 0;
  for (const row of due) {
    // Claim first so two overlapping ticks can never send the same message twice.
    if (Number(db.prepare("UPDATE scheduled_messages SET status = 'sending' WHERE id = ? AND status = 'pending'").run(row.id).changes) !== 1) continue;
    try {
      if (now.getTime() - new Date(row.send_at).getTime() > STALE_MS) throw new Refused('it was due while the server was off for too long');
      send(row);
      db.prepare('DELETE FROM scheduled_messages WHERE id = ?').run(row.id);
      sent += 1;
    } catch (err) {
      const reason = err instanceof Refused ? err.message : 'the message could not be sent';
      if (!(err instanceof Refused)) logger.error(`[scheduled] message ${row.id} failed: ${err.message}`);
      db.prepare("UPDATE scheduled_messages SET status = 'failed', error = ?, failed_at = ? WHERE id = ?").run(reason, now.toISOString(), row.id);
    }
  }
  db.prepare("DELETE FROM scheduled_messages WHERE status = 'failed' AND failed_at < ?").run(new Date(now.getTime() - FAILED_KEEP_MS).toISOString());
  return sent;
}

let timer = null;
function startWorker() {
  if (timer) return;
  // A message that was mid-send when the process stopped is retried, not lost.
  db.prepare("UPDATE scheduled_messages SET status = 'pending' WHERE status = 'sending'").run();
  timer = setInterval(() => { try { deliverDue(); } catch (err) { logger.error(`[scheduled] ${err.message}`); } }, TICK_MS);
  timer.unref?.();
}

module.exports = { ScheduleError, create, list, update, cancel, deliverDue, startWorker, MAX_PENDING };
