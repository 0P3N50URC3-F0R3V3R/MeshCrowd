import { api } from '../../js/api.js';
import { t } from '../../js/i18n.js';
import { escapeHtml, apiErrorMessage } from '../../js/utils.js';
import { openSheet } from './bottomSheet.js';
import { handleError } from '../lib/errors.js';

export async function editPostSheet(serverId, channelId, threadId) {
  let res;
  try { res = await api.getThread(serverId, channelId, threadId); }
  catch (err) { handleError(err, 'forum.editError'); return; }
  openSheet({
    title: t('forum.editPost'),
    html: `<label class="m-label" for="fp-title">${t('forum.titleLabel')}</label>
      <input class="m-input" id="fp-title" maxlength="100" autocomplete="off" value="${escapeHtml(res.thread.title)}">
      <label class="m-label" for="fp-content" style="margin-top:12px">${t('forum.messageLabel')}</label>
      <textarea class="m-input" id="fp-content" rows="5">${escapeHtml(res.openingContent)}</textarea>
      <div class="m-error" id="fp-error"></div>
      <div class="m-confirm-row" style="margin-top:12px"><button class="btn btn-secondary" data-no>${t('m.cancel')}</button>
        <button class="btn btn-primary" data-yes>${t('m.save')}</button></div>`,
    onMount: (body, close) => {
      body.querySelector('[data-no]').addEventListener('click', close);
      body.querySelector('[data-yes]').addEventListener('click', async (e) => {
        const title = body.querySelector('#fp-title').value.trim();
        const content = body.querySelector('#fp-content').value.trim();
        const err = body.querySelector('#fp-error');
        if (!title || !content) { err.textContent = t('forum.titleAndMessageRequired'); return; }
        e.currentTarget.disabled = true;
        try {
          await api.updateThread(serverId, channelId, threadId, { title, content });
          close();
        } catch (error) { err.textContent = apiErrorMessage(error, t('forum.editError')); e.currentTarget.disabled = false; }
      });
    },
  });
}
