import { api } from '../../js/api.js';
import { bus } from '../../js/bus.js';
import { icons } from '../../js/icons.js';
import { t } from '../../js/i18n.js';
import { avatarHtml, escapeHtml, formatTimestamp } from '../../js/utils.js';
import { nav } from '../router.js';
import { handleError } from '../lib/errors.js';
import { promptSheet } from '../components/bottomSheet.js';

export function mountThreads(el, params) {
  let threads = [];
  el.innerHTML = `<div class="m-header"><button class="m-icon-btn" id="m-back">${icons.arrowLeft(22)}</button>
    <h1>${t('m.threads')}</h1><button class="m-icon-btn" id="m-new" aria-label="${t('m.threadCreate')}">${icons.plus(22)}</button></div>
    <div class="m-scroll" id="m-list"><div class="m-empty">${t('m.loading')}</div></div>`;
  const list = el.querySelector('#m-list');
  el.querySelector('#m-back').addEventListener('click', () => nav.back());

  function paint() {
    list.innerHTML = threads.length ? threads.map((th) => `
      <button class="m-row m-thread${th.archived ? ' archived' : ''}" data-tid="${th.id}">
        <span class="m-chan-icon">${th.iconPath ? `<img class="m-chan-img" src="${escapeHtml(th.iconPath)}" alt="">` : avatarHtml(th.createdBy, 28)}</span>
        <span class="m-grow"><b>${escapeHtml(th.title)}</b><small>${th.archived ? `${t('m.threadArchived')} · ` : ''}${th.messageCount} · ${escapeHtml(formatTimestamp(th.lastMessageAt))}</small></span>
        ${icons.chevronRight(18)}</button>`).join('') : `<div class="m-empty">${t('m.noThreads')}</div>`;
  }
  async function load() {
    try { threads = (await api.listThreads(params.serverId, params.channelId)).threads; paint(); } catch (err) { handleError(err, 'm.loadFailed'); }
  }
  list.addEventListener('click', (e) => {
    const row = e.target.closest('[data-tid]');
    if (row) nav.push('chat', { kind: 'thread', serverId: params.serverId, channelId: params.channelId, threadId: Number(row.dataset.tid) });
  });
  el.querySelector('#m-new').addEventListener('click', async () => {
    const title = await promptSheet({ title: t('m.threadCreate'), placeholder: t('m.threadTitlePh'), okLabel: t('m.threadCreate') });
    if (!title) return;
    try {
      const res = await api.createThread(params.serverId, params.channelId, { title: title.slice(0, 100), content: title });
      nav.push('chat', { kind: 'thread', serverId: params.serverId, channelId: params.channelId, threadId: res.thread.id });
    } catch (err) { handleError(err); }
  });
  const offs = ['thread_create', 'thread_update'].map((ev) => bus.on(`ws:${ev}`, (p) => { if (p.channelId === params.channelId) load(); }));
  offs.push(bus.on('ws:thread_delete', (p) => { if (p.channelId === params.channelId) load(); }));
  load();
  return { destroy: () => offs.forEach((off) => off()), onShow: load };
}
