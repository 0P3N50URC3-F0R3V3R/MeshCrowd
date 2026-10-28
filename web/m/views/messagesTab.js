import { api } from '../../js/api.js';
import { bus } from '../../js/bus.js';
import { icons } from '../../js/icons.js';
import { t } from '../../js/i18n.js';
import { escapeHtml, avatarHtml, formatShortTime, toast } from '../../js/utils.js';
import {
  state, isUnread, nameFor, dmPrefFor, setDmPrefs, setReadState, setNotificationPref as setPrefState, notificationPrefFor, presenceFor,
} from '../../js/state.js';
import { peekPlaintext } from '../../js/e2ee/dmCrypto.js';
import { nav } from '../router.js';
import { handleError } from '../lib/errors.js';
import { onLongPress } from '../lib/longPress.js';
import { dmPreview, dmTitle } from '../lib/dmPreview.mjs';
import { actionSheet, confirmSheet, promptSheet } from '../components/bottomSheet.js';

export function mountMessagesTab(host) {
  let filter = '';
  host.innerHTML = `
    <div class="m-page-head">
      <div class="m-page-title">${t('m.messagesTitle')}</div>
      <button class="m-icon-btn" id="m-friends" aria-label="${t('m.friends')}">${icons.users(22)}</button>
      <button class="btn btn-secondary m-pill" id="m-addfriend">${icons.plus(14)} ${t('m.addFriend')}</button>
    </div>
    <div class="m-searchbar"><input class="m-input" id="m-filter" type="search" enterkeyhint="search" placeholder="${t('m.searchConversations')}"></div>
    <div class="m-scroll" id="m-dm-list"></div>
    <button class="m-fab" id="m-new">${icons.messageSquare(18)} ${t('m.newMessage')}</button>`;
  const list = host.querySelector('#m-dm-list');

  const sorted = () => state.dms
    .filter((d) => !dmPrefFor(d.id).hidden)
    .filter((d) => !filter || dmTitle(d, nameFor).toLowerCase().includes(filter))
    .sort((a, b) => (Number(dmPrefFor(b.id).pinned) - Number(dmPrefFor(a.id).pinned)) || ((b.lastMessage?.id || 0) - (a.lastMessage?.id || 0)));

  function paint() {
    const dms = sorted();
    list.innerHTML = dms.length ? dms.map((d) => {
      const unread = isUnread('dm', d.id, d.lastMessage?.id);
      const who = d.members[0];
      const status = d.isGroup ? '' : `<i class="m-status s-${escapeHtml(presenceFor(who)?.status || 'offline')}"></i>`;
      return `<button class="m-row m-dm${unread ? ' unread' : ''}" data-dm="${d.id}">
        <span class="m-dm-avatar">${avatarHtml(d.isGroup ? { id: d.id, displayName: dmTitle(d, nameFor) } : who, 44)}${status}</span>
        <span class="m-grow"><b>${escapeHtml(dmTitle(d, nameFor))}</b>
          <small>${d.e2eeEnabled ? `${icons.lock(11)} ` : ''}${escapeHtml(dmPreview(d, { peek: (id) => peekPlaintext(state.me.id, id), encryptedLabel: t('m.dmPreviewEncrypted'), attachmentLabel: t('m.dmPreviewAttachment') }))}</small></span>
        <span class="m-dm-meta">${d.lastMessage ? `<small>${formatShortTime(d.lastMessage.createdAt)}</small>` : ''}${unread ? '<i class="m-dot"></i>' : ''}</span></button>`;
    }).join('') : `<div class="m-empty">${t('m.noDms')}</div>`;
  }

  list.addEventListener('click', (e) => {
    const row = e.target.closest('[data-dm]');
    if (row) nav.push('chat', { kind: 'dm', dmId: Number(row.dataset.dm) });
  });
  onLongPress(list, '[data-dm]', async (row) => {
    const d = state.dms.find((x) => x.id === Number(row.dataset.dm));
    if (!d) return;
    const pinned = dmPrefFor(d.id).pinned;
    const muted = notificationPrefFor('dm', d.id) === 'mute';
    const id = await actionSheet({ title: dmTitle(d, nameFor), items: [
      { id: 'pin', icon: icons.pin(20), label: pinned ? t('m.actUnpin') : t('m.actPin') },
      { id: 'read', icon: icons.check(20), label: t('m.markRead') },
      { id: 'mute', icon: icons.bell(20), label: muted ? t('m.unmute') : t('m.mute') },
      d.isGroup && { id: 'leave', icon: icons.x(20), label: t('m.leaveServer'), danger: true },
    ].filter(Boolean) });
    try {
      if (id === 'pin') { await api.setDmPref(d.id, { pinned: !pinned }); setDmPrefs((await api.getDmPrefs()).prefs); bus.emit('state:dms'); }
      else if (id === 'read' && d.lastMessage) { setReadState('dm', d.id, d.lastMessage.id); api.markRead('dm', d.id, d.lastMessage.id).catch(() => {}); }
      else if (id === 'mute') { const pref = muted ? 'all' : 'mute'; await api.setNotificationPref('dm', d.id, pref); setPrefState('dm', d.id, pref); }
      else if (id === 'leave' && await confirmSheet(t('m.leaveConfirm'), { okLabel: t('m.leaveServer') })) await api.leaveDm(d.id);
    } catch (err) { handleError(err); }
  });

  host.querySelector('#m-filter').addEventListener('input', (e) => { filter = e.target.value.trim().toLowerCase(); paint(); });
  host.querySelector('#m-new').addEventListener('click', () => nav.push('newMessage'));
  host.querySelector('#m-friends').addEventListener('click', () => nav.push('friends'));
  host.querySelector('#m-addfriend').addEventListener('click', async () => {
    const username = await promptSheet({ title: t('m.addFriend'), placeholder: t('m.friendUsernamePh'), okLabel: t('m.send') });
    if (!username) return;
    try { await api.friendRequest(username); toast(t('m.friendRequestSent')); } catch (err) { handleError(err); }
  });

  const offs = ['state:dms', 'state:readState', 'state:presence'].map((ev) => bus.on(ev, paint));
  paint();
  return { destroy: () => offs.forEach((off) => off()) };
}
