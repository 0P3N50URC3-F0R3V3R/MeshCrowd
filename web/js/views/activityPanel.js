import { bus } from '../bus.js';
import { api } from '../api.js';
import { state, setFriendVoiceBulk } from '../state.js';
import { icons } from '../icons.js';
import { avatarHtml, escapeHtml, formatShortTime, formatTimestamp, renderMessageContent, debounce, apiErrorMessage } from '../utils.js';
import { t } from '../i18n.js';

const KIND_ICON = { mention: icons.reply, dm: icons.messageSquare, channel: icons.hash };

// Discord's "Active Now" panel, shown on the Home/Friends view: which friends are currently in
// a voice channel, plus a recent-activity feed built from the same events that already drive
// desktop notifications (mentions, DMs, subscribed-channel posts) — see shell.js's onNotify.
// Typing into the search bar at top replaces this whole feed with matching messages from
// anywhere the viewer can see (every server channel/thread they're in, plus their DMs), same as
// Discord's own search-replaces-the-panel behavior.
export function mountActivityPanel(container) {
  let query = '';
  let searchResults = null; // null = not searching; [] = searched, no hits; array = hits
  let searching = false;

  render();
  api.friendsVoiceActivity().then((res) => setFriendVoiceBulk(res.activity)).catch(() => {});

  const offVoice = bus.on('state:friendVoice', () => { if (!query) render(); });
  const offFeed = bus.on('state:activity', () => { if (!query) render(); });
  const offFriends = bus.on('state:friends', render);

  function friendUser(userId) {
    return state.friends.friends.find((f) => f.user.id === userId)?.user || { id: userId, displayName: `User ${userId}` };
  }

  const runSearch = debounce(async () => {
    if (!query.trim()) { searchResults = null; searching = false; render(); return; }
    if (!state.lastServerId) { searchResults = []; searching = false; render(); return; }
    searching = true;
    render();
    try {
      searchResults = (await api.globalSearch(query.trim(), state.lastServerId)).messages;
    } catch (err) {
      searchResults = { error: apiErrorMessage(err, t('activityPanel.searchFailed')) };
    } finally {
      searching = false;
      render();
    }
  }, 300);

  function render() {
    // Only re-focus the search box if it already had focus (i.e. this render was caused by the
    // user typing into it) — a background update (a friend joining voice, a new activity item)
    // must never steal focus from wherever the user actually is, e.g. the chat composer.
    const hadFocus = document.activeElement === container.querySelector('#ap-search');
    const voiceEntries = [...state.friendVoice.entries()];
    container.innerHTML = `
      <div class="activity-panel">
        <h3>${t('activityPanel.heading')}</h3>
        <div class="activity-search">
          <span class="as-icon">${icons.search(14)}</span>
          <input class="as-input" id="ap-search" placeholder="${t('activityPanel.searchPlaceholder')}" value="${escapeHtml(query)}">
          ${query ? `<button class="btn-icon as-clear" id="ap-search-clear">${icons.x(12)}</button>` : ''}
        </div>
        ${query ? renderSearchState() : renderFeed(voiceEntries)}
      </div>`;

    const input = container.querySelector('#ap-search');
    input.addEventListener('input', () => { query = input.value; runSearch(); });
    if (hadFocus) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
    container.querySelector('#ap-search-clear')?.addEventListener('click', () => { query = ''; searchResults = null; render(); });

    container.querySelectorAll('.activity-voice-item').forEach((node) => {
      node.addEventListener('click', () => {
        bus.emit('ui:navigate', { type: 'server', serverId: Number(node.dataset.server), channelId: Number(node.dataset.channel) });
      });
    });
    container.querySelectorAll('.activity-feed-item').forEach((node) => {
      node.addEventListener('click', () => {
        const scopeType = node.dataset.scopeType;
        const scopeId = Number(node.dataset.scopeId);
        if (scopeType === 'dm') bus.emit('ui:navigate', { type: 'dm', dmId: scopeId });
        else if (scopeType === 'channel' && node.dataset.serverId) {
          bus.emit('ui:navigate', { type: 'server', serverId: Number(node.dataset.serverId), channelId: scopeId });
        }
      });
    });
    container.querySelectorAll('.search-result').forEach((node) => {
      node.addEventListener('click', () => jumpToResult(searchResults[Number(node.dataset.idx)]));
    });
  }

  function renderFeed(voiceEntries) {
    return `
      ${voiceEntries.length ? `
        <div class="activity-section-label">${t('activityPanel.inVoiceLabel')}</div>
        <div class="activity-voice-list">
          ${voiceEntries.map(([userId, ch]) => {
            const u = friendUser(userId);
            return `
            <div class="activity-voice-item" data-server="${ch.serverId}" data-channel="${ch.id}">
              ${avatarHtml(u, 32)}
              <div class="avi-body">
                <div class="avi-name">${escapeHtml(u.displayName)}</div>
                <div class="avi-where">${icons.headphones(12)} ${escapeHtml(ch.name)} · ${escapeHtml(ch.serverName || '')}</div>
              </div>
            </div>`;
          }).join('')}
        </div>` : ''}
      ${state.activityFeed.length ? `
        <div class="activity-section-label">${t('activityPanel.recentLabel')}</div>
        <div class="activity-feed-list">
          ${state.activityFeed.map((item) => `
            <div class="activity-feed-item" data-scope-type="${item.scopeType}" data-scope-id="${item.scopeId}" data-server-id="${item.serverId || ''}">
              <span class="afi-icon">${(KIND_ICON[item.kind] || icons.info)(14)}</span>
              <div class="afi-body">
                <div class="afi-title">${escapeHtml(item.title)}</div>
                <div class="afi-snippet">${escapeHtml(item.body || '')}</div>
              </div>
              <span class="afi-time">${formatShortTime(item.createdAt)}</span>
            </div>`).join('')}
        </div>` : ''}
      ${voiceEntries.length === 0 && state.activityFeed.length === 0 ? `
        <div class="activity-empty">
          <p><strong>${t('activityPanel.emptyTitle')}</strong></p>
          <p>${t('activityPanel.emptyBody')}</p>
        </div>` : ''}`;
  }

  function renderSearchState() {
    if (searching) return `<div class="panel-loading" style="height:120px"><div class="spinner"></div></div>`;
    if (!state.lastServerId) return `<div class="activity-empty"><p>${t('activityPanel.noServerSelected')}</p></div>`;
    if (searchResults === null) return `<div class="activity-empty"><p>${t('activityPanel.typeToSearchHint')}</p></div>`;
    if (searchResults.error) return `<div class="activity-empty"><p>${escapeHtml(searchResults.error)}</p></div>`;
    if (searchResults.length === 0) return `<div class="activity-empty"><p>${t('activityPanel.noMessagesFound')}</p></div>`;
    return `
      <div class="search-results" style="max-height:none">
        ${searchResults.map((m, i) => `
          <div class="search-result" data-idx="${i}">
            ${avatarHtml(m.author, 32)}
            <div class="sr-body">
              <div class="sr-head"><span class="sr-name">${escapeHtml(m.author.displayName)}</span><span class="sr-time">${formatTimestamp(m.createdAt)}</span></div>
              ${m.channelName ? `<div class="sr-channel">${icons.hash(11)} ${escapeHtml(m.channelName)}</div>` : ''}
              <div class="sr-content">${renderMessageContent(m.content)}</div>
            </div>
          </div>`).join('')}
      </div>`;
  }

  function jumpToResult(m) {
    if (!m) return;
    if (m.scopeType === 'dm') {
      bus.emit('ui:navigate', { type: 'dm', dmId: m.scopeId, jumpToMessageId: m.id });
    } else if (m.scopeType === 'thread') {
      bus.emit('ui:navigate', { type: 'server', serverId: m.serverId, channelId: m.channelId, threadId: m.scopeId, jumpToMessageId: m.id });
    } else if (m.scopeType === 'channel') {
      bus.emit('ui:navigate', { type: 'server', serverId: m.serverId, channelId: m.channelId, jumpToMessageId: m.id });
    }
  }

  function destroy() { offVoice(); offFeed(); offFriends(); }
  return { destroy };
}
