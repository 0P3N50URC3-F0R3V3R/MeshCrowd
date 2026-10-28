import { api } from '../../js/api.js';
import { icons } from '../../js/icons.js';
import { t } from '../../js/i18n.js';
import { escapeHtml, avatarHtml, debounce } from '../../js/utils.js';
import { state, setDms } from '../../js/state.js';
import { nav } from '../router.js';
import { handleError } from '../lib/errors.js';
import { promptSheet } from '../components/bottomSheet.js';

export function mountNewMessage(el) {
  const picked = new Map(); // userId -> user
  let results = state.friends.friends.map((f) => f.user);
  el.innerHTML = `<div class="m-header"><button class="m-icon-btn" id="m-back">${icons.arrowLeft(22)}</button><h1>${t('m.newMessageTitle')}</h1>
      <button class="btn btn-primary" id="m-go" disabled>${t('m.startChat')}</button></div>
    <div class="m-searchbar"><input class="m-input" id="m-q" type="search" autocomplete="off" placeholder="${t('m.findPeoplePh')}"></div>
    <div class="m-chips" id="m-chips"></div>
    <div class="m-scroll" id="m-people"></div>`;
  const chips = el.querySelector('#m-chips');
  const people = el.querySelector('#m-people');
  const go = el.querySelector('#m-go');
  el.querySelector('#m-back').addEventListener('click', () => nav.back());

  function paint() {
    chips.innerHTML = [...picked.values()].map((u) => `<span class="m-file-chip">${escapeHtml(u.displayName)}<button data-rm="${u.id}">${icons.x(12)}</button></span>`).join('');
    people.innerHTML = results.length ? results.map((u) => `
      <button class="m-row" data-uid="${u.id}">${avatarHtml(u, 40)}<span class="m-grow"><b>${escapeHtml(u.displayName)}</b><small>@${escapeHtml(u.username)}</small></span>
        ${picked.has(u.id) ? icons.check(20) : ''}</button>`).join('') : `<div class="m-empty">${t('m.noResults')}</div>`;
    go.disabled = picked.size === 0;
  }
  people.addEventListener('click', (e) => {
    const row = e.target.closest('[data-uid]');
    if (!row) return;
    const u = results.find((x) => x.id === Number(row.dataset.uid));
    if (picked.has(u.id)) picked.delete(u.id); else picked.set(u.id, u);
    paint();
  });
  chips.addEventListener('click', (e) => { const b = e.target.closest('[data-rm]'); if (b) { picked.delete(Number(b.dataset.rm)); paint(); } });
  el.querySelector('#m-q').addEventListener('input', debounce(async (e) => {
    const q = e.target.value.trim();
    if (q.length < 2) { results = state.friends.friends.map((f) => f.user); paint(); return; }
    try { results = (await api.searchUsers(q)).users; paint(); } catch (err) { handleError(err); }
  }, 250));
  go.addEventListener('click', async () => {
    const ids = [...picked.keys()];
    go.disabled = true;
    try {
      let dmId;
      if (ids.length === 1) ({ dmId } = await api.openDm(ids[0]));
      else {
        const name = (await promptSheet({ title: t('m.newGroup'), placeholder: t('m.groupNamePh'), okLabel: t('m.startChat') })) ?? '';
        ({ dmId } = await api.openGroupDm(ids, name));
      }
      setDms((await api.listDms()).dms);
      nav.replace('chat', { kind: 'dm', dmId });
    } catch (err) { handleError(err); go.disabled = false; }
  });
  paint();
}
