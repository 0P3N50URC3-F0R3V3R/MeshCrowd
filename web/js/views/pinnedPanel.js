import { api } from '../api.js';
import { icons } from '../icons.js';
import { avatarHtml, escapeHtml, formatTimestamp, renderMessageContent, toast, apiErrorMessage, renderCompactAttachments, renderCompactPoll } from '../utils.js';
import { confirmModal } from './modal.js';
import { t } from '../i18n.js';
import { state } from '../state.js';
import { decryptMessages } from '../e2ee/dmCrypto.js';

// Discord-style pinned-messages panel: docked in the right rail (same slot as the member list),
// listing every pinned message top to bottom with a click-to-jump. Not a floating popover — it
// stays mounted until the caller tears it down (toggled off via the header pin button).
export function mountPinnedPanel(container, scopeType, scopeId, { canManage = false, onJump, onClose } = {}) {
  container.innerHTML = `<div class="panel-loading" style="height:160px"><div class="spinner"></div></div>`;
  let destroyed = false;
  load();

  async function load() {
    try {
      const { messages } = await api.listPins(scopeType, scopeId);
      const dm = scopeType === 'dm' ? state.dms.find((d) => d.id === scopeId) : null;
      if (dm && messages.some((m) => m.isEncrypted)) await decryptMessages(dm, state.me, messages);
      if (!destroyed) render(messages);
    } catch (err) {
      if (!destroyed) container.innerHTML = `<div class="pinned-panel"><div class="pinned-panel-head"><h3>${t('pinnedPanel.heading')}</h3>${closeBtnHtml()}</div><p style="padding:0 12px;color:var(--danger)">${escapeHtml(apiErrorMessage(err, t('pinnedPanel.loadError')))}</p></div>`;
      wireClose();
    }
  }

  function closeBtnHtml() {
    return `<button class="btn-icon" id="pin-panel-close" title="${t('common.close')}">${icons.x(16)}</button>`;
  }

  function wireClose() {
    container.querySelector('#pin-panel-close')?.addEventListener('click', () => onClose?.());
  }

  function render(messages) {
    container.innerHTML = `
      <div class="pinned-panel">
        <div class="pinned-panel-head"><h3>${t('pinnedPanel.heading')}</h3>${closeBtnHtml()}</div>
        ${messages.length === 0
          ? `<div class="activity-empty"><p>${t('pinnedPanel.emptyState')}</p></div>`
          : `<div class="pinned-list">${messages.map(renderItem).join('')}</div>`}
      </div>`;
    wireClose();

    container.querySelectorAll('.pinned-item').forEach((node) => {
      node.addEventListener('click', (e) => {
        if (e.target.closest('[data-unpin]')) return;
        onJump?.(Number(node.dataset.id));
      });
    });
    container.querySelectorAll('[data-unpin]').forEach((node) => {
      node.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = Number(node.closest('.pinned-item').dataset.id);
        confirmModal({
          title: t('pinnedPanel.confirmUnpinTitle'),
          message: t('pinnedPanel.confirmUnpinMessage'),
          confirmLabel: t('pinnedPanel.unpinButton'),
          onConfirm: async () => {
            try { await api.unpinMessage(id); load(); }
            catch (err) { toast(apiErrorMessage(err, t('pinnedPanel.unpinError')), { type: 'error' }); }
          },
        });
      });
    });
  }

  function renderItem(msg) {
    return `
      <div class="pinned-item" data-id="${msg.id}">
        ${avatarHtml(msg.author, 32)}
        <div class="pi-body">
          <div class="pi-head">
            <span class="pi-name">${escapeHtml(msg.author.displayName)}</span>
            <span class="pi-time">${formatTimestamp(msg.createdAt)}</span>
          </div>
          ${msg.content ? `<div class="pi-content">${renderMessageContent(msg.content)}</div>` : ''}
          ${renderCompactPoll(msg.poll)}
          ${renderCompactAttachments(msg.attachments, 'pi-attachments')}
        </div>
        ${canManage ? `<button class="btn-icon" data-unpin title="${t('pinnedPanel.unpinButton')}">${icons.x(14)}</button>` : ''}
      </div>`;
  }

  function destroy() { destroyed = true; }
  return { destroy };
}
