import { api } from '../../js/api.js';
import { icons } from '../../js/icons.js';
import { t } from '../../js/i18n.js';
import { escapeHtml, avatarHtml, formatShortTime, renderMessageContent, debounce } from '../../js/utils.js';
import { state } from '../../js/state.js';
import { nav } from '../router.js';
import { handleError } from '../lib/errors.js';
import { parseHistory, rememberQuery, fieldsParam } from '../lib/searchHistory.mjs';

const KEY = 'meshcrowd.m.searchHistory';
const load = () => { try { return parseHistory(localStorage.getItem(KEY)); } catch { return []; } };
const save = (h) => { try { localStorage.setItem(KEY, JSON.stringify(h)); } catch { /* storage unavailable */ } };

export function mountSearch(el, params) {
  const serverId = params.serverId ?? state.lastServerId;
  const isDm = !!params.dmId;
  const fields = new Set(['text']);
  let scopeAll = !!params.entire || (!isDm && !params.channelId);
  let history = load();
  let results = null;
  let seq = 0;

  if (!isDm && !serverId) {
    el.innerHTML = `<div class="m-header"><button class="m-icon-btn" id="m-back">${icons.arrowLeft(22)}</button><h1>${t('m.searchTitle')}</h1></div><div class="m-empty">${t('m.searchScopeHint')}</div>`;
    el.querySelector('#m-back').addEventListener('click', () => nav.back());
    return;
  }

  const FILTERS = [
    { key: 'usernames', icon: 'user', label: 'm.fieldUsers', hint: 'm.hintUsers' },
    ...(isDm ? [] : [{ key: 'channelNames', icon: 'hash', label: 'm.fieldChannels', hint: 'm.hintChannels' }]),
    { key: 'attachments', icon: 'paperclip', label: 'm.fieldFiles', hint: 'm.hintFiles' },
    { key: 'mentions', icon: 'atSign', label: 'm.fieldMentions', hint: 'm.hintMentions' },
    { key: 'text', icon: 'search', label: 'm.fieldText', hint: 'm.hintText' },
  ];

  el.innerHTML = `
    <div class="m-header"><button class="m-icon-btn" id="m-back">${icons.arrowLeft(22)}</button>
      <input class="m-input" id="m-q" type="search" enterkeyhint="search" autocomplete="off" placeholder="${t('m.searchPh')}"></div>
    <div class="m-scroll" id="m-body"></div>`;
  const input = el.querySelector('#m-q');
  const body = el.querySelector('#m-body');
  el.querySelector('#m-back').addEventListener('click', () => nav.back());

  const check = (on) => `<span class="m-check-box${on ? ' on' : ''}">${on ? icons.check(12) : ''}</span>`;

  function paintMenu() {
    body.innerHTML = `<div class="m-section">${t('m.filters')}</div>
      ${FILTERS.map((f) => `<button class="m-row m-filter" data-f="${f.key}"><span class="m-sheet-icon">${icons[f.icon](20)}</span>
        <span class="m-grow"><b>${t(f.label)}</b><small>${t(f.hint)}</small></span>${check(fields.has(f.key))}</button>`).join('')}
      ${isDm ? '' : `<button class="m-row m-filter" data-scope="1"><span class="m-sheet-icon">${icons.sliders(20)}</span>
        <span class="m-grow"><b>${t('m.fieldServer')}</b><small>${t('m.hintServer')}</small></span>${check(scopeAll)}</button>`}
      ${history.length ? `<div class="m-section m-section-row">${t('m.history')}<button class="m-icon-btn" id="m-clear" aria-label="${t('m.clearHistory')}">${icons.trash(16)}</button></div>
        ${history.map((h, i) => `<button class="m-row" data-h="${i}"><span class="m-sheet-icon">${icons.search(18)}</span><span class="m-grow"><b>${escapeHtml(h)}</b></span></button>`).join('')}` : ''}`;
  }

  function paintResults() {
    if (results === null) return paintMenu();
    if (results.error) { body.innerHTML = `<div class="m-empty">${escapeHtml(results.error)}</div>`; return; }
    if (!results.length) { body.innerHTML = `<div class="m-empty">${t('m.searchNone')}</div>`; return; }
    body.innerHTML = results.map((m, i) => `<button class="m-row m-result" data-r="${i}">${avatarHtml(m.author, 36)}
      <span class="m-grow"><b>${escapeHtml(m.author.displayName)} <small>${formatShortTime(m.createdAt)}</small></b>
        ${m.channelName ? `<small>#${escapeHtml(m.channelName)}</small>` : ''}
        <span class="m-result-text">${m.content ? renderMessageContent(m.content, {}) : ''}</span></span></button>`).join('');
  }

  async function run() {
    const q = input.value.trim();
    if (!q) { results = null; paintResults(); return; }
    if (!fields.size) { results = { error: t('m.searchNeedField') }; paintResults(); return; }
    const mine = ++seq;
    try {
      const fieldsStr = fieldsParam(fields);
      const res = isDm
        ? await api.searchDmMessages(params.dmId, q, { fields: fieldsStr })
        : await api.searchServerMessages(serverId, q, { ...(scopeAll || !params.channelId ? {} : { channelId: params.channelId }), fields: fieldsStr });
      if (mine !== seq) return;
      results = res.messages;
    } catch (err) {
      if (mine !== seq) return;
      if (err && err.status === 401) return handleError(err);
      results = { error: err.message };
    }
    paintResults();
  }

  input.addEventListener('input', debounce(run, 300));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { history = rememberQuery(history, input.value); save(history); } });
  body.addEventListener('click', (e) => {
    const f = e.target.closest('[data-f]');
    if (f) { if (fields.has(f.dataset.f)) fields.delete(f.dataset.f); else fields.add(f.dataset.f); paintMenu(); if (input.value.trim()) run(); return; }
    if (e.target.closest('[data-scope]')) { scopeAll = !scopeAll; paintMenu(); if (input.value.trim()) run(); return; }
    const h = e.target.closest('[data-h]');
    if (h) { input.value = history[Number(h.dataset.h)]; run(); return; }
    if (e.target.closest('#m-clear')) { history = []; save(history); paintMenu(); return; }
    const r = e.target.closest('[data-r]');
    if (r) {
      const m = results[Number(r.dataset.r)];
      history = rememberQuery(history, input.value); save(history);
      if (isDm) nav.push('chat', { kind: 'dm', dmId: params.dmId, jumpToMessageId: m.id });
      else if (m.scopeType === 'thread') nav.push('chat', { kind: 'thread', serverId, channelId: m.channelId, threadId: m.scopeId, jumpToMessageId: m.id });
      else nav.push('chat', { kind: 'channel', serverId, channelId: m.scopeId, jumpToMessageId: m.id });
    }
  });
  paintMenu();
  return {};
}
