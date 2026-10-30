import { bus } from '../bus.js';
import { api } from '../api.js';
import { state, presenceFor, getServerDetail, annotationFor } from '../state.js';
import { icons } from '../icons.js';
import { avatarHtml, escapeHtml, toast, apiErrorMessage, bannerStyle, cardStyle } from '../utils.js';
import { openModal, openContextMenu, confirmModal } from './modal.js';
import { PERMISSIONS, has, memberPermissionBits, memberNameColor } from '../permissions.js';
import { t } from '../i18n.js';
import { nextZIndex } from '../zstack.js';
import { openFullProfile } from './fullProfile.js';
import { setIgnored, confirmBlock, unblock, inviteSubmenu } from './userMenu.js';

const NAME_COLORS = ['#f04747', '#faa61a', '#43b581', '#3b82f6', '#9b59b6', '#1abc9c', '#e91e63', '#607d8b'];

// `serverId`, when the card was opened from within a server (member list, a message author's
// name), drives the "rank" line (their highest colored role there) and gates the Ban action to
// that specific server. Opened from a DM/friends context, both are simply omitted.
function openProfilePopover(anchor) {
  document.querySelectorAll('.profile-popover').forEach((n) => n._close?.());
  const el = document.createElement('div');
  el.className = 'profile-popover';
  el.style.zIndex = nextZIndex();
  el.innerHTML = `<div class="panel-loading" style="height:160px"><div class="spinner"></div></div>`;
  document.body.appendChild(el);

  const place = () => {
    const w = el.offsetWidth, h = el.offsetHeight;
    let left, top;
    if (anchor?.isConnected) {
      const r = anchor.getBoundingClientRect();
      const right = r.right + 8, leftSide = r.left - w - 8;
      const preferRight = r.left + r.width / 2 < window.innerWidth / 2;
      const fitsRight = right + w <= window.innerWidth - 8;
      const fitsLeft = leftSide >= 8;
      left = (preferRight ? fitsRight || !fitsLeft : !fitsLeft && fitsRight) ? right : leftSide;
      top = r.top;
    } else {
      left = (window.innerWidth - w) / 2;
      top = (window.innerHeight - h) / 2;
    }
    el.style.left = `${Math.max(8, Math.min(left, window.innerWidth - w - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(top, window.innerHeight - h - 8))}px`;
  };
  place();

  const onDown = (e) => { if (!el.contains(e.target) && !e.target.closest('.context-menu, .overlay')) close(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  function close() {
    el.remove();
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey);
  }
  el._close = close;
  document.addEventListener('mousedown', onDown, true);
  document.addEventListener('keydown', onKey);
  return { close, body: el, place };
}

export async function openProfileModal(userId, { serverId, anchor } = {}) {
  const m = openProfilePopover(anchor);
  const isSelf = userId === state.me.id;

  try {
    const res = await api.getUser(userId);
    const user = presenceFor(res.user);
    const status = user.status === 'invisible' ? 'offline' : (user.status || 'offline');
    const isFriend = state.friends.friends.some((f) => f.user.id === userId);
    const isPending = state.friends.pending.some((f) => f.user.id === userId);
    const isBlocked = state.friends.blocked.some((f) => f.user.id === userId);
    const rank = rankFor(serverId, userId);
    const nameColor = nameColorFor(serverId, userId);
    const mutualServers = user.mutualServers || [];

    m.body.innerHTML = `
      <div class="profile-preview" style="max-width:none;margin-top:0">
        <div class="pp-banner" style="${bannerStyle(user)}"></div>
        <div class="pp-icons-row">
          <button class="btn-icon pp-icon-btn" id="pm-more" title="${t('profile.moreTitle')}">${icons.kebab(16)}</button>
        </div>
        <div class="pp-body" style="${cardStyle(user)}">
          <div style="position:relative;width:68px">
            ${avatarHtml(user, 68).replace('class="avatar', 'class="avatar pp-avatar').replace('avatar-fallback', 'avatar-fallback pp-avatar')}
            <div class="status-dot ${status}" style="position:absolute;bottom:2px;right:-2px;width:14px;height:14px"></div>
          </div>
          <div class="pp-name" ${nameColor ? `style="color:${escapeHtml(nameColor)}"` : ''}>${escapeHtml(user.displayName)}</div>
          <div class="pp-username">@${escapeHtml(user.username)}${user.isBot ? `<span class="bot-badge">${t('bots.badge')}</span>` : ''}</div>
          ${user.customStatusText ? `<div class="pp-username">${user.customStatusEmoji ? escapeHtml(user.customStatusEmoji) + ' ' : ''}${escapeHtml(user.customStatusText)}</div>` : ''}
          ${rank ? `<div class="pp-rank" ${rank.color ? `style="color:${rank.color}"` : ''}>${icons.shield(12)} ${escapeHtml(rank.label)}</div>` : ''}
          ${mutualServers.length ? `
            <div class="pp-mutual" title="${escapeHtml(mutualServers.map((s) => s.name).join(', '))}">
              ${icons.users(13)} ${mutualServers.length} ${mutualServers.length === 1 ? t('profile.mutualServerSingular') : t('profile.mutualServerPlural')}
            </div>` : ''}
          ${user.bio !== undefined ? `<div class="pp-bio">${escapeHtml(user.bio || t('profile.noBioYet'))}</div>` : ''}
        </div>
      </div>
      ${!isSelf && user.canMessage ? `<input class="input pp-quick-dm" id="pm-quick" maxlength="2000" placeholder="${escapeHtml(t('profile.messageInputPlaceholder', { name: user.displayName }))}">` : ''}
      <div class="error-text" id="pm-err"></div>`;
    m.place();

    m.body.querySelector('#pm-quick')?.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      const input = e.currentTarget;
      const content = input.value.trim();
      if (!content) return;
      input.disabled = true;
      try {
        const dmRes = await api.openDm(userId);
        await api.sendDmMessage(dmRes.dmId, { content });
        const dmsRes = await api.listDms();
        state.dms = dmsRes.dms;
        bus.emit('state:dms');
        bus.emit('ui:navigate', { type: 'dm', dmId: dmRes.dmId });
        m.close();
      } catch (err) {
        input.disabled = false;
        m.body.querySelector('#pm-err').textContent = apiErrorMessage(err, t('profile.cantMessageError'));
      }
    });

    const openDmAction = async () => {
      try {
        const dmRes = await api.openDm(userId);
        const dmsRes = await api.listDms();
        state.dms = dmsRes.dms;
        bus.emit('state:dms');
        bus.emit('ui:navigate', { type: 'dm', dmId: dmRes.dmId });
        m.close();
      } catch (err) {
        m.body.querySelector('#pm-err').textContent = apiErrorMessage(err, t('profile.cantMessageError'));
      }
    };

    const addFriendAction = async () => {
      try {
        await api.friendRequest(user.username);
        toast(t('profile.friendRequestSent'));
        m.close();
      } catch (err) {
        m.body.querySelector('#pm-err').textContent = apiErrorMessage(err, t('profile.friendRequestError'));
      }
    };

    m.body.querySelector('#pm-more')?.addEventListener('click', (e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const card = m.body.getBoundingClientRect();
      const menuX = card.right + 210 <= window.innerWidth ? card.right + 4 : Math.max(4, card.left - 214);
      const menuY = rect.top;
      if (isSelf) {
        openContextMenu(menuX, menuY, [
          {
            label: t('profile.editProfileButton'),
            icon: icons.edit,
            onClick: async () => {
              m.close();
              const { openUserSettings } = await import('./userSettings.js');
              openUserSettings('account');
            },
          },
          { label: t('profile.viewFullProfileMenuItem'), onClick: () => { m.close(); openFullProfile(userId, { serverId }); } },
          { label: t('profile.shareProfileMenuItem'), onClick: () => shareProfile(user) },
        ]);
        return;
      }
      const ignored = !!annotationFor(userId)?.ignored;
      const items = [
        { label: t('profile.messageButton'), onClick: openDmAction },
        isPending
          ? { label: t('profile.requestPendingButton'), disabled: true }
          : !isFriend && { label: t('profile.addFriendTitle'), icon: icons.userPlus, onClick: addFriendAction },
        { label: t('profile.viewFullProfileMenuItem'), onClick: () => { m.close(); openFullProfile(userId, { serverId }); } },
        { label: t('profile.shareProfileMenuItem'), onClick: () => shareProfile(user) },
        { label: t('profile.inviteToServerMenuItem'), submenu: inviteSubmenu(user, new Set(mutualServers.map((s) => s.id))) },
        'sep',
        { label: ignored ? t('userMenu.unignore') : t('userMenu.ignore'), onClick: () => setIgnored(user, !ignored) },
        isBlocked
          ? { label: t('userMenu.unblock'), danger: true, onClick: () => unblock(user) }
          : { label: t('userMenu.block'), danger: true, onClick: () => confirmBlock(user) },
      ].filter(Boolean);
      if (canManageColor(serverId)) {
        items.push({
          label: t('profile.setNameColorMenuItem'),
          icon: icons.edit,
          onClick: () => openSetColorModal(serverId, userId, user),
        });
      }
      if (canBan(serverId)) {
        items.push({
          label: t('profile.banFromServerMenuItem'),
          icon: icons.trash,
          danger: true,
          onClick: () => confirmModal({
            title: t('profile.banMemberTitle'),
            message: t('profile.banMemberMessage', { name: escapeHtml(user.displayName) }),
            confirmLabel: t('profile.banButton'),
            onConfirm: async () => {
              try { await api.banMember(serverId, userId); toast(t('profile.memberBannedToast')); m.close(); }
              catch (err) { toast(apiErrorMessage(err), { type: 'error' }); }
            },
          }),
        });
      }
      items.push({
        label: t('profile.reportUserMenuItem'),
        icon: icons.flag,
        danger: true,
        onClick: () => openReportModal(user),
      });
      openContextMenu(menuX, menuY, items);
    });
  } catch (err) {
    m.body.innerHTML = `<p style="color:var(--danger)">${escapeHtml(apiErrorMessage(err, t('profile.loadProfileError')))}</p>`;
  }
}

