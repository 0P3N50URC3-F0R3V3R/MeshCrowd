// Mirrors server/lib/permissions.js bitflags. Client-side checks are advisory UI only —
// the server is the source of truth and every mutating call handles 403 gracefully.

export const PERMISSIONS = {
  VIEW_CHANNEL: 1 << 0,
  SEND_MESSAGES: 1 << 1,
  MANAGE_MESSAGES: 1 << 2,
  MANAGE_CHANNELS: 1 << 3,
  MANAGE_ROLES: 1 << 4,
  MANAGE_SERVER: 1 << 5,
  KICK_MEMBERS: 1 << 6,
  BAN_MEMBERS: 1 << 7,
  CREATE_INVITE: 1 << 8,
  CHANGE_NICKNAME: 1 << 9,
  MANAGE_NICKNAMES: 1 << 10,
  ATTACH_FILES: 1 << 11,
  ADMINISTRATOR: 1 << 12,
  VIEW_AUDIT_LOG: 1 << 13,
  MODERATE_MEMBERS: 1 << 14,
  PRUNE_CONTENT: 1 << 15,
  MANAGE_BOTS: 1 << 16,
};

export const PERMISSION_INFO = [
  { flag: PERMISSIONS.VIEW_CHANNEL, key: 'viewChannel', name: 'View Channel', desc: 'See this channel in the sidebar and read its messages.' },
  { flag: PERMISSIONS.SEND_MESSAGES, key: 'sendMessages', name: 'Send Messages', desc: 'Post messages in text channels.' },
  { flag: PERMISSIONS.MANAGE_MESSAGES, key: 'manageMessages', name: 'Manage Messages', desc: "Delete other members' messages." },
  { flag: PERMISSIONS.MANAGE_CHANNELS, key: 'manageChannels', name: 'Manage Channels', desc: 'Create, edit and delete channels.' },
  { flag: PERMISSIONS.MANAGE_ROLES, key: 'manageRoles', name: 'Manage Roles', desc: 'Create, edit roles and assign them to members.' },
  { flag: PERMISSIONS.MANAGE_SERVER, key: 'manageServer', name: 'Manage Server', desc: 'Rename the server and change its icon.' },
  { flag: PERMISSIONS.KICK_MEMBERS, key: 'kickMembers', name: 'Kick Members', desc: 'Remove members from the server.' },
  { flag: PERMISSIONS.BAN_MEMBERS, key: 'banMembers', name: 'Ban Members', desc: 'Permanently ban members from the server.' },
  { flag: PERMISSIONS.CREATE_INVITE, key: 'createInvite', name: 'Create Invite', desc: "See and regenerate the server's invite code." },
  { flag: PERMISSIONS.CHANGE_NICKNAME, key: 'changeNickname', name: 'Change Nickname', desc: 'Change your own nickname in this server.' },
  { flag: PERMISSIONS.MANAGE_NICKNAMES, key: 'manageNicknames', name: 'Manage Nicknames', desc: "Change other members' nicknames." },
  { flag: PERMISSIONS.ATTACH_FILES, key: 'attachFiles', name: 'Attach Files', desc: 'Upload files and images to messages.' },
  { flag: PERMISSIONS.ADMINISTRATOR, key: 'administrator', name: 'Administrator', desc: 'Bypasses every permission check on the server.' },
  { flag: PERMISSIONS.VIEW_AUDIT_LOG, key: 'viewAuditLog', name: 'View Audit Log', desc: "See the server's moderation/change history." },
  { flag: PERMISSIONS.MODERATE_MEMBERS, key: 'moderateMembers', name: 'Moderate Members', desc: 'Time out members and set channel slowmode.' },
  { flag: PERMISSIONS.PRUNE_CONTENT, key: 'pruneData', name: 'Prune Data', desc: "Bulk-delete this server's own channel history before a cutoff date, to free up space." },
  { flag: PERMISSIONS.MANAGE_BOTS, key: 'manageBots', name: 'Manage Bots', desc: "Create, edit and delete this server's AI bots." },
];

export const SITE_PERMISSIONS = {
  VIEW_ADMIN_PANEL: 1 << 0,
  MANAGE_USERS: 1 << 1,
  MANAGE_SITE_ROLES: 1 << 2,
  DELETE_ANY_MESSAGE: 1 << 3,
  MANAGE_ANY_SERVER: 1 << 4,
  SITE_ADMINISTRATOR: 1 << 5,
  MANAGE_REPORTS: 1 << 6,
  PRUNE_DATA: 1 << 7,
  MANAGE_AI: 1 << 8,
};

