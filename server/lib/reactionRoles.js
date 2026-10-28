'use strict';

const { db } = require('../db');
const { broadcastToServer } = require('../socket/hub');
const { isPendingMember } = require('./channelAccess');
const { isSelfAssignableRole } = require('./onboarding');

const MAX_PER_SERVER = 100;
const MAX_PER_MESSAGE = 20;

class ReactionRoleError extends Error {
  constructor(status, message) { super(message); this.name = 'ReactionRoleError'; this.status = status; }
}

function shape(row) {
  const msg = db.prepare('SELECT content FROM messages WHERE id = ?').get(row.message_id);
  const role = db.prepare('SELECT name FROM roles WHERE id = ?').get(row.role_id);
  const ch = db.prepare('SELECT name FROM channels WHERE id = ?').get(row.channel_id);
  return {
    id: row.id,
    channelId: row.channel_id,
    channelName: ch ? ch.name : null,
    messageId: row.message_id,
    messagePreview: msg ? msg.content.slice(0, 80) : '',
    emoji: row.emoji,
    roleId: row.role_id,
    roleName: role ? role.name : null,
    exclusive: !!row.exclusive,
  };
}

function list(serverId) {
  return db.prepare('SELECT * FROM reaction_roles WHERE server_id = ? ORDER BY message_id DESC, id ASC').all(serverId).map(shape);
}

function create({ serverId, userId, channelId, messageId, emoji, roleId, exclusive }) {
  const cleanEmoji = String(emoji ?? '').trim().slice(0, 34);
  if (!cleanEmoji) throw new ReactionRoleError(400, 'pick an emoji');
  const channel = db.prepare('SELECT * FROM channels WHERE id = ? AND server_id = ?').get(Number(channelId), serverId);
  if (!channel || channel.type === 'notes') throw new ReactionRoleError(404, 'channel not found');
  const message = db.prepare("SELECT * FROM messages WHERE id = ? AND scope_type = 'channel' AND scope_id = ?").get(Number(messageId), channel.id);
  if (!message || message.event_type) throw new ReactionRoleError(404, 'message not found in that channel');
  const role = db.prepare('SELECT * FROM roles WHERE id = ? AND server_id = ?').get(Number(roleId), serverId);
  if (!role) throw new ReactionRoleError(404, 'role not found');
  if (!isSelfAssignableRole(role)) throw new ReactionRoleError(400, `the role ${role.name} has moderation or management powers and cannot be handed out by a reaction`);
  if (db.prepare('SELECT COUNT(*) AS n FROM reaction_roles WHERE server_id = ?').get(serverId).n >= MAX_PER_SERVER) throw new ReactionRoleError(409, `a server can have at most ${MAX_PER_SERVER} reaction roles`);
  if (db.prepare('SELECT COUNT(*) AS n FROM reaction_roles WHERE message_id = ?').get(message.id).n >= MAX_PER_MESSAGE) throw new ReactionRoleError(409, `a message can have at most ${MAX_PER_MESSAGE} reaction roles`);
  if (db.prepare('SELECT 1 FROM reaction_roles WHERE message_id = ? AND emoji = ?').get(message.id, cleanEmoji)) throw new ReactionRoleError(409, 'that emoji already gives a role on this message');
  const info = db.prepare('INSERT INTO reaction_roles (server_id, channel_id, message_id, emoji, role_id, exclusive, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(serverId, channel.id, message.id, cleanEmoji, role.id, exclusive ? 1 : 0, userId);
  // Put the emoji on the message so members have something to click.
  db.prepare('INSERT OR IGNORE INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)').run(message.id, userId, cleanEmoji);
  return shape(db.prepare('SELECT * FROM reaction_roles WHERE id = ?').get(Number(info.lastInsertRowid)));
}

function remove(serverId, id) {
  const info = db.prepare('DELETE FROM reaction_roles WHERE id = ? AND server_id = ?').run(id, serverId);
  if (Number(info.changes) !== 1) throw new ReactionRoleError(404, 'reaction role not found');
}

const mappingsFor = (messageId) => db.prepare('SELECT * FROM reaction_roles WHERE message_id = ?').all(messageId);

// Called after a member reacts to a message. Returns true when the roles of the member changed.
function onReactionAdded(message, userId, emoji) {
  if (message.scope_type !== 'channel') return false;
  const rows = mappingsFor(message.id);
  const row = rows.find((r) => r.emoji === emoji);
  if (!row) return false;
  if (isPendingMember(row.server_id, userId)) return false;
  if (!db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(row.server_id, userId)) return false;
  const role = db.prepare('SELECT * FROM roles WHERE id = ? AND server_id = ?').get(row.role_id, row.server_id);
  // Re-checked on every use: a role may have gained power since the mapping was made.
  if (!isSelfAssignableRole(role)) return false;
  let changed = false;
  if (row.exclusive) {
    for (const other of rows.filter((r) => r.id !== row.id)) {
      if (Number(db.prepare('DELETE FROM member_roles WHERE server_id = ? AND user_id = ? AND role_id = ?').run(row.server_id, userId, other.role_id).changes)) changed = true;
      db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(message.id, userId, other.emoji);
    }
  }
  if (Number(db.prepare('INSERT OR IGNORE INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)').run(row.server_id, userId, role.id).changes)) changed = true;
  if (changed) broadcastToServer(row.server_id, { type: 'member_role_update', userId, serverId: row.server_id });
  return changed;
}

function onReactionRemoved(message, userId, emoji) {
  if (message.scope_type !== 'channel') return false;
  const row = mappingsFor(message.id).find((r) => r.emoji === emoji);
  if (!row) return false;
  const changed = Number(db.prepare('DELETE FROM member_roles WHERE server_id = ? AND user_id = ? AND role_id = ?').run(row.server_id, userId, row.role_id).changes) > 0;
  if (changed) broadcastToServer(row.server_id, { type: 'member_role_update', userId, serverId: row.server_id });
  return changed;
}

module.exports = { ReactionRoleError, list, create, remove, onReactionAdded, onReactionRemoved, MAX_PER_SERVER, MAX_PER_MESSAGE };
