'use strict';

const { db } = require('../db');
const hub = require('../socket/hub');
const { toPublicUser } = require('./publicUser');
const { canViewMessage } = require('./userMeta');

const TICK_MS = 15_000;
const MAX_PER_TICK = 50;

// A reminder is only marked delivered once its owner has a live socket to receive it, so one that
// comes due while they are offline fires the next time they connect.
function deliverDueReminders(now = new Date().toISOString()) {
  const due = db.prepare(
    'SELECT * FROM message_reminders WHERE delivered_at IS NULL AND remind_at <= ? ORDER BY remind_at LIMIT ?'
  ).all(now, MAX_PER_TICK);
  let sent = 0;
  for (const r of due) {
    if (!hub.isOnline(r.user_id)) continue;
    const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(r.message_id);
    db.prepare('UPDATE message_reminders SET delivered_at = ? WHERE id = ?').run(now, r.id);
    if (!message || !canViewMessage(r.user_id, message)) continue;
    const author = db.prepare('SELECT * FROM users WHERE id = ?').get(message.author_id);
    const channel = message.scope_type === 'channel'
      ? db.prepare('SELECT id, server_id FROM channels WHERE id = ?').get(message.scope_id)
      : message.scope_type === 'thread'
        ? db.prepare('SELECT c.id, c.server_id FROM threads t JOIN channels c ON c.id = t.channel_id WHERE t.id = ?').get(message.scope_id)
        : null;
    hub.notifyUser(r.user_id, {
      type: 'reminder',
      reminderId: r.id,
      messageId: message.id,
      scopeType: message.scope_type,
      scopeId: message.scope_id,
      serverId: channel ? channel.server_id : null,
      channelId: channel ? channel.id : null,
      encrypted: !!message.is_encrypted,
      snippet: message.is_encrypted ? '' : String(message.content || '').slice(0, 200),
      author: author ? toPublicUser(author, {}) : null,
    });
    sent += 1;
  }
  return sent;
}

let timer = null;
function startReminderWorker() {
  if (timer) return;
  timer = setInterval(() => { try { deliverDueReminders(); } catch (err) { console.error('[reminders]', err); } }, TICK_MS);
  timer.unref?.();
}

module.exports = { deliverDueReminders, startReminderWorker };
