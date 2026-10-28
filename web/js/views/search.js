import { api } from '../api.js';
import { icons } from '../icons.js';
import { avatarHtml, formatTimestamp, renderMessageContent, escapeHtml, debounce, apiErrorMessage, renderCompactAttachments, renderCompactPoll } from '../utils.js';

import { t } from '../i18n.js';

// A function (not a module-level constant) so the labels re-evaluate against the current
// language — a plain top-level array of t()-built strings would freeze at module-import time,
// before initI18n() has resolved (see userBar.js's statusOptions() for the same pattern).
function fieldOptions() {
  return [
    { key: 'usernames', icon: 'user', label: t('search.fieldUsernames'), hint: t('search.hintUsernames') },
    { key: 'channelNames', icon: 'hash', label: t('search.fieldChannelNames'), hint: t('search.hintChannelNames'), channelScopeOnly: true },
    { key: 'attachments', icon: 'paperclip', label: t('search.fieldAttachments'), hint: t('search.hintAttachments') },
    { key: 'mentions', icon: 'atSign', label: t('search.fieldMentions'), hint: t('search.hintMentions') },
    { key: 'text', icon: 'search', label: t('search.fieldText'), hint: t('search.hintText') },
  ];
}

const HISTORY_KEY = 'meshcrowd.searchHistory';
const HISTORY_MAX = 8;
function loadHistory() {
  try { const h = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); return Array.isArray(h) ? h.slice(0, HISTORY_MAX) : []; } catch { return []; }
}
function saveHistory(h) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(h)); } catch { /* storage unavailable */ }
}

