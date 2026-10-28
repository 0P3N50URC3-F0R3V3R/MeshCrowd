'use strict';

// Discord-style bitflag permission set. Keep bits < 31 (safe in JS 32-bit bitwise ops).
const PERMISSIONS = {
  VIEW_CHANNEL:      1 << 0,
  SEND_MESSAGES:      1 << 1,
  MANAGE_MESSAGES:    1 << 2,  // delete/pin others' messages
  MANAGE_CHANNELS:    1 << 3,
  MANAGE_ROLES:       1 << 4,
  MANAGE_SERVER:      1 << 5,
  KICK_MEMBERS:       1 << 6,
  BAN_MEMBERS:        1 << 7,
  CREATE_INVITE:      1 << 8,
  CHANGE_NICKNAME:    1 << 9,
  MANAGE_NICKNAMES:   1 << 10,
  ATTACH_FILES:       1 << 11,
  ADMINISTRATOR:      1 << 12,
  VIEW_AUDIT_LOG:     1 << 13,
  MODERATE_MEMBERS:   1 << 14,  // timeout members, set channel slowmode
  PRUNE_CONTENT:      1 << 15,  // bulk-delete this server's own channel history before a cutoff date
  MANAGE_BOTS:        1 << 16,  // create/edit/delete this server's AI bots
};

const DEFAULT_EVERYONE_PERMISSIONS =
  PERMISSIONS.VIEW_CHANNEL |
  PERMISSIONS.SEND_MESSAGES |
  PERMISSIONS.CREATE_INVITE |
  PERMISSIONS.CHANGE_NICKNAME |
  PERMISSIONS.ATTACH_FILES;

const OWNER_PERMISSIONS = Object.values(PERMISSIONS).reduce((a, b) => a | b, 0);

function has(permissionBits, flag) {
  if (permissionBits & PERMISSIONS.ADMINISTRATOR) return true;
  return (permissionBits & flag) === flag;
}

// Separate bitflag namespace for global site staff ranks (Owner/Admin/Moderator/custom).
const SITE_PERMISSIONS = {
  VIEW_ADMIN_PANEL:     1 << 0,
  MANAGE_USERS:         1 << 1,  // disable/enable accounts, edit any profile
  MANAGE_SITE_ROLES:    1 << 2,  // create/edit/assign staff ranks
  DELETE_ANY_MESSAGE:   1 << 3,
  MANAGE_ANY_SERVER:    1 << 4,  // delete/transfer any server on the instance
  SITE_ADMINISTRATOR:   1 << 5,  // bypasses all site permission checks
  MANAGE_REPORTS:       1 << 6,  // view/resolve the user-report moderation queue
  PRUNE_DATA:           1 << 7,  // bulk-delete any server's channel history, or any DM/group by date (never message content)
  MANAGE_AI:            1 << 8,  // configure AI providers, manage AI bots on any server
};

const OWNER_SITE_PERMISSIONS = Object.values(SITE_PERMISSIONS).reduce((a, b) => a | b, 0);

function hasSite(permissionBits, flag) {
  if (permissionBits & SITE_PERMISSIONS.SITE_ADMINISTRATOR) return true;
  return (permissionBits & flag) === flag;
}

module.exports = {
  PERMISSIONS, DEFAULT_EVERYONE_PERMISSIONS, OWNER_PERMISSIONS, has,
  SITE_PERMISSIONS, OWNER_SITE_PERMISSIONS, hasSite,
};
