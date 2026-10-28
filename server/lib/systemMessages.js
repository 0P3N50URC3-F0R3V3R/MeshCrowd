'use strict';

const { db } = require('../db');
const { serializeMessage } = require('./messages');
const { broadcastToChannel, broadcastToDm } = require('../socket/hub');

const EVENT_TEXT = {
  member_join: ({ target }) => `${target} joined the server.`,
  member_greeting: ({ target, server, greeting }) => (greeting
    ? greeting.replace(/\{name\}/g, target).replace(/\{server\}/g, server)
    : `Welcome to ${server}, ${target}!`),
  member_leave: ({ target }) => `${target} left the server.`,
  member_kick: ({ target, actor }) => `${target} was kicked from the server${actor ? ` by ${actor}` : ''}.`,
  member_ban: ({ target, actor, reason }) => `${target} was banned from the server${actor ? ` by ${actor}` : ''}${reason ? `. Reason: ${reason}` : '.'}`,
  member_unban: ({ target, actor }) => `${target} was unbanned${actor ? ` by ${actor}` : ''}.`,
  member_timeout: ({ target, actor, minutes }) => `${target} was timed out for ${formatMinutes(minutes)}${actor ? ` by ${actor}` : ''}.`,
  member_timeout_clear: ({ target, actor }) => `${target}'s timeout was removed${actor ? ` by ${actor}` : ''}.`,
  member_role_add: ({ target, actor, role }) => `${actor || 'Someone'} gave ${target} the ${role} role.`,
  member_role_remove: ({ target, actor, role }) => `${actor || 'Someone'} removed the ${role} role from ${target}.`,
  channel_create: ({ actor, channel }) => `${actor} created the channel #${channel}.`,
  channel_rename: ({ actor, from, channel }) => `${actor} renamed the channel #${from} to #${channel}.`,
  channel_topic: ({ actor, channel, topic }) => (topic
    ? `${actor} changed the topic of #${channel} to: ${topic}`
    : `${actor} cleared the topic of #${channel}.`),
  channel_delete: ({ actor, channel }) => `${actor} deleted the channel #${channel}.`,
  role_create: ({ actor, role }) => `${actor} created the ${role} role.`,
  role_delete: ({ actor, role }) => `${actor} deleted the ${role} role.`,
  server_rename: ({ actor, from, server }) => `${actor} renamed the server from ${from} to ${server}.`,
  category_create: ({ actor, category }) => `${actor} created the category ${category}.`,
  category_rename: ({ actor, from, category }) => `${actor} renamed the category ${from} to ${category}.`,
  category_delete: ({ actor, category }) => `${actor} deleted the category ${category}.`,
};

const SERVER_EVENT_TYPES = Object.keys(EVENT_TEXT);

function disabledEventTypes(channel) {
  try { return JSON.parse(channel.event_filter || '[]'); } catch { return []; }
}

function formatMinutes(minutes) {
  const m = Number(minutes) || 0;
  if (m >= 1440 && m % 1440 === 0) return `${m / 1440} day${m === 1440 ? '' : 's'}`;
  if (m >= 60 && m % 60 === 0) return `${m / 60} hour${m === 60 ? '' : 's'}`;
  return `${m} minute${m === 1 ? '' : 's'}`;
}

const DM_EVENT_TEXT = {
  e2ee_enabled: () => 'End-to-end encryption was enabled for this conversation.',
};

// Announcement-type channels double as a Discord-style server log: membership changes, moderation
// actions, and channel/role/server edits get auto-posted here as real (but non-editable,
// non-deletable-by-author) messages. A server can have zero, one, or several announcement
// channels — every one of them gets the event. `params` fills the text template; `actorId` (the
// moderator/admin who did it, when there is one) is credited as the message author and name.
function postServerEvent(serverId, eventType, targetUserId, params = {}, actorId = null) {
  const buildText = EVENT_TEXT[eventType];
  if (!buildText) return;
  const userName = (id) => db.prepare('SELECT display_name FROM users WHERE id = ?').get(id)?.display_name;
  const target = targetUserId ? userName(targetUserId) : null;
  if (targetUserId && !target) return;
  const actor = actorId ? userName(actorId) : null;
  const server = db.prepare('SELECT name, welcome_enabled, welcome_message FROM servers WHERE id = ?').get(serverId);
  if (!server) return;
  const greeting = server.welcome_enabled ? server.welcome_message : '';
  const content = buildText({ target, actor, server: server.name, greeting, ...params });
  const authorId = actorId || targetUserId;
  const eventData = JSON.stringify({
    target, actor, server: server.name, ...params,
    ...(eventType === 'member_greeting' && greeting ? { custom: true } : {}),
  });

  const channels = db.prepare("SELECT * FROM channels WHERE server_id = ? AND type = 'announcement'").all(serverId);
  for (const channel of channels) {
    if (disabledEventTypes(channel).includes(eventType)) continue;
    const info = db.prepare(
      'INSERT INTO messages (scope_type, scope_id, author_id, content, event_type, event_data) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('channel', channel.id, authorId, content, eventType, eventData);
    const message = serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid));
    broadcastToChannel(channel, { type: 'message_create', message });
  }

  if (eventType === 'member_join' && !db.prepare('SELECT is_bot FROM users WHERE id = ?').get(targetUserId)?.is_bot) {
    postServerEvent(serverId, 'member_greeting', targetUserId);
  }
}

function postDmEvent(dmId, eventType, actorUserId) {
  const content = DM_EVENT_TEXT[eventType]();
  const info = db.prepare(
    'INSERT INTO messages (scope_type, scope_id, author_id, content, event_type) VALUES (?, ?, ?, ?, ?)'
  ).run('dm', dmId, actorUserId, content, eventType);
  const message = serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid));
  broadcastToDm(dmId, { type: 'message_create', message });
  return message;
}

module.exports = { postServerEvent, postDmEvent, SERVER_EVENT_TYPES };
