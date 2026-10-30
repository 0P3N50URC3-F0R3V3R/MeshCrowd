import { api } from '../../js/api.js';
import { t } from '../../js/i18n.js';
import { escapeHtml, avatarHtml, toast } from '../../js/utils.js';
import { state, setFriends, setDms, presenceFor } from '../../js/state.js';
import { icons } from '../../js/icons.js';
import { nav } from '../router.js';
import { handleError } from '../lib/errors.js';
import { openDmWith } from '../lib/dmOpen.js';
import { openSheet, actionSheet } from '../components/bottomSheet.js';

function relation(userId) {
  if (state.friends.friends.some((f) => f.user.id === userId)) return 'friend';
  if (state.friends.blocked.some((f) => f.user.id === userId)) return 'blocked';
  const p = state.friends.pending.find((f) => f.user.id === userId);
  return p ? `pending-${p.direction}` : 'none';
}

export async function openProfileSheet(userId) {
  let user;
  try { user = presenceFor((await api.getUser(userId)).user); } catch (err) { handleError(err, 'm.loadFailed'); return; }
  const self = userId === state.me.id;
  const rel = relation(userId);
  const items = self ? [] : [
    { id: 'dm', label: t('m.sendMessage') },
    ...(rel === 'none' ? [{ id: 'add', label: t('m.addFriend') }] : []),
    ...(rel === 'pending-incoming' ? [{ id: 'accept', label: t('m.accept') }] : []),
    ...(rel === 'friend' ? [{ id: 'remove', label: t('m.removeFriend') }] : []),
    rel === 'blocked' ? { id: 'unblock', label: t('m.unblockUser') } : { id: 'block', label: t('m.blockUser'), danger: true },
    { id: 'report', label: t('m.actReport'), danger: true },
  ];

  async function run(a) {
    try {
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
        ${self ? '' : `<button class="btn-icon m-profile-more" data-more title="${t('profile.moreTitle')}">${icons.kebab(20)}</button>`}
        <div class="m-profile-avatar">${avatarHtml(user, 72)}</div>
        <div class="m-profile-name">${escapeHtml(user.displayName)}</div>
        <div class="m-profile-user">@${escapeHtml(user.username)}${user.customStatusText ? ` · ${escapeHtml(user.customStatusText)}` : ''}</div>
        ${user.bio ? `<p class="m-profile-bio">${escapeHtml(user.bio)}</p>` : ''}
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
