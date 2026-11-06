import { api } from '../../js/api.js';
import { t } from '../../js/i18n.js';
import { renderBio } from '../../js/bioMarkup.mjs';
import { escapeHtml, avatarHtml, customStatusLabel, toast, bannerStyle, cardStyle, initials } from '../../js/utils.js';
import { rankFor, nameColorFor } from '../../js/views/profile.js';
import { state, setFriends, setDms, presenceFor } from '../../js/state.js';
import { icons } from '../../js/icons.js';
import { nav } from '../router.js';
import { handleError } from '../lib/errors.js';
import { openEditProfile } from '../lib/editProfile.js';
import { openDmWith } from '../lib/dmOpen.js';
import { openSheet, actionSheet } from '../components/bottomSheet.js';

function relation(userId) {
  if (state.friends.friends.some((f) => f.user.id === userId)) return 'friend';
  if (state.friends.blocked.some((f) => f.user.id === userId)) return 'blocked';
  const p = state.friends.pending.find((f) => f.user.id === userId);
  return p ? `pending-${p.direction}` : 'none';
}

export async function openProfileSheet(userId, { asStranger = false, serverId = null } = {}) {
  let user;
  asStranger = asStranger && userId === state.me.id;
  try { user = asStranger ? (await api.getUser(userId, { as: 'stranger' })).user : presenceFor((await api.getUser(userId)).user); } catch (err) { handleError(err, 'm.loadFailed'); return; }
  const self = userId === state.me.id;
  const rel = relation(userId);
  const status = user.status === 'invisible' ? 'offline' : (user.status || 'offline');
  const rank = rankFor(serverId, userId);
  const nameColor = nameColorFor(serverId, userId);
  const mutualServers = user.mutualServers || [];
  const items = self ? [{ id: 'edit', label: t('profile.editProfileButton') }, { id: 'stranger', label: t('profile.viewAsStrangerMenuItem') }] : [
    { id: 'dm', label: t('m.sendMessage') },
    ...(rel === 'none' ? [{ id: 'add', label: t('m.addFriend') }] : []),
    ...(rel === 'pending-incoming' ? [{ id: 'accept', label: t('m.accept') }] : []),
    ...(rel === 'friend' ? [{ id: 'remove', label: t('m.removeFriend') }] : []),
    rel === 'blocked' ? { id: 'unblock', label: t('m.unblockUser') } : { id: 'block', label: t('m.blockUser'), danger: true },
    { id: 'report', label: t('m.actReport'), danger: true },
  ];

  async function run(a) {
    try {
      if (a === 'edit') { openEditProfile(); return; }
      if (a === 'stranger') { await openProfileSheet(userId, { asStranger: true, serverId }); return; }
      if (a === 'dm') { await openDmWith(userId); return; }
      if (a === 'report') {
        const reason = await actionSheet({ title: t('m.actReport'), items: [
          { id: 'spam', label: t('m.reportReasonSpam') }, { id: 'harassment', label: t('m.reportReasonHarassment') }, { id: 'other', label: t('m.reportReasonOther') },
        ] });
        if (!reason) return;
        await api.fileReport({ reportedUserId: userId, reason });
        toast(t('m.reportSent'));
        return;
      }
      if (a === 'add') { await api.friendRequest(user.username); toast(t('m.friendRequestSent')); }
      if (a === 'accept') await api.friendAccept(userId);
      if (a === 'remove' || a === 'unblock') await api.friendRemove(userId);
      if (a === 'block') await api.friendBlock(userId);
      setFriends(await api.friends());
    } catch (err) { handleError(err); }
  }

  openSheet({
    html: `<div class="m-profile">
        <div class="profile-preview m-profile-card" style="max-width:none;margin-top:0;text-align:left">
          <div class="pp-banner" style="${bannerStyle(user)}"></div>
          ${asStranger ? '' : `<div class="pp-icons-row"><button class="btn-icon pp-icon-btn" data-more title="${t('profile.moreTitle')}">${icons.kebab(20)}</button></div>`}
          <div class="pp-body" style="${cardStyle(user)}">
            <div style="position:relative;width:68px">
              ${avatarHtml(user, 68).replace('class="avatar', 'class="avatar pp-avatar').replace('avatar-fallback', 'avatar-fallback pp-avatar')}
              <div class="status-dot ${status}" style="position:absolute;bottom:2px;right:-2px;width:14px;height:14px"></div>
            </div>
            <div class="pp-name" ${nameColor ? `style="color:${escapeHtml(nameColor)}"` : ''}>${escapeHtml(user.displayName)}</div>
            <div class="pp-username">@${escapeHtml(user.username)}${user.isBot ? `<span class="bot-badge">${t('bots.badge')}</span>` : ''}</div>
            ${customStatusLabel(user) ? `<div class="pp-username">${escapeHtml(customStatusLabel(user))}</div>` : ''}
            ${rank ? `<div class="pp-rank" ${rank.color ? `style="color:${rank.color}"` : ''}>${icons.shield(12)} ${escapeHtml(rank.label)}</div>` : ''}
            ${mutualServers.length ? `<div class="pp-mutual">${icons.users(13)} ${mutualServers.length} ${mutualServers.length === 1 ? t('profile.mutualServerSingular') : t('profile.mutualServerPlural')}
              <span class="pp-ms-icons">${mutualServers.slice(0, 8).map((s) => `<span class="pp-ms" title="${escapeHtml(s.name)}">${s.icon_path ? `<img src="${escapeHtml(s.icon_path)}" alt="">` : escapeHtml(initials(s.name))}</span>`).join('')}${mutualServers.length > 8 ? `<span class="pp-ms-more">+${mutualServers.length - 8}</span>` : ''}</span></div>` : ''}
            ${user.bio !== undefined ? `<div class="pp-bio">${user.bio ? renderBio(user.bio) : escapeHtml(t('profile.noBioYet'))}</div>` : ''}
          </div>
        </div>
        ${asStranger ? `<p class="m-profile-bio"><i>${escapeHtml(t('profile.viewingAsStranger'))}</i></p>` : ''}
        ${!self && user.canMessage ? `<input class="input m-profile-quick" maxlength="2000" enterkeyhint="send" placeholder="${escapeHtml(t('profile.messageInputPlaceholder', { name: user.displayName }))}">` : ''}</div>`,
    onMount: (body, close) => {
      body.querySelector('[data-more]')?.addEventListener('click', async () => {
        close();
        const a = await actionSheet({ items });
        if (a) await run(a);
      });
      body.querySelector('.m-profile-quick')?.addEventListener('keydown', async (e) => {
        if (e.key !== 'Enter' || e.isComposing) return;
        const input = e.currentTarget;
        const content = input.value.trim();
        if (!content) return;
        input.disabled = true;
        try {
          const { dmId } = await api.openDm(userId);
          await api.sendDmMessage(dmId, { content });
          setDms((await api.listDms()).dms);
          close();
          nav.push('chat', { kind: 'dm', dmId });
        } catch (err) { input.disabled = false; handleError(err); }
      });
    },
  });
}