function nameColorFor(serverId, userId) {
  if (!serverId) return null;
  const detail = getServerDetail(serverId);
  if (!detail) return null;
  const member = detail.members.find((m) => m.user.id === userId);
  return memberNameColor(detail.roles, member);
}

function rankFor(serverId, userId) {
  if (!serverId) return null;
  const detail = getServerDetail(serverId);
  if (!detail) return null;
  if (detail.server.owner_id === userId) return { label: t('profile.ownerRank'), color: '#f1c40f' };
  const member = detail.members.find((m) => m.user.id === userId);
  if (!member) return null;
  const colorRoles = [...detail.roles]
    .filter((r) => !r.is_default && r.color && r.color !== '#99aab5')
    .sort((a, b) => b.position - a.position);
  const topRole = colorRoles.find((r) => (member.roleIds || []).includes(r.id));
  return topRole ? { label: topRole.name, color: topRole.color } : { label: t('profile.memberRank'), color: null };
}

// A function (not a module-level constant) so the labels re-evaluate against the current
// language — see userBar.js's statusOptions() for why a plain top-level array would freeze.
function reportReasons() {
  return [
    { value: 'spam', label: t('profile.reportReasonSpam') },
    { value: 'harassment', label: t('profile.reportReasonHarassment') },
    { value: 'other', label: t('profile.reportReasonOther') },
  ];
}

