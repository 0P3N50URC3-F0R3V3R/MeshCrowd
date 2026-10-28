import { api } from '../../js/api.js';
import { bus } from '../../js/bus.js';
import { icons } from '../../js/icons.js';
import { t } from '../../js/i18n.js';
import { escapeHtml, avatarHtml, toast } from '../../js/utils.js';
import { state, setFriends, presenceFor } from '../../js/state.js';
import { nav } from '../router.js';
import { handleError } from '../lib/errors.js';
import { openDmWith } from '../lib/dmOpen.js';
import { promptSheet } from '../components/bottomSheet.js';
import { openProfileSheet } from './profileSheet.js';

export function mountFriends(el) {
  el.innerHTML = `<div class="m-header"><button class="m-icon-btn" id="m-back">${icons.arrowLeft(22)}</button><h1>${t('m.friends')}</h1>
    <button class="m-icon-btn" id="m-add" aria-label="${t('m.addFriend')}">${icons.plus(22)}</button></div><div class="m-scroll" id="m-fl"></div>`;
  const box = el.querySelector('#m-fl');
  el.querySelector('#m-back').addEventListener('click', () => nav.back());

  const row = (f, actions) => `<div class="m-row" data-uid="${f.user.id}">${avatarHtml(f.user, 40)}
    <span class="m-grow"><b>${escapeHtml(f.user.displayName)}</b><small>@${escapeHtml(f.user.username)}</small></span>${actions}</div>`;
  const btn = (a, icon, label) => `<button class="m-icon-btn" data-a="${a}" aria-label="${label}">${icon}</button>`;

  function paint() {
    const f = state.friends;
    const online = f.friends.filter((x) => (presenceFor(x.user).status || 'offline') !== 'offline');
    const offline = f.friends.filter((x) => !online.includes(x));
    const section = (key, n, rows) => (n ? `<div class="m-section">${t(key, { n })}</div>${rows}` : '');
    box.innerHTML = section('m.friendsPending', f.pending.length, f.pending.map((x) => row(x, x.direction === 'incoming'
      ? btn('accept', icons.check(20), t('m.accept')) + btn('remove', icons.x(20), t('m.decline'))
      : btn('remove', icons.x(20), t('m.cancel')))).join(''))
      + section('m.friendsOnline', online.length, online.map((x) => row(x, btn('dm', icons.messageSquare(20), t('m.sendMessage')))).join(''))
      + section('m.friendsOffline', offline.length, offline.map((x) => row(x, btn('dm', icons.messageSquare(20), t('m.sendMessage')))).join(''))
      + section('m.friendsBlocked', f.blocked.length, f.blocked.map((x) => row(x, btn('remove', icons.x(20), t('m.unblockUser')))).join(''))
      || `<div class="m-empty">${t('m.noFriends')}</div>`;
  }

  box.addEventListener('click', async (e) => {
    const rowEl = e.target.closest('[data-uid]');
    if (!rowEl) return;
    const id = Number(rowEl.dataset.uid);
    const a = e.target.closest('[data-a]')?.dataset.a;
    try {
      if (a === 'dm') return openDmWith(id);
      if (a === 'accept') await api.friendAccept(id);
      else if (a === 'remove') await api.friendRemove(id);
      else return openProfileSheet(id);
      setFriends(await api.friends());
    } catch (err) { handleError(err); }
  });
  el.querySelector('#m-add').addEventListener('click', async () => {
    const username = await promptSheet({ title: t('m.addFriend'), placeholder: t('m.friendUsernamePh'), okLabel: t('m.send') });
    if (!username) return;
    try { await api.friendRequest(username); toast(t('m.friendRequestSent')); setFriends(await api.friends()); } catch (err) { handleError(err); }
  });
  const offs = ['state:friends', 'state:presence'].map((ev) => bus.on(ev, paint));
  paint();
  return { destroy: () => offs.forEach((off) => off()) };
}