export const SITE_PERMISSION_INFO = [
  { flag: SITE_PERMISSIONS.VIEW_ADMIN_PANEL, key: 'viewAdminPanel', name: 'View Admin Panel', desc: 'Access the site admin panel at all.' },
  { flag: SITE_PERMISSIONS.MANAGE_USERS, key: 'manageUsers', name: 'Manage Users', desc: 'Disable/enable accounts and view all users.' },
  { flag: SITE_PERMISSIONS.MANAGE_SITE_ROLES, key: 'manageSiteRoles', name: 'Manage Site Roles', desc: 'Create, edit and assign staff ranks.' },
  { flag: SITE_PERMISSIONS.DELETE_ANY_MESSAGE, key: 'deleteAnyMessage', name: 'Delete Any Message', desc: 'Delete any message on the instance.' },
  { flag: SITE_PERMISSIONS.MANAGE_ANY_SERVER, key: 'manageAnyServer', name: 'Manage Any Server', desc: 'Delete or transfer any server on the instance.' },
  { flag: SITE_PERMISSIONS.SITE_ADMINISTRATOR, key: 'siteAdministrator', name: 'Site Administrator', desc: 'Bypasses every site permission check.' },
  { flag: SITE_PERMISSIONS.MANAGE_REPORTS, key: 'manageReports', name: 'Manage Reports', desc: 'View and resolve the user-report moderation queue.' },
  { flag: SITE_PERMISSIONS.PRUNE_DATA, key: 'pruneData', name: 'Prune Data', desc: 'Bulk-delete any server’s channel history, or any DM/group by date, to free up space. Never exposes DM/group content.' },
  { flag: SITE_PERMISSIONS.MANAGE_AI, key: 'manageAI', name: 'Manage AI', desc: 'Configure AI providers and manage AI bots on any server.' },
];

export function has(bits, flag) {
  if (bits & PERMISSIONS.ADMINISTRATOR) return true;
  return (bits & flag) === flag;
}

export function hasSite(bits, flag) {
  if (bits & SITE_PERMISSIONS.SITE_ADMINISTRATOR) return true;
  return (bits & flag) === flag;
}

// Aggregate permission bits for a member across every role they hold (server owner => all bits).
export function memberPermissionBits(server, roles, member, viewerId) {
  if (server.owner_id === viewerId || server.ownerId === viewerId) {
    return Object.values(PERMISSIONS).reduce((a, b) => a | b, 0);
  }
  if (!member) return 0;
  const roleIds = new Set(member.roleIds || []);
  let bits = 0;
  for (const role of roles) {
    if (role.is_default || roleIds.has(role.id)) bits |= role.permissions;
  }
  return bits;
}

// Effective bits for one channel given already-aggregated member bits (client-side approximation
// of server/lib/channelAccess.js — good enough for showing/hiding UI; server enforces for real).
export function channelPermissionBits(channel, roles, member, memberBits, isOwner) {
  if (isOwner) return Object.values(PERMISSIONS).reduce((a, b) => a | b, 0);
  if (memberBits & PERMISSIONS.ADMINISTRATOR) return memberBits;

  let bits = memberBits;
  const roleIds = new Set([...(member?.roleIds || [])]);
  const everyone = roles.find((r) => r.is_default);
  if (everyone) roleIds.add(everyone.id);

  const overrides = (channel.overrides || [])
    .filter((o) => roleIds.has(o.role_id))
    .sort((a, b) => (roleOrder(roles, a.role_id) - roleOrder(roles, b.role_id)));
  let explicitView = false;
  for (const o of overrides) {
    bits = (bits & ~o.deny) | o.allow;
    if (o.allow & PERMISSIONS.VIEW_CHANNEL) explicitView = true;
  }

  const isModPlus = (bits & (PERMISSIONS.MANAGE_CHANNELS | PERMISSIONS.MANAGE_MESSAGES | PERMISSIONS.ADMINISTRATOR)) !== 0;
  if (channel.type === 'private' && !explicitView && !isModPlus) bits &= ~PERMISSIONS.VIEW_CHANNEL;
  if ((channel.type === 'announcement' || channel.type === 'readonly') && !isModPlus) bits &= ~PERMISSIONS.SEND_MESSAGES;
  return bits;
}

function roleOrder(roles, id) {
  const r = roles.find((x) => x.id === id);
  return r ? r.position : 0;
}

// A member's per-member color override (server/routes/servers.js's name_color column) beats
// their highest-position colored role, which beats no color at all. Used anywhere a member's
// name is rendered - chat messages, the member list, profile cards.
export function memberNameColor(roles, member) {
  if (!member) return null;
  if (member.nameColor) return member.nameColor;
  const colorRoles = [...roles]
    .filter((r) => !r.is_default && r.color && r.color !== '#99aab5')
    .sort((a, b) => b.position - a.position);
  const topRole = colorRoles.find((r) => (member.roleIds || []).includes(r.id));
  return topRole ? topRole.color : null;
}
