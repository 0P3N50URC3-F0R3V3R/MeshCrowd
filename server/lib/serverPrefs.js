'use strict';

const { db } = require('../db');

const LEVELS = new Set(['all', 'mentions', 'mute']);
const FOREVER = '9999-12-31T00:00:00.000Z';

const toPublic = (r) => ({
  serverId: r.server_id,
  notifLevel: r.notif_level,
  mutedUntil: r.muted_until,
  hideMutedChannels: !!r.hide_muted_channels,
  showAllChannels: !!r.show_all_channels,
  allowDms: !!r.allow_dms,
});

function getServerPref(userId, serverId) {
  return db.prepare('SELECT * FROM server_prefs WHERE user_id = ? AND server_id = ?').get(userId, serverId) || null;
}

function listServerPrefs(userId) {
  return db.prepare('SELECT * FROM server_prefs WHERE user_id = ?').all(userId).map(toPublic);
}

function isMutedNow(row, now = Date.now()) {
  return !!row?.muted_until && Date.parse(row.muted_until) > now;
}

// `patch` keys: notifLevel (level | null), mutedUntil (ISO | null), hideMutedChannels,
// showAllChannels, allowDms. Absent keys keep their stored value.
function setServerPref(userId, serverId, patch) {
  const cur = getServerPref(userId, serverId) || { notif_level: null, muted_until: null, hide_muted_channels: 0, show_all_channels: 1, allow_dms: 1 };
  const next = {
    notif_level: 'notifLevel' in patch ? patch.notifLevel : cur.notif_level,
    muted_until: 'mutedUntil' in patch ? patch.mutedUntil : cur.muted_until,
    hide_muted_channels: 'hideMutedChannels' in patch ? (patch.hideMutedChannels ? 1 : 0) : cur.hide_muted_channels,
    show_all_channels: 'showAllChannels' in patch ? (patch.showAllChannels ? 1 : 0) : cur.show_all_channels,
    allow_dms: 'allowDms' in patch ? (patch.allowDms ? 1 : 0) : cur.allow_dms,
  };
  db.prepare(
    `INSERT INTO server_prefs (user_id, server_id, notif_level, muted_until, hide_muted_channels, show_all_channels, allow_dms)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, server_id) DO UPDATE SET notif_level = excluded.notif_level, muted_until = excluded.muted_until,
       hide_muted_channels = excluded.hide_muted_channels, show_all_channels = excluded.show_all_channels, allow_dms = excluded.allow_dms`
  ).run(userId, serverId, next.notif_level, next.muted_until, next.hide_muted_channels, next.show_all_channels, next.allow_dms);
  return toPublic({ server_id: serverId, ...next });
}

// Servers `userId` is in where DMs from members are switched off.
function dmClosedServerIds(userId) {
  return new Set(db.prepare('SELECT server_id FROM server_prefs WHERE user_id = ? AND allow_dms = 0').all(userId).map((r) => r.server_id));
}

// A mute on the server silences every channel; otherwise a channel's own setting wins, and only a
// channel with no setting inherits the server-wide level.
function resolveChannelPref(userId, serverId, explicit, fallback) {
  const row = getServerPref(userId, serverId);
  if (isMutedNow(row)) return 'mute';
  if (explicit) return explicit;
  return (row && row.notif_level) || fallback;
}

module.exports = { LEVELS, FOREVER, getServerPref, listServerPrefs, setServerPref, isMutedNow, dmClosedServerIds, resolveChannelPref };
