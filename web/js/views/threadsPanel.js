import { api } from '../api.js';
import { bus } from '../bus.js';
import { icons } from '../icons.js';
import { escapeHtml, formatTimestamp, apiErrorMessage } from '../utils.js';
import { t } from '../i18n.js';

// Docked in the right rail (same slot as the member list/pinned/search panels) - lists every
// thread in this channel, most recently active first, so a thread you created and then navigated
// away from is never orphaned: this is the way back to it. Mirrors pinnedPanel.js's shape.
export function mountThreadsPanel(container, serverId, channelId, { onOpen, onClose } = {}) {
  container.innerHTML = `<div class="panel-loading" style="height:160px"><div class="spinner"></div></div>`;
  let destroyed = false;
  const offDelete = bus.on('ws:thread_delete', ({ channelId: cid }) => { if (cid === channelId && !destroyed) load(); });
  load();

  async function load() {
    try {
      const { threads } = await api.listThreads(serverId, channelId);
      if (!destroyed) render(threads);
    } catch (err) {
      if (destroyed) return;
      container.innerHTML = `<div class="pinned-panel-head"><h3>${t('threadsPanel.heading')}</h3>${closeBtnHtml()}</div><p style="padding:0 12px;color:var(--danger)">${escapeHtml(apiErrorMessage(err, t('threadsPanel.loadError')))}</p>`;
      wireClose();
    }
  }

  function closeBtnHtml() {
    return `<button class="btn-icon" id="threads-panel-close" title="${t('common.close')}">${icons.x(16)}</button>`;
  }

  function wireClose() {
    container.querySelector('#threads-panel-close')?.addEventListener('click', () => onClose?.());
  }

  function render(threads) {
    container.innerHTML = `
      <div class="pinned-panel-head"><h3>${t('threadsPanel.heading')}</h3>${closeBtnHtml()}</div>
      ${threads.length === 0
        ? `<div class="activity-empty"><p>${t('threadsPanel.emptyState')}</p></div>`
        : `<div class="pinned-list">${threads.map(renderItem).join('')}</div>`}`;
    wireClose();

    container.querySelectorAll('.thread-item').forEach((node) => {
      node.addEventListener('click', () => onOpen?.(Number(node.dataset.id)));
    });
  }

  function renderItem(thread) {
    return `
      <div class="thread-item pinned-item" data-id="${thread.id}">
        <span class="ti-icon">${icons.messageSquare(18)}</span>
        <div class="pi-body">
          <div class="pi-head">
            <span class="pi-name">${escapeHtml(thread.title)}</span>
            <span class="pi-time">${formatTimestamp(thread.lastMessageAt)}</span>
          </div>
          <div class="ti-meta">${thread.messageCount} ${thread.messageCount === 1 ? t('threadsPanel.messageSingular') : t('threadsPanel.messagePlural')}${thread.archived ? ` · ${t('threadsPanel.archivedSuffix')}` : ''}</div>
        </div>
      </div>`;
  }

  function destroy() { destroyed = true; offDelete(); }
  return { destroy };
}
