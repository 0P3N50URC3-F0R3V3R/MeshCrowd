import { api } from '../api.js';
import { upsertServer } from '../state.js';
import { escapeHtml, apiErrorMessage } from '../utils.js';
import { openModal, confirmModal } from './modal.js';
import { t } from '../i18n.js';

function currentOrigins(server) {
  try { return JSON.parse(server.site_csp_origins || '[]'); } catch { return []; }
}

export function openSiteSettings(server) {
  const before = currentOrigins(server);
  openModal({
    title: t('sites.settings.title'),
    wide: true,
    render(body, close) {
      body.innerHTML = `
        <div class="field">
          <label>${t('sites.nameLabel')}</label>
          <input class="input" id="ss-name" maxlength="100" value="${escapeHtml(server.name)}">
        </div>
        <div class="field">
          <label>${t('sites.settings.originsLabel')}</label>
          <textarea class="input textarea" id="ss-origins" rows="5" spellcheck="false">${escapeHtml(before.join('\n'))}</textarea>
          <p class="hint">${t('sites.settings.originsHint')}</p>
        </div>
        <div class="error-text" id="ss-err"></div>
        <button class="btn btn-primary btn-block" id="ss-save">${t('common.save')}</button>`;
      const err = body.querySelector('#ss-err');
      const save = async () => {
        const name = body.querySelector('#ss-name').value.trim();
        const origins = body.querySelector('#ss-origins').value.split('\n').map((l) => l.trim()).filter(Boolean);
        const bad = origins.find((o) => !/^https:\/\/[^\s/*?#@]+\/?$/i.test(o));
        if (bad) { err.textContent = t('sites.settings.originsInvalid', { value: bad }); return; }
        try {
          const res = await api.siteUpdate(server.id, { name, origins });
          upsertServer(res.server);
          close();
        } catch (e) {
          err.textContent = apiErrorMessage(e, t('sites.settings.saveFailed'));
        }
      };
      body.querySelector('#ss-save').addEventListener('click', () => {
        const origins = body.querySelector('#ss-origins').value.split('\n').map((l) => l.trim()).filter(Boolean);
        const added = origins.some((o) => !before.includes(o));
        if (!added) { save(); return; }
        confirmModal({
          title: t('sites.settings.originsWarnTitle'),
          message: escapeHtml(t('sites.settings.originsWarn')),
          confirmLabel: t('sites.settings.originsConfirm'),
          onConfirm: save,
        });
      });
    },
  });
}
