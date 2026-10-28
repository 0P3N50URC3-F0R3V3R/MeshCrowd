import { api } from '../../js/api.js';
import { icons } from '../../js/icons.js';
import { t } from '../../js/i18n.js';
import { escapeHtml, avatarHtml, formatBytes } from '../../js/utils.js';
import { state, nameFor, notificationPrefFor, setNotificationPref as setPrefState } from '../../js/state.js';
import { nav } from '../router.js';
import { ensureServerDetail } from '../data.js';
import { handleError } from '../lib/errors.js';
import { dmTitle, messageText } from '../lib/dmPreview.mjs';
import { collectItems } from '../lib/infoItems.mjs';
import { openImageViewer } from '../components/bottomSheet.js';
import { decryptMessages } from '../../js/e2ee/dmCrypto.js';
import { openProfileSheet } from './profileSheet.js';

const TABS = [['members', 'm.infoMembers'], ['media', 'm.infoMedia'], ['links', 'm.infoLinks'], ['files', 'm.infoFiles'], ['pins', 'm.infoPins']];

export function mountInfo(el, params) {
  const kind = params.kind;
  const scopeType = kind;
  const scopeId = kind === 'dm' ? params.dmId : kind === 'thread' ? params.threadId : params.channelId;
  let tab = 'members';
  let items = null;
  let pins = null;
  let members = [];
  const dm = kind === 'dm' ? state.dms.find((d) => d.id === params.dmId) : null;
  const encrypted = !!dm?.e2eeEnabled;

  el.innerHTML = `<div class="m-header"><button class="m-icon-btn" id="m-back">${icons.arrowLeft(22)}</button><h1 id="m-title"></h1></div>
    <div class="m-info-actions" id="m-qa"></div><div class="m-tabs" id="m-tabs"></div><div class="m-scroll" id="m-pane"></div>`;
  el.querySelector('#m-back').addEventListener('click', () => nav.back());
  const pane = el.querySelector('#m-pane');

  function paintTabs() {
    el.querySelector('#m-tabs').innerHTML = TABS.map(([id, key]) => `<button class="m-tabchip${id === tab ? ' active' : ''}" data-t="${id}">${t(key)}</button>`).join('');
  }
  function paintQuick() {
    const prefScope = kind === 'dm' ? 'dm' : 'channel';
    const muted = notificationPrefFor(prefScope, kind === 'dm' ? params.dmId : params.channelId) === 'mute';
    el.querySelector('#m-qa').innerHTML = `
      <button class="m-qa" data-q="search">${icons.search(22)}<span>${t('m.searchAction')}</span></button>
      <button class="m-qa" data-q="pins">${icons.pin(22)}<span>${t('m.infoPins')}</span></button>
      ${kind === 'thread' ? '' : `<button class="m-qa" data-q="mute">${icons.bell(22)}<span>${muted ? t('m.unmute') : t('m.mute')}</span></button>`}`;
  }

  async function loadItems() {
    if (items) return;
    if (encrypted) { items = { media: [], files: [], links: [] }; return; }
    let all = [];
    let before;
    for (let i = 0; i < 4; i += 1) {
      const q = { limit: 50, before };
      const res = kind === 'dm' ? await api.listDmMessages(params.dmId, q)
        : kind === 'thread' ? await api.listThreadMessages(params.serverId, params.channelId, params.threadId, q)
          : await api.listChannelMessages(params.serverId, params.channelId, q);
      if (!res.messages.length) break;
      all = all.concat(res.messages);
      before = Math.min(...res.messages.map((m) => m.id));
      if (res.messages.length < 50) break;
    }
    items = collectItems(all);
  }

  async function paintPane() {
    paintTabs();
    const none = `<div class="m-empty">${t('m.infoNone')}</div>`;
    try {
      if (tab === 'members') {
        pane.innerHTML = members.map((u) => `<button class="m-row" data-u="${u.id}">${avatarHtml(u, 40)}<span class="m-grow"><b>${escapeHtml(nameFor(u))}</b><small>@${escapeHtml(u.username)}</small></span></button>`).join('') || none;
      } else if (tab === 'pins') {
        if (!pins) {
          pins = (await api.listPins(scopeType, scopeId)).messages;
          if (encrypted) await decryptMessages(dm, state.me, pins);
        }
        pane.innerHTML = pins.map((m) => `<div class="m-row"><span class="m-grow"><b>${escapeHtml(m.author.displayName)}</b><small>${escapeHtml(messageText(m, t('m.decryptFailed')))}</small></span></div>`).join('') || none;
      } else {
        await loadItems();
        if (tab === 'media') {
          pane.innerHTML = items.media.length ? `<div class="m-media-grid">${items.media.map((m) => (m.mimeType.startsWith('image/')
            ? `<button class="m-media-cell" data-v="${escapeHtml(m.url)}"><img src="${escapeHtml(m.url)}" alt="" loading="lazy"></button>`
            : `<a class="m-media-cell" href="${escapeHtml(m.url)}" target="_blank" rel="noopener">${icons.file(24)}</a>`)).join('')}</div>` : none;
        } else if (tab === 'files') {
          pane.innerHTML = items.files.map((f) => `<a class="m-row" href="${escapeHtml(f.url)}" download="${escapeHtml(f.fileName)}">${icons.file(20)}<span class="m-grow"><b>${escapeHtml(f.fileName)}</b><small>${formatBytes(f.sizeBytes)}</small></span></a>`).join('') || none;
        } else if (tab === 'links') {
          pane.innerHTML = items.links.map((u) => `<a class="m-row" href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer">${icons.link(18)}<span class="m-grow"><b>${escapeHtml(u)}</b></span></a>`).join('') || none;
        }
      }
    } catch (err) { handleError(err, 'm.loadFailed'); }
  }

  el.addEventListener('click', async (e) => {
    const tb = e.target.closest('[data-t]');
    if (tb) { tab = tb.dataset.t; paintPane(); return; }
    const u = e.target.closest('[data-u]');
    if (u) return openProfileSheet(Number(u.dataset.u));
    const v = e.target.closest('[data-v]');
    if (v) return openImageViewer(v.dataset.v);
    const q = e.target.closest('[data-q]')?.dataset.q;
    if (q === 'search') nav.push('search', { serverId: params.serverId, channelId: params.channelId, dmId: params.dmId });
    else if (q === 'pins') { tab = 'pins'; paintPane(); }
    else if (q === 'mute') {
      const st = kind === 'dm' ? 'dm' : 'channel';
      const id = kind === 'dm' ? params.dmId : params.channelId;
      const pref = notificationPrefFor(st, id) === 'mute' ? (kind === 'dm' ? 'all' : 'mentions') : 'mute';
      try { await api.setNotificationPref(st, id, pref); setPrefState(st, id, pref); paintQuick(); } catch (err) { handleError(err); }
    }
  });

  (async () => {
    let title;
    if (kind === 'dm') { title = dmTitle(dm, nameFor); members = [state.me, ...dm.members]; }
    else {
      const detail = await ensureServerDetail(params.serverId);
      const channel = detail.channels.find((c) => c.id === params.channelId);
      title = kind === 'thread' ? t('m.threads') : `# ${channel.name}`;
      members = detail.members.map((m) => m.user);
    }
    el.querySelector('#m-title').textContent = title;
    paintQuick();
    paintPane();
  })().catch((err) => handleError(err, 'm.loadFailed'));
}
