'use strict';

const { db } = require('../db');
const { canView, PIN_EPOCH } = require('./pinSeen');

// Threads with messages from other people that this user has not read yet. Messages from before the
// feature shipped (PIN_EPOCH) never count, so old threads do not all light up at once.
function unreadThreads(userId) {
  const rows = db.prepare(
    `SELECT t.id AS threadId, t.channel_id AS channelId, MAX(m.id) AS lastMessageId
       FROM threads t
       JOIN messages m ON m.scope_type = 'thread' AND m.scope_id = t.id
       LEFT JOIN read_state rs ON rs.user_id = ? AND rs.scope_type = 'thread' AND rs.scope_id = t.id
      WHERE m.author_id != ? AND m.created_at > ? AND m.id > COALESCE(rs.last_read_message_id, 0)
      GROUP BY t.id`
  ).all(userId, userId, PIN_EPOCH);
  return rows.filter((r) => canView('channel', r.channelId, userId));
}

module.exports = { unreadThreads };
