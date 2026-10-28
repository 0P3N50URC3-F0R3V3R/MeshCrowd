import { bus } from '../bus.js';
import { state, presenceFor } from '../state.js';
import { icons } from '../icons.js';
import { avatarHtml, escapeHtml } from '../utils.js';
import { memberNameColor } from '../permissions.js';
import { memberRoleIcon, roleIconHtml } from '../roleIcon.js';
import { t } from '../i18n.js';

// Renders the right-hand member list for the current server, grouped by highest-position
// colored role (falls back to Online/Offline). Re-renders on presence + member-role WS events.
// `onClose`, when given, adds a header with an X button - the same in-panel close affordance the
// pinned/search/threads panels sharing this slot already have, alongside the header's own
// open/close toggle button.
export function mountMemberList(container, { server, roles, members }, { onClose } = {}) {
  render();

  const offPresence = bus.on('state:presence', render);
  const offVoice = bus.on('state:serverVoice', render);
  const offClick = () => container.removeEventListener('click', onClick);
  container.addEventListener('click', onClick);

  function render() {
    const withPresence = members.map((m) => ({ ...m, user: presenceFor(m.user) }));
    const groups = groupMembers(withPresence, roles);
    const header = onClose
      ? `<div class="pinned-panel-head"><h3>${t('memberList.heading')}</h3><button class="btn-icon" id="member-list-close" title="${t('common.close')}">${icons.x(16)}</button></div>`
      : '';
    container.innerHTML = header + (groups.map((g) => `
      <div class="member-group-label" ${g.color ? `style="color:${escapeHtml(g.color)}"` : ''}>${escapeHtml(g.label)} — ${g.members.length}</div>
      ${g.members.map((m) => renderMember(m, server, roles)).join('')}
    `).join('') || `<div class="member-group-label">${t('memberList.noMembers')}</div>`);
    container.querySelector('#member-list-close')?.addEventListener('click', () => onClose?.());
  }

  function onClick(e) {
    const target = e.target.closest('[data-user]');
    if (target) bus.emit('ui:openProfile', { userId: Number(target.dataset.user), serverId: server?.id });
  }

  function destroy() {
    offPresence();
    offVoice();
    offClick();
  }

  return { destroy };
}

function groupMembers(members, roles) {
  const colorRoles = [...roles]
    .filter((r) => !r.is_default && r.color && r.color !== '#99aab5')
    .sort((a, b) => b.position - a.position);

  const buckets = new Map(); // label -> {members, order}
  const online = [];
  const offline = [];

  for (const m of members) {
    const status = m.user.status;
    const isOffline = status === 'offline' || status === 'invisible' || !status;
    if (isOffline) { offline.push(m); continue; }

    const topRole = colorRoles.find((r) => (m.roleIds || []).includes(r.id));
    if (topRole) {
      if (!buckets.has(topRole.name)) buckets.set(topRole.name, { members: [], order: topRole.position, color: topRole.color });
      buckets.get(topRole.name).members.push(m);
    } else {
      online.push(m);
    }
  }

  const sortMembers = (arr) => arr.sort((a, b) => (a.nickname || a.user.displayName).localeCompare(b.nickname || b.user.displayName));

  const groups = [...buckets.entries()]
    .sort((a, b) => b[1].order - a[1].order)
    .map(([label, g]) => ({ label, members: sortMembers(g.members), color: g.color }));

  if (online.length) groups.push({ label: t('memberList.online'), members: sortMembers(online) });
  if (offline.length) groups.push({ label: t('memberList.offline'), members: sortMembers(offline) });
  return groups;
}

function renderMember(m, server, roles) {
  const u = m.user;
  const status = u.status === 'invisible' ? 'offline' : (u.status || 'offline');
  const isOffline = status === 'offline';
  const name = m.nickname || u.displayName;
  const isOwner = server && (server.owner_id === u.id || server.ownerId === u.id);
  const color = memberNameColor(roles, m);
  return `
    <div class="member-item ${isOffline ? 'offline' : ''}" data-user="${u.id}">
      <div class="avatar-wrap">
        ${avatarHtml(u, 32)}
        <div class="status-dot ${status}" style="width:10px;height:10px"></div>
      </div>
      <div class="m-meta">
        <div class="m-name" ${color ? `style="color:${escapeHtml(color)}"` : ''}>${isOwner ? '👑 ' : ''}${escapeHtml(name)}${roleIconHtml(memberRoleIcon(roles, m))}${u.isBot ? `<span class="bot-badge">${t('bots.badge')}</span>` : ''}</div>
        ${u.customStatusText ? `<div class="m-status">${u.customStatusEmoji ? escapeHtml(u.customStatusEmoji) + ' ' : ''}${escapeHtml(u.customStatusText)}</div>` : ''}
      </div>
      ${state.serverVoice.has(u.id) ? `<span class="m-in-call" title="${t('memberList.inVoiceChannel')}">${icons.headphones(14)}</span>` : ''}
    </div>`;
}
