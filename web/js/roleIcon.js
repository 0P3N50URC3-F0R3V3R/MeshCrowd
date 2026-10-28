import { escapeHtml } from './utils.js';

// The icon of a member's highest-position role that has one (an emoji or an uploaded image).
// Only that one is shown next to the name, so a member with many roles stays readable.
export function memberRoleIcon(roles, member) {
  if (!member || !roles) return null;
  const ids = member.roleIds || [];
  const top = [...roles]
    .filter((r) => !r.is_default && (r.icon_path || r.icon_emoji) && ids.includes(r.id))
    .sort((a, b) => b.position - a.position)[0];
  return top ? { name: top.name, path: top.icon_path || null, emoji: top.icon_path ? null : top.icon_emoji } : null;
}

export function roleIconHtml(icon) {
  if (!icon) return '';
  const title = escapeHtml(icon.name);
  return icon.path
    ? `<img class="role-icon" src="${escapeHtml(icon.path)}" alt="" title="${title}">`
    : `<span class="role-icon role-icon-emoji" title="${title}">${escapeHtml(icon.emoji)}</span>`;
}