export function openReportModal(user) {
  const m = openModal({
    title: t('profile.reportModalTitle', { name: user.displayName }),
    render(body) {
      body.innerHTML = `
        <p style="color:var(--text-secondary);font-size:14px;margin:0 0 16px">
          ${t('profile.reportDisclaimer')}
        </p>
        <div class="field">
          <label>${t('profile.reasonLabel')}</label>
          <select class="select" id="rp-reason">
            ${reportReasons().map((r) => `<option value="${r.value}">${escapeHtml(r.label)}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label>${t('profile.detailsLabel')} <span class="hint">${t('profile.optional')}</span></label>
          <textarea class="input textarea" id="rp-details" rows="3" maxlength="500" placeholder="${t('profile.detailsPlaceholder')}"></textarea>
        </div>
        <div class="error-text" id="rp-err"></div>`;
    },
  });
  const footer = document.createElement('div');
  footer.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;width:100%';
  footer.innerHTML = `<button class="btn btn-ghost" data-cancel>${t('common.cancel')}</button><button class="btn btn-danger" data-submit>${t('profile.submitReportButton')}</button>`;
  const footerHost = m.overlay.querySelector('.modal-footer');
  footerHost.classList.remove('hidden');
  footerHost.appendChild(footer);
  footer.querySelector('[data-cancel]').addEventListener('click', m.close);
  footer.querySelector('[data-submit]').addEventListener('click', async () => {
    const reason = m.body.querySelector('#rp-reason').value;
    const details = m.body.querySelector('#rp-details').value.trim();
    try {
      await api.fileReport({ reportedUserId: user.id, reason, details });
      toast(t('profile.reportSubmittedToast'));
      m.close();
    } catch (err) {
      m.body.querySelector('#rp-err').textContent = apiErrorMessage(err, t('profile.submitReportError'));
    }
  });
}

function canBan(serverId) {
  if (!serverId) return false;
  const detail = getServerDetail(serverId);
  if (!detail) return false;
  if (detail.server.owner_id === state.me.id) return true;
  const myMember = detail.members.find((m) => m.user.id === state.me.id);
  const bits = memberPermissionBits(detail.server, detail.roles, myMember, state.me.id);
  return has(bits, PERMISSIONS.BAN_MEMBERS);
}

function canManageColor(serverId) {
  if (!serverId) return false;
  const detail = getServerDetail(serverId);
  if (!detail) return false;
  if (detail.server.owner_id === state.me.id) return true;
  const myMember = detail.members.find((m) => m.user.id === state.me.id);
  const bits = memberPermissionBits(detail.server, detail.roles, myMember, state.me.id);
  return has(bits, PERMISSIONS.MANAGE_NICKNAMES);
}

// A per-member color override that beats their highest colored role - see permissions.js's
// memberNameColor and server/routes/servers.js's PATCH .../members/:userId/color.
function openSetColorModal(serverId, userId, user) {
  const detail = getServerDetail(serverId);
  const member = detail?.members.find((m) => m.user.id === userId);
  let selected = member?.nameColor || null;

  const m = openModal({
    title: t('profile.nameColorModalTitle', { name: user.displayName }),
    render(body) {
      body.innerHTML = `
        <div class="field">
          <label>${t('profile.colorLabel')}</label>
          <div class="color-swatch-row">
            <div class="color-swatch ${!selected ? 'selected' : ''}" data-color="" title="${t('profile.noOverrideTitle')}" style="background:transparent;border:1px dashed var(--border-subtle);display:flex;align-items:center;justify-content:center;color:var(--text-muted)">${icons.x(14)}</div>
            ${NAME_COLORS.map((c) => `<div class="color-swatch ${selected?.toLowerCase() === c.toLowerCase() ? 'selected' : ''}" data-color="${c}" style="background:${c}"></div>`).join('')}
          </div>
          <div class="hint">${t('profile.colorOverrideHint')}</div>
        </div>
        <div class="error-text" id="sc-err"></div>`;
      body.querySelectorAll('[data-color]').forEach((sw) => {
        sw.addEventListener('click', () => {
          selected = sw.dataset.color || null;
          body.querySelectorAll('[data-color]').forEach((s) => s.classList.toggle('selected', s === sw));
        });
      });
    },
  });
  const footer = document.createElement('div');
  footer.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;width:100%';
  footer.innerHTML = `<button class="btn btn-ghost" data-cancel>${t('common.cancel')}</button><button class="btn btn-primary" data-save>${t('common.save')}</button>`;
  const footerHost = m.overlay.querySelector('.modal-footer');
  footerHost.classList.remove('hidden');
  footerHost.appendChild(footer);
  footer.querySelector('[data-cancel]').addEventListener('click', m.close);
  footer.querySelector('[data-save]').addEventListener('click', async () => {
    try {
      await api.setMemberColor(serverId, userId, selected);
      m.close();
      toast(t('profile.nameColorUpdatedToast'));
    } catch (err) {
      m.body.querySelector('#sc-err').textContent = apiErrorMessage(err, t('profile.nameColorError'));
    }
  });
}

async function shareProfile(user) {
  const text = `${user.displayName} (@${user.username}) - ${location.origin}/#user=${user.id}`;
  try { await navigator.clipboard.writeText(text); toast(t('profile.profileCopiedToast')); } catch { toast(t('sidebar.couldNotCopyManual')); }
}

