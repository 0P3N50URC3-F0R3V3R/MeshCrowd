import { bus } from '../bus.js';
import { api } from '../api.js';
import { state } from '../state.js';
import { avatarHtml, escapeHtml, formatTimestamp, toast, apiErrorMessage } from '../utils.js';
import { openModal } from './modal.js';
import { t } from '../i18n.js';
import { decryptMessage } from '../e2ee/dmCrypto.js';
import { icons } from '../icons.js';

function jumpTarget(b) {
  if (b.scopeType === 'dm') return { type: 'dm', dmId: b.scopeId, jumpToMessageId: b.message.id };
  if (b.scopeType === 'thread') return { type: 'server', serverId: b.serverId, channelId: b.channelId, threadId: b.scopeId, jumpToMessageId: b.message.id };
  return { type: 'server', serverId: b.serverId, channelId: b.scopeId, jumpToMessageId: b.message.id };
}

// "Saved messages": everything the user bookmarked from a message's context menu, newest first.
export async function openBookmarksModal() {
  const m = openModal({
    title: t('bookmarks.title'),
    wide: true,
    render(body) { body.innerHTML = '<div class="panel-loading" style="height:160px"><div class="spinner"></div></div>'; },
  });
  let bookmarks;
  try {
    bookmarks = (await api.getBookmarks()).bookmarks;
    for (const b of bookmarks) {
      const dm = b.scopeType === 'dm' ? state.dms.find((d) => d.id === b.scopeId) : null;
      if (dm && b.message.isEncrypted) { try { await decryptMessage(dm, state.me, b.message); } catch { /* shown as encrypted */ } }
    }
  } catch (err) {
    m.body.innerHTML = `<p style="color:var(--danger)">${escapeHtml(apiErrorMessage(err, t('bookmarks.loadError')))}</p>`;
    return;
  }
  draw();

  function draw() {
    if (!bookmarks.length) {
      m.body.innerHTML = `<div class="empty-state" style="padding:30px 0"><p>${t('bookmarks.empty')}</p></div>`;
      return;
    }
    m.body.innerHTML = bookmarks.map((b, i) => {
      const msg = b.message;
      const where = b.scopeType === 'dm'
        ? t('bookmarks.inDm', { name: state.dms.find((d) => d.id === b.scopeId)?.members.map((x) => x.displayName).join(', ') || '' })
        : b.label || '';
      const text = msg.isEncrypted && !msg.content ? t('dmEncryption.encryptedPreview') : (msg.content || (msg.attachments?.length ? t('sidebar.sentAnAttachment') : ''));
      return `
        <div class="list-row bookmark-row" data-i="${i}" style="cursor:pointer;align-items:flex-start">
          ${avatarHtml(msg.author, 36)}
          <div class="lr-main" style="min-width:0">
            <div class="lr-title">${escapeHtml(msg.author.displayName)} <span class="hint">${escapeHtml(formatTimestamp(msg.createdAt))}</span></div>
            <div class="lr-sub" style="white-space:pre-wrap;word-break:break-word">${escapeHtml(text.slice(0, 300))}</div>
            <div class="lr-sub" style="opacity:.7">${escapeHtml(where)}</div>
          </div>
          <button class="btn-icon" data-remove="${i}" title="${t('msgMenu.removeBookmark')}">${icons.trash(16)}</button>
        </div>`;
    }).join('');
    m.body.querySelectorAll('.bookmark-row').forEach((row) => row.addEventListener('click', (e) => {
      if (e.target.closest('[data-remove]')) return;
      m.close();
      bus.emit('ui:navigate', jumpTarget(bookmarks[Number(row.dataset.i)]));
    }));
    m.body.querySelectorAll('[data-remove]').forEach((btn) => btn.addEventListener('click', async () => {
      const b = bookmarks[Number(btn.dataset.remove)];
      try {
        await api.removeBookmark(b.message.id);
        state.bookmarkIds.delete(b.message.id);
        bookmarks = bookmarks.filter((x) => x !== b);
        draw();
      } catch (err) { toast(apiErrorMessage(err), { type: 'error' }); }
    }));
  }
}
