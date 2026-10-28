'use strict';

const { db } = require('../db');
const { has, PERMISSIONS } = require('./permissions');
const { getChannelPermissionBits } = require('./channelAccess');
const hub = require('../socket/hub');
const { resolveChannelPref } = require('./serverPrefs');
const { isIgnoring } = require('./userMeta');

const VALID_PREFS = new Set(['all', 'mentions', 'mute']);
const SCOPE_DEFAULTS = { channel: 'mentions', dm: 'all' };
const OUTBOX_KEEP_PER_USER = 200;

// Durable copy of a notify decision already made by notifyChannelMessage/notifyDmMessage below —
// lets a client with no open WebSocket (the Android background poller) catch up via
// pollOutbox() instead of re-deriving unread state itself. Pruned per-user on every insert so
// the table can't grow unbounded for a chatty server.
function recordOutbox(userId, { scopeType, scopeId, serverId = null, serverName = null, channelName = null, message, mentioned }) {
  db.prepare(
    `INSERT INTO notifications_outbox (user_id, scope_type, scope_id, server_id, server_name, channel_name, message_json, mentioned)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(userId, scopeType, scopeId, serverId, serverName, channelName, JSON.stringify(message), mentioned ? 1 : 0);
  db.prepare(
    `DELETE FROM notifications_outbox WHERE user_id = ? AND id NOT IN (
       SELECT id FROM notifications_outbox WHERE user_id = ? ORDER BY id DESC LIMIT ?
     )`
  ).run(userId, userId, OUTBOX_KEEP_PER_USER);
  require('./pushEndpoints').wake(userId);
}

// Cursor-based catch-up read: everything newer than `sinceId` for this user, oldest first,
// capped per call. `latestId` lets the caller advance its cursor even if it received fewer than
// `limit` rows (so an empty page still moves the cursor to "caught up", not stuck at 0 forever).
function pollOutbox(userId, sinceId = 0, limit = 50) {
  const rows = db.prepare(
    'SELECT id, scope_type, scope_id, server_id, server_name, channel_name, message_json, mentioned, created_at FROM notifications_outbox WHERE user_id = ? AND id > ? ORDER BY id ASC LIMIT ?'
  ).all(userId, sinceId, limit);
  const notifications = rows.map((r) => ({
    id: r.id, scopeType: r.scope_type, scopeId: r.scope_id, serverId: r.server_id, serverName: r.server_name,
    channelName: r.channel_name, message: JSON.parse(r.message_json), mentioned: !!r.mentioned, createdAt: r.created_at,
  }));
  const maxRow = db.prepare('SELECT MAX(id) AS maxId FROM notifications_outbox WHERE user_id = ?').get(userId);
  const latestId = maxRow.maxId || sinceId;
  return { notifications, latestId };
}

function getPref(userId, scopeType, scopeId) {
  let row = db.prepare('SELECT pref, muted_until FROM notification_prefs WHERE user_id = ? AND scope_type = ? AND scope_id = ?')
    .get(userId, scopeType, scopeId);
  if (row && row.pref === 'mute' && row.muted_until && Date.parse(row.muted_until) <= Date.now()) row = null;
  if (scopeType === 'channel') {
    const channel = db.prepare('SELECT server_id FROM channels WHERE id = ?').get(scopeId);
    if (channel) return resolveChannelPref(userId, channel.server_id, row && row.pref, SCOPE_DEFAULTS.channel);
  }
  return row ? row.pref : SCOPE_DEFAULTS[scopeType];
}

// `mutedUntil` only means something for pref 'mute': a timed mute lapses back to the default.
function setPref(userId, scopeType, scopeId, pref, mutedUntil = null) {
  if (!VALID_PREFS.has(pref)) throw new Error('invalid pref');
  db.prepare(
    `INSERT INTO notification_prefs (user_id, scope_type, scope_id, pref, muted_until) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, scope_type, scope_id) DO UPDATE SET pref = excluded.pref, muted_until = excluded.muted_until`
  ).run(userId, scopeType, scopeId, pref, pref === 'mute' ? mutedUntil : null);
}

// Matches @username, @role-name, @everyone, and @here tokens against a candidate set (the
// audience who could plausibly see this message) — a plain regex match against ALL usernames
// site-wide would let someone get notified by typing a stranger's name in an unrelated server
// they're not even in. Role names are matched with the same [a-zA-Z0-9_.]{3,32} token shape as
// usernames — there's no rich-text composer/autocomplete here to unambiguously delimit a role
// name containing spaces in plain text, so a multi-word role can't be @-mentioned this way.
function parseMentions(content, { candidateUsers = [], roles = [] } = {}) {
  const userIds = new Set();
  const roleIds = new Set();
  let everyone = false;
  let here = false;
  const re = /@([a-zA-Z0-9_.]{3,32})/g;
  let m;
  while ((m = re.exec(content))) {
    const token = m[1];
    if (token.toLowerCase() === 'everyone') { everyone = true; continue; }
    if (token.toLowerCase() === 'here') { here = true; continue; }
    const u = candidateUsers.find((c) => c.username.toLowerCase() === token.toLowerCase());
    if (u) { userIds.add(u.id); continue; }
    const r = roles.find((role) => role.name.toLowerCase() === token.toLowerCase());
    if (r) roleIds.add(r.id);
  }
  return { userIds: [...userIds], roleIds: [...roleIds], everyone, here };
}

function notifyChannelMessage(channel, message, mentions) {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(channel.server_id);
  if (!server) return;
  const members = db.prepare('SELECT user_id FROM server_members WHERE server_id = ?').all(channel.server_id);
  // Only queried when a role was actually mentioned — avoids a member_roles scan on every
  // ordinary message that doesn't @-mention a role.
  let roleMemberIds = new Set();
  if (mentions.roleIds.length) {
    const placeholders = mentions.roleIds.map(() => '?').join(',');
    roleMemberIds = new Set(
      db.prepare(`SELECT user_id FROM member_roles WHERE server_id = ? AND role_id IN (${placeholders})`)
        .all(channel.server_id, ...mentions.roleIds).map((r) => r.user_id)
    );
  }
  for (const m of members) {
    if (m.user_id === message.author.id) continue;
    if (isIgnoring(m.user_id, message.author.id)) continue;
    if (!has(getChannelPermissionBits(channel, m.user_id), PERMISSIONS.VIEW_CHANNEL)) continue;
    const pref = getPref(m.user_id, 'channel', channel.id);
    const mentioned = mentions.userIds.includes(m.user_id)
      || mentions.everyone
      || (mentions.here && hub.isOnline(m.user_id))
      || roleMemberIds.has(m.user_id);
    if (pref === 'mute') continue;
    if (pref === 'mentions' && !mentioned) continue;
    hub.notifyUser(m.user_id, {
      type: 'notify', scopeType: 'channel', scopeId: channel.id, serverId: channel.server_id,
      serverName: server.name, channelName: channel.name, message, mentioned,
    });
    recordOutbox(m.user_id, {
      scopeType: 'channel', scopeId: channel.id, serverId: channel.server_id,
      serverName: server.name, channelName: channel.name, message, mentioned,
    });
  }
}

// Ciphertext must never become a preview: an encrypted DM notifies with a generic text and no
// reply/embed context; a foregrounded client may swap in its own locally decrypted text.
function redactEncrypted(message) {
  return { ...message, content: `New encrypted message from ${message.author.displayName}`, embed: null, replyTo: null };
}

function notifyDmMessage(dm, rawMessage) {
  const message = dm.e2ee_enabled || rawMessage.isEncrypted ? redactEncrypted(rawMessage) : rawMessage;
  const members = db.prepare('SELECT user_id FROM dm_members WHERE dm_channel_id = ?').all(dm.id);
  // A conversation someone "closed" comes back to their list as soon as anything new is said.
  db.prepare('UPDATE dm_prefs SET hidden = 0 WHERE dm_id = ? AND hidden = 1').run(dm.id);
  for (const m of members) {
    if (m.user_id === message.author.id) continue;
    if (isIgnoring(m.user_id, message.author.id)) continue;
    const pref = getPref(m.user_id, 'dm', dm.id);
    if (pref === 'mute') continue;
    hub.notifyUser(m.user_id, { type: 'notify', scopeType: 'dm', scopeId: dm.id, message, mentioned: true });
    recordOutbox(m.user_id, { scopeType: 'dm', scopeId: dm.id, message, mentioned: true });
  }
}

module.exports = { recordOutbox, getPref, setPref, parseMentions, notifyChannelMessage, notifyDmMessage, pollOutbox, VALID_PREFS };
