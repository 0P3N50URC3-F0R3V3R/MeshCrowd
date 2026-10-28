'use strict';

const { db } = require('../db');

// Age-restricted channels: a one-time "I am 18 or older" confirmation stored on the account.
// This is a UX gate, not identity verification: nothing is checked and no third party is involved.
function nsfwBlock(channel, userId) {
  if (!channel || !channel.nsfw) return null;
  const u = db.prepare('SELECT nsfw_ack_at, is_bot FROM users WHERE id = ?').get(userId);
  if (!u || u.is_bot || u.nsfw_ack_at) return null;
  return { status: 403, body: { error: 'this channel is age-restricted', code: 'nsfw' } };
}

function acknowledgeNsfw(userId) {
  db.prepare("UPDATE users SET nsfw_ack_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND nsfw_ack_at IS NULL").run(userId);
}

function revokeNsfwAck(userId) {
  db.prepare('UPDATE users SET nsfw_ack_at = NULL WHERE id = ?').run(userId);
}

module.exports = { nsfwBlock, acknowledgeNsfw, revokeNsfwAck };
