import { api } from '../../js/api.js';
import { t } from '../../js/i18n.js';
import { escapeHtml, avatarHtml, toast } from '../../js/utils.js';
import { state, setFriends, presenceFor } from '../../js/state.js';
import { handleError } from '../lib/errors.js';
import { openDmWith } from '../lib/dmOpen.js';
import { openSheet } from '../components/bottomSheet.js';

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
  openSheet({
    html: `<div class="m-profile">
        <div class="m-profile-avatar">${avatarHtml(user, 72)}</div>
        <div class="m-profile-name">${escapeHtml(user.displayName)}</div>
        <div class="m-profile-user">@${escapeHtml(user.username)}${user.customStatusText ? ` · ${escapeHtml(user.customStatusText)}` : ''}</div>
        ${user.bio ? `<p class="m-profile-bio">${escapeHtml(user.bio)}</p>` : ''}
        ${self ? '' : `<div class="m-profile-actions">
          <button class="btn btn-primary" data-a="dm">${t('m.sendMessage')}</button>
          ${rel === 'none' ? `<button class="btn btn-secondary" data-a="add">${t('m.addFriend')}</button>` : ''}
          ${rel === 'pending-incoming' ? `<button class="btn btn-secondary" data-a="accept">${t('m.accept')}</button>` : ''}
          ${rel === 'friend' ? `<button class="btn btn-secondary" data-a="remove">${t('m.removeFriend')}</button>` : ''}
          ${rel === 'blocked' ? `<button class="btn btn-secondary" data-a="remove">${t('m.unblockUser')}</button>` : `<button class="btn btn-danger" data-a="block">${t('m.blockUser')}</button>`}
        </div>`}</div>`,
    onMount: (body, close) => body.addEventListener('click', async (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (!a) return;
      try {
        if (a === 'dm') { close(); await openDmWith(userId); return; }
        if (a === 'add') { await api.friendRequest(user.username); toast(t('m.friendRequestSent')); }
        if (a === 'accept') await api.friendAccept(userId);
        if (a === 'remove') await api.friendRemove(userId);
        if (a === 'block') await api.friendBlock(userId);
        setFriends(await api.friends());
        close();
      } catch (err) { handleError(err); }
    }),
  });
}