// Docked in the right rail (same slot as the member list/pinned panel), not a floating popover -
// mirrors pinnedPanel.js's shape. `scope`: {kind:'channel', serverId, channelId, channels} |
// {kind:'dm', dmId}. The field checkboxes each add their own OR'd match criterion server-side
// (see server/lib/search.js) - checking "Usernames" alongside typing "alex" also returns messages
// from anyone whose username/display name contains "alex", regardless of message content.
export function mountSearchPanel(container, scope, { onJump, onClose } = {}) {
  let scopeAll = false; // channel scope only: false = this channel, true = whole server
  let results = null;
  let loading = false;
  let lastQuery = '';
  const checkedFields = new Set(['text']);
  let destroyed = false;
  let history = loadHistory();

  render();

  function closeBtnHtml() {
    return `<button class="btn-icon" id="search-panel-close" title="${t('common.close')}">${icons.x(16)}</button>`;
  }

  function render() {
    container.innerHTML = `
      <div class="pinned-panel-head"><h3>${t('search.heading')}</h3>${closeBtnHtml()}</div>
      <div class="search-controls">
        <input class="input" id="search-q" type="text" placeholder="${t('search.searchPlaceholder')}" autocomplete="off" autofocus>
        <div class="search-menu" id="search-menu" hidden></div>
      </div>
      <div id="search-results" class="search-results"></div>`;

    container.querySelector('#search-panel-close').addEventListener('click', () => onClose?.());

    const input = container.querySelector('#search-q');
    input.value = lastQuery;
    input.focus();
    input.addEventListener('input', debounce(() => runSearch(input.value), 250));

    const menu = container.querySelector('#search-menu');
    const showMenu = () => { renderMenu(menu, input); menu.hidden = false; };
    const hideMenu = () => { menu.hidden = true; };
    input.addEventListener('focus', showMenu);
    input.addEventListener('input', () => { if (input.value) hideMenu(); else showMenu(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { rememberQuery(input.value); hideMenu(); }
      else if (e.key === 'Escape') hideMenu();
    });
    // mousedown (not click) + preventDefault so picking a row doesn't blur the input first
    menu.addEventListener('mousedown', (e) => e.preventDefault());
    const onDocDown = (e) => {
      if (destroyed || !container.isConnected) { document.removeEventListener('mousedown', onDocDown); return; }
      if (!menu.contains(e.target) && e.target !== input) hideMenu();
    };
    document.addEventListener('mousedown', onDocDown);

    renderResults();
    showMenu();
  }

  function rememberQuery(q) {
    const v = q.trim();
    if (!v) return;
    history = [v, ...history.filter((h) => h !== v)].slice(0, HISTORY_MAX);
    saveHistory(history);
  }

  function renderMenu(menu, input) {
    const rows = fieldOptions().filter((f) => !f.channelScopeOnly || scope.kind === 'channel');
    menu.innerHTML = `
      <div class="search-menu-title">${t('search.filtersHeading')}</div>
      ${rows.map((f) => `
        <div class="search-menu-item ${checkedFields.has(f.key) ? 'on' : ''}" data-field="${f.key}">
          <span class="sm-icon">${icons[f.icon](20)}</span>
          <span class="sm-label"><b>${escapeHtml(f.label)}</b><small>${escapeHtml(f.hint)}</small></span>
          <span class="cm-check ${checkedFields.has(f.key) ? 'on' : ''}">${checkedFields.has(f.key) ? icons.check(12) : ''}</span>
        </div>`).join('')}
      ${scope.kind === 'channel' ? `
        <div class="search-menu-item ${scopeAll ? 'on' : ''}" data-scope="all">
          <span class="sm-icon">${icons.sliders(20)}</span>
          <span class="sm-label"><b>${t('search.searchEntireServer')}</b><small>${t('search.hintScope')}</small></span>
          <span class="cm-check ${scopeAll ? 'on' : ''}">${scopeAll ? icons.check(12) : ''}</span>
        </div>` : ''}
      ${history.length ? `
        <div class="search-menu-sep"></div>
        <div class="search-menu-title">${t('search.historyHeading')}
          <button class="btn-icon" id="search-history-clear" title="${t('search.clearHistory')}">${icons.trash(16)}</button>
        </div>
        ${history.map((h, i) => `
          <div class="search-menu-item" data-history="${i}">
            <span class="sm-icon">${icons.search(18)}</span>
            <span class="sm-label"><b>${escapeHtml(h)}</b></span>
          </div>`).join('')}` : ''}`;

    menu.querySelectorAll('[data-field]').forEach((el) => {
      el.addEventListener('click', () => {
        const k = el.dataset.field;
        if (checkedFields.has(k)) checkedFields.delete(k); else checkedFields.add(k);
        renderMenu(menu, input);
        if (input.value.trim()) runSearch(input.value);
      });
    });
    menu.querySelector('[data-scope]')?.addEventListener('click', () => {
      scopeAll = !scopeAll;
      renderMenu(menu, input);
      if (input.value.trim()) runSearch(input.value);
    });
    menu.querySelectorAll('[data-history]').forEach((el) => {
      el.addEventListener('click', () => {
        input.value = history[Number(el.dataset.history)];
        menu.hidden = true;
        runSearch(input.value);
      });
    });
    menu.querySelector('#search-history-clear')?.addEventListener('click', () => {
      history = [];
      saveHistory(history);
      renderMenu(menu, input);
    });
  }

  async function runSearch(q) {
    lastQuery = q;
    if (checkedFields.size === 0) { results = { error: t('search.checkAtLeastOneField') }; renderResults(); return; }
    if (!q.trim()) { results = null; renderResults(); return; }
    loading = true;
    renderResults();
    const fields = [...checkedFields].join(',');
    try {
      const res = scope.kind === 'dm'
        ? await api.searchDmMessages(scope.dmId, q, { fields })
        : await api.searchServerMessages(scope.serverId, q, { ...(scopeAll ? {} : { channelId: scope.channelId }), fields });
      if (destroyed) return;
      results = res.messages;
    } catch (err) {
      if (destroyed) return;
      results = { error: apiErrorMessage(err, t('search.searchFailed')) };
    } finally {
      if (!destroyed) { loading = false; renderResults(); }
    }
  }

  function renderResults() {
    const host = container.querySelector('#search-results');
    if (!host) return;
    if (loading) { host.innerHTML = `<div class="panel-loading" style="height:120px"><div class="spinner"></div></div>`; return; }
    if (results === null) { host.innerHTML = `<div class="search-empty">${t('search.typeToSearch')}</div>`; return; }
    if (results.error) { host.innerHTML = `<div class="search-empty">${escapeHtml(results.error)}</div>`; return; }
    if (results.length === 0) { host.innerHTML = `<div class="search-empty">${t('search.noMessagesFound')}</div>`; return; }

    host.innerHTML = results.map((m, i) => `
      <div class="search-result" data-idx="${i}">
        ${avatarHtml(m.author, 32)}
        <div class="sr-body">
          <div class="sr-head"><span class="sr-name">${escapeHtml(m.author.displayName)}</span><span class="sr-time">${formatTimestamp(m.createdAt)}</span></div>
          ${m.channelName ? `<div class="sr-channel">${icons.hash(11)} ${escapeHtml(m.channelName)}</div>` : ''}
          ${m.content ? `<div class="sr-content">${renderMessageContent(m.content)}</div>` : ''}
          ${renderCompactPoll(m.poll)}
          ${renderCompactAttachments(m.attachments, 'sr-attachments')}
        </div>
      </div>`).join('');

    host.querySelectorAll('.search-result').forEach((node) => {
      node.addEventListener('click', () => jumpTo(results[Number(node.dataset.idx)]));
    });
  }

  function jumpTo(m) {
    rememberQuery(lastQuery);
    onJump?.(m);
  }

  function destroy() { destroyed = true; }
  return { destroy };
}
