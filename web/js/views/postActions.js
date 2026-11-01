import { api } from '../api.js';
import { escapeHtml, apiErrorMessage, toast } from '../utils.js';
import { openModal, confirmModal } from './modal.js';
import { t } from '../i18n.js';

export async function editPost(serverId, channelId, threadId) {
  let res;
  try { res = await api.getThread(serverId, channelId, threadId); }
  catch (err) { toast(apiErrorMessage(err, t('forum.editError')), { type: 'error' }); return; }
  openModal({
    title: t('forum.editPost'),
    render(body, close) {
      body.innerHTML = `
        <div class="field">
          <label for="fp-title">${t('forum.titleLabel')}</label>
          <input class="input" id="fp-title" maxlength="100" value="${escapeHtml(res.thread.title)}">
        </div>
        <div class="field">
          <label for="fp-content">${t('forum.messageLabel')}</label>
          <textarea class="input textarea" id="fp-content" rows="5">${escapeHtml(res.openingContent)}</textarea>
        </div>
        <div class="error-text" id="fp-error"></div>
        <button class="btn btn-primary" id="fp-submit">${t('common.save')}</button>`;
      body.querySelector('#fp-submit').addEventListener('click', async () => {
        const title = body.querySelector('#fp-title').value.trim();
        const content = body.querySelector('#fp-content').value.trim();
        if (!title || !content) { body.querySelector('#fp-error').textContent = t('forum.titleAndMessageRequired'); return; }
        try {
          await api.updateThread(serverId, channelId, threadId, { title, content });
          close();
        } catch (err) { body.querySelector('#fp-error').textContent = apiErrorMessage(err, t('forum.editError')); }
      });
    },
  });
}

export function deletePost(serverId, channelId, thread) {
  confirmModal({
    title: t('forum.deletePost'),
    message: t('forum.deleteConfirm', { title: escapeHtml(thread.title) }),
    confirmLabel: t('common.delete'),
    onConfirm: async () => {
      try { await api.deleteThread(serverId, channelId, thread.id); }
      catch (err) { toast(apiErrorMessage(err, t('forum.deleteError')), { type: 'error' }); }
    },
  });
}
