'use strict';

const { db } = require('../db');
const { PERMISSIONS, OWNER_PERMISSIONS } = require('./permissions');

function getMemberRoleIds(serverId, userId) {
  const isMember = db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(serverId, userId);
  if (!isMember) return [];

  const everyone = db.prepare('SELECT id FROM roles WHERE server_id = ? AND is_default = 1').get(serverId);
  const rows = db.prepare('SELECT role_id FROM member_roles WHERE server_id = ? AND user_id = ?').all(serverId, userId);
  const ids = rows.map((r) => r.role_id);
  if (everyone) ids.push(everyone.id);
  return ids;
}

// A "pending" member joined a server that has membership screening on and has not accepted its
// rules yet: they may look around but not take part (see routes/onboarding.js).
function isPendingMember(serverId, userId) {
  const row = db.prepare('SELECT s.screening_enabled AS enabled, sm.screened_at AS screened FROM servers s JOIN server_members sm ON sm.server_id = s.id WHERE s.id = ? AND sm.user_id = ?').get(serverId, userId);
  return !!row && row.enabled === 1 && row.screened === null;
}

// Aggregate (OR) permission bits across every role a member holds, including @everyone.
function getMemberPermissionBits(serverId, userId) {
  const server = db.prepare('SELECT owner_id FROM servers WHERE id = ?').get(serverId);
  if (!server) return 0;
  if (server.owner_id === userId) return OWNER_PERMISSIONS;

  const roleIds = getMemberRoleIds(serverId, userId);
  if (roleIds.length === 0) return 0;
  const placeholders = roleIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT permissions FROM roles WHERE id IN (${placeholders})`).all(...roleIds);
  const bits = rows.reduce((acc, r) => acc | r.permissions, 0);
  return isPendingMember(serverId, userId) ? bits & PERMISSIONS.VIEW_CHANNEL : bits;
}

// Effective bits for one channel: base role bits, then per-role allow/deny overrides
// (applied in ascending role position so higher-ranked roles win last), then channel-type rules.
function getChannelPermissionBits(channel, userId) {
  const server = db.prepare('SELECT owner_id FROM servers WHERE id = ?').get(channel.server_id);
  if (server && server.owner_id === userId) return OWNER_PERMISSIONS;
  // A leftover channel_user_overrides row (e.g. from a redeemed channel invite) must never outlive membership.
  if (!db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(channel.server_id, userId)) return 0;

  let bits = getMemberPermissionBits(channel.server_id, userId);
  if (bits & PERMISSIONS.ADMINISTRATOR) return bits;

  const roleIds = getMemberRoleIds(channel.server_id, userId);
  let hasExplicitViewAllow = false;
  if (roleIds.length > 0) {
    const placeholders = roleIds.map(() => '?').join(',');
    const overrides = db.prepare(
      `SELECT cro.allow, cro.deny
         FROM channel_role_overrides cro
         JOIN roles r ON r.id = cro.role_id
        WHERE cro.channel_id = ? AND cro.role_id IN (${placeholders})
        ORDER BY r.position ASC`
    ).all(channel.id, ...roleIds);
    for (const o of overrides) {
      bits = (bits & ~o.deny) | o.allow;
      if (o.allow & PERMISSIONS.VIEW_CHANNEL) hasExplicitViewAllow = true;
    }
  }

  // Per-user override (e.g. redeemed a channel invite) applies on top of role overrides, so it
  // can grant access a role alone wouldn't.
  const userOverride = db.prepare('SELECT allow, deny FROM channel_user_overrides WHERE channel_id = ? AND user_id = ?').get(channel.id, userId);
  if (userOverride) {
    bits = (bits & ~userOverride.deny) | userOverride.allow;
    if (userOverride.allow & PERMISSIONS.VIEW_CHANNEL) hasExplicitViewAllow = true;
  }

  const isModPlus = (bits & (PERMISSIONS.MANAGE_CHANNELS | PERMISSIONS.MANAGE_MESSAGES | PERMISSIONS.ADMINISTRATOR)) !== 0;

  if (channel.type === 'private' && !hasExplicitViewAllow && !isModPlus) {
    bits &= ~PERMISSIONS.VIEW_CHANNEL;
  }
  if ((channel.type === 'announcement' || channel.type === 'readonly') && !isModPlus) {
    bits &= ~PERMISSIONS.SEND_MESSAGES;
  }
  // Stage channels have no text chat at all, mods included (matches Discord — the client never
  // renders a composer for one either, this is just the server-side backstop).
  if (channel.type === 'stage') {
    bits &= ~PERMISSIONS.SEND_MESSAGES;
  }

  // Channel overrides can grant more than the base roles do; a pending member still only gets to look.
  return isPendingMember(channel.server_id, userId) ? bits & PERMISSIONS.VIEW_CHANNEL : bits;
}

function canAccessChannel(channel, userId, flag) {
  const bits = getChannelPermissionBits(channel, userId);
  return (bits & PERMISSIONS.ADMINISTRATOR) !== 0 || (bits & flag) === flag;
}

function removeMember(serverId, userId) {
  db.prepare('DELETE FROM channel_user_overrides WHERE user_id = ? AND channel_id IN (SELECT id FROM channels WHERE server_id = ?)').run(userId, serverId);
  db.prepare('DELETE FROM server_members WHERE server_id = ? AND user_id = ?').run(serverId, userId);
}

module.exports = { getMemberRoleIds, getMemberPermissionBits, getChannelPermissionBits, canAccessChannel, removeMember, isPendingMember };
