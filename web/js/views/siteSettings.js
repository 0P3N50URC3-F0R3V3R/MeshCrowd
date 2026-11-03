import { api } from '../api.js';
import { upsertServer } from '../state.js';
import { escapeHtml, apiErrorMessage, serverIconHtml } from '../utils.js';
import { openModal, confirmModal } from './modal.js';
import { t } from '../i18n.js';

function currentOrigins(server) {
  try { return JSON.parse(server.site_csp_origins || '[]'); } catch { return []; }
}

export function openSiteSettings(server) {
  const before = currentOrigins(server);
  let pendingFile = null;
  let pendingUrl = null;
  let removeIcon = false;
  let bgOn = server.icon_bg !== 0;
  let bgColor = server.icon_bg_color || '';
  openModal({
    title: t('sites.settings.title'),
    wide: true,
    render(body, close) {
      body.innerHTML = `
        <div class="settings-avatar-row">
          <div class="avatar-edit" id="ss-icon" style="border-radius:50%;overflow:hidden;background:var(--bg-active);display:flex;align-items:center;justify-content:center;width:80px;height:80px">
            <span></span>
            <div class="overlay-hint">${t('serverSettings.changeIconHint')}</div>
          </div>
          <div style="display:flex;flex-direction:column;gap:6px">
            <label class="checkbox-row"><input type="checkbox" id="ss-icon-bg"><span>${t('serverSettings.iconBackgroundLabel')}</span></label>
            <input type="color" class="theme-color-input" id="ss-icon-color" title="${t('serverSettings.iconBackgroundColor')}">
            <button class="btn btn-secondary" id="ss-icon-remove" type="button">${t('sites.settings.iconRemove')}</button>
          </div>
          <input type="file" id="ss-icon-input" class="hidden" accept="image/png,image/jpeg,image/gif,image/webp">
        </div>
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
      const bgBox = body.querySelector('#ss-icon-bg');
      const colorInput = body.querySelector('#ss-icon-color');
      const removeBtn = body.querySelector('#ss-icon-remove');
      const hasPicture = () => !!pendingFile || (!!server.icon_path && !removeIcon);
      const repaint = () => {
        const preview = { ...server, icon_path: pendingUrl || (removeIcon ? null : server.icon_path), icon_bg: bgOn ? 1 : 0, icon_bg_color: bgColor };
        body.querySelector('#ss-icon').querySelector('img, span, svg').outerHTML = serverIconHtml(preview, 80);
        bgBox.checked = bgOn;
        colorInput.value = bgColor || '#2b2d31';
        colorInput.style.display = bgOn ? '' : 'none';
        removeBtn.style.display = hasPicture() ? '' : 'none';
      };
      repaint();
      body.querySelector('#ss-icon').addEventListener('click', () => body.querySelector('#ss-icon-input').click());
      body.querySelector('#ss-icon-input').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (pendingUrl) URL.revokeObjectURL(pendingUrl);
        pendingFile = file;
        pendingUrl = URL.createObjectURL(file);
        removeIcon = false;
        repaint();
      });
      removeBtn.addEventListener('click', () => {
        if (pendingUrl) URL.revokeObjectURL(pendingUrl);
        pendingFile = null; pendingUrl = null; removeIcon = true;
        repaint();
      });
      bgBox.addEventListener('change', () => { bgOn = bgBox.checked; repaint(); });
      colorInput.addEventListener('input', () => { bgColor = colorInput.value; repaint(); });
      const save = async () => {
        const name = body.querySelector('#ss-name').value.trim();
        const origins = body.querySelector('#ss-origins').value.split('\n').map((l) => l.trim()).filter(Boolean);
        const bad = origins.find((o) => !/^https:\/\/[^\s/*?#@]+\/?$/i.test(o));
        if (bad) { err.textContent = t('sites.settings.originsInvalid', { value: bad }); return; }
        try {
          if (pendingFile) await api.siteUploadIcon(server.id, pendingFile);
          else if (removeIcon && server.icon_path) await api.siteRemoveIcon(server.id);
          const res = await api.siteUpdate(server.id, { name, origins, iconBackground: bgOn, iconBgColor: bgColor });
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
