import { bus } from '../bus.js';
import { api } from '../api.js';
import { state, presenceFor, annotationFor } from '../state.js';
import { icons } from '../icons.js';
import { avatarHtml, escapeHtml, toast, apiErrorMessage, bannerStyle, cardStyle } from '../utils.js';
import { openModal, openContextMenu } from './modal.js';
import { t } from '../i18n.js';
import { openDmWith, openNoteModal, userActionItems, confirmRemoveFriend } from './userMenu.js';
import { openProfileModal, openReportModal } from './profile.js';

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');

// The large profile view (left card + tabs on the right). The compact popover in profile.js links
// here through "View full profile".
export async function openFullProfile(userId, { serverId } = {}) {
  if (userId === state.me.id) {
    const { openUserSettings } = await import('./userSettings.js');
    openUserSettings('account');
    return;
  }
  const offs = [];
  const m = openModal({
    title: t('fullProfile.modalTitle'),
    wide: true,
    onClose: () => offs.forEach((off) => off()),
    render(body) { body.innerHTML = '<div class="panel-loading" style="height:200px"><div class="spinner"></div></div>'; },
  });
  m.overlay.querySelector('.modal')?.classList.add('full-profile-modal');

  let user;
  try {
    user = (await api.getUser(userId)).user;
  } catch (err) {
    m.body.innerHTML = `<p style="color:var(--danger)">${escapeHtml(apiErrorMessage(err, t('profile.loadProfileError')))}</p>`;
    return;
  }
  let tab = 'activity';
  draw();
  offs.push(bus.on('state:annotations', (id) => { if (id === userId) draw(); }), bus.on('state:friends', draw));

  function draw() {
    if (!m.body.isConnected) return;
    const live = presenceFor(user);
    const status = live.status === 'invisible' ? 'offline' : (live.status || 'offline');
    const ann = annotationFor(userId);
    const friend = state.friends.friends.some((f) => f.user.id === userId);
    const pending = state.friends.pending.some((f) => f.user.id === userId);
    const mutualFriends = user.mutualFriends || [];
    const mutualServers = user.mutualServers || [];
    const shownName = ann?.nickname || user.displayName;

    m.body.innerHTML = `
      <div class="fp-layout">
        <div class="fp-card">
          <div class="fp-banner" style="${bannerStyle(live)}"></div>
          <div class="fp-card-body" style="${cardStyle(live)}">
            <div class="fp-avatar-wrap">
              ${avatarHtml(live, 80)}
              <div class="status-dot ${status}" style="position:absolute;bottom:2px;right:-2px;width:18px;height:18px"></div>
            </div>
            <div class="fp-name">${escapeHtml(shownName)}</div>
            <div class="fp-username">@${escapeHtml(user.username)}${ann?.nickname ? ` &middot; ${escapeHtml(user.displayName)}` : ''}</div>
            ${live.customStatusText ? `<div class="fp-status">${live.customStatusEmoji ? `${escapeHtml(live.customStatusEmoji)} ` : ''}${escapeHtml(live.customStatusText)}</div>` : ''}
            <div class="fp-actions">
              <button class="btn btn-primary" id="fp-message">${icons.messageSquare(16)} ${t('profile.messageButton')}</button>
              ${friend
                ? `<button class="btn-icon fp-icon-btn" id="fp-friend" title="${t('fullProfile.friendsTitle')}">${icons.users(16)}</button>`
                : pending
                  ? `<button class="btn-icon fp-icon-btn" disabled title="${t('profile.requestPendingButton')}">${icons.userPlus(16)}</button>`
                  : `<button class="btn-icon fp-icon-btn" id="fp-add" title="${t('profile.addFriendTitle')}">${icons.userPlus(16)}</button>`}
              <button class="btn-icon fp-icon-btn" id="fp-more" title="${t('profile.moreTitle')}">${icons.kebab(16)}</button>
            </div>
            ${live.bio ? `<div class="fp-field"><div class="fp-field-label">${t('fullProfile.aboutLabel')}</div><div>${escapeHtml(live.bio)}</div></div>` : ''}
            <div class="fp-field"><div class="fp-field-label">${t('fullProfile.memberSince')}</div><div>${escapeHtml(fmtDate(user.createdAt))}</div></div>
            ${user.friendsSince ? `<div class="fp-field"><div class="fp-field-label">${t('fullProfile.friendsSince')}</div><div>${escapeHtml(fmtDate(user.friendsSince))}</div></div>` : ''}
            <div class="fp-field">
              <div class="fp-field-label">${t('fullProfile.noteLabel')}</div>
              <div class="fp-note ${ann?.note ? '' : 'empty'}" id="fp-note" tabindex="0">${ann?.note ? escapeHtml(ann.note) : t('fullProfile.notePlaceholder')}</div>
            </div>
          </div>
        </div>
        <div class="fp-main">
          <div class="friends-tabs fp-tabs">
            <button class="friends-tab ${tab === 'activity' ? 'active' : ''}" data-tab="activity">${t('fullProfile.tabActivity')}</button>
            <button class="friends-tab ${tab === 'friends' ? 'active' : ''}" data-tab="friends">${mutualFriends.length ? t('fullProfile.tabMutualFriends', { count: mutualFriends.length }) : t('fullProfile.tabNoMutualFriends')}</button>
            <button class="friends-tab ${tab === 'servers' ? 'active' : ''}" data-tab="servers">${mutualServers.length ? t('fullProfile.tabMutualServers', { count: mutualServers.length }) : t('fullProfile.tabNoMutualServers')}</button>
          </div>
          <div class="fp-tab-body">${tabBody(live, mutualFriends, mutualServers)}</div>
        </div>
      </div>`;

    m.body.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.tab; draw(); }));
    m.body.querySelector('#fp-message').addEventListener('click', () => { m.close(); openDmWith(userId); });
    m.body.querySelector('#fp-message-2')?.addEventListener('click', () => { m.close(); openDmWith(userId); });
    m.body.querySelector('#fp-note').addEventListener('click', () => openNoteModal(user));
    m.body.querySelector('#fp-add')?.addEventListener('click', async () => {
      try { await api.friendRequest(user.username); toast(t('profile.friendRequestSent')); } catch (err) { toast(apiErrorMessage(err, t('profile.friendRequestError')), { type: 'error' }); }
    });
    m.body.querySelector('#fp-friend')?.addEventListener('click', (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      openContextMenu(r.left, r.bottom + 4, [{ label: t('userMenu.removeFriend'), danger: true, onClick: () => confirmRemoveFriend(user) }]);
    });
    m.body.querySelector('#fp-more').addEventListener('click', (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      const items = userActionItems(user, { openProfile: () => {}, withMessage: false, withCall: true }).slice(1);
      items.push({ label: t('profile.reportUserMenuItem'), danger: true, onClick: () => openReportModal(user) });
      openContextMenu(r.left, r.bottom + 4, items);
    });
    m.body.querySelectorAll('[data-open-user]').forEach((row) => row.addEventListener('click', () => { m.close(); openProfileModal(Number(row.dataset.openUser), { serverId }); }));
    m.body.querySelectorAll('[data-open-server]').forEach((row) => row.addEventListener('click', () => { m.close(); bus.emit('ui:navigate', { type: 'server', serverId: Number(row.dataset.openServer) }); }));
  }

  function tabBody(live, mutualFriends, mutualServers) {
    if (tab === 'friends') {
      return mutualFriends.length
        ? mutualFriends.map((u) => `<div class="list-row" data-open-user="${u.id}" style="cursor:pointer">${avatarHtml(u, 36)}<div class="lr-main"><div class="lr-title">${escapeHtml(u.displayName)}</div><div class="lr-sub">@${escapeHtml(u.username)}</div></div></div>`).join('')
        : `<div class="empty-state"><p>${t('fullProfile.noMutualFriends')}</p></div>`;
    }
    if (tab === 'servers') {
      return mutualServers.length
        ? mutualServers.map((s) => `<div class="list-row" data-open-server="${s.id}" style="cursor:pointer"><div class="avatar-fallback" style="width:36px;height:36px">${escapeHtml(s.name.slice(0, 1).toUpperCase())}</div><div class="lr-main"><div class="lr-title">${escapeHtml(s.name)}</div></div></div>`).join('')
        : `<div class="empty-state"><p>${t('fullProfile.noMutualServers')}</p></div>`;
    }
    return `<div class="empty-state"><h3>${t('fullProfile.noActivityTitle', { name: escapeHtml(live.displayName) })}</h3><p>${t('fullProfile.noActivityBody', { name: escapeHtml(live.displayName) })}</p>
      <button class="btn btn-secondary" id="fp-message-2">${icons.messageSquare(16)} ${t('profile.messageButton')}</button></div>`;
  }
}
