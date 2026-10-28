import { icons } from '../icons.js';
import { escapeHtml, toast, apiErrorMessage } from '../utils.js';
import { t } from '../i18n.js';

// Shared grid+upload-form UI for managing a server's stickers — used by both Server Settings
// (per-server MANAGE_SERVER) and the site Admin Panel (MANAGE_ANY_SERVER, any server, even ones
// the site admin isn't a member of). The caller supplies the actual API calls so this stays
// agnostic of which permission path is active.
export function renderStickerEditor(container, { stickers, upload, remove, onChange }) {
  container.innerHTML = `
    <p class="hint" style="margin:0 0 16px">${t('stickerEditor.hint')}</p>
    <div class="field">
      <label>${t('stickerEditor.uploadNewLabel')}</label>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input class="input" id="st-name" placeholder="${t('stickerEditor.namePlaceholder')}" maxlength="32" style="width:180px">
        <input class="input" id="st-desc" placeholder="${t('stickerEditor.descPlaceholder')}" maxlength="150" style="width:220px">
        <button type="button" class="btn btn-secondary" id="st-file-btn">${t('stickerEditor.chooseImage')}</button>
        <input type="file" id="st-file-input" class="hidden" accept="image/png,image/jpeg,image/gif,image/webp">
        <span id="st-file-name" class="hint"></span>
      </div>
      <div class="error-text" id="st-err"></div>
      <button class="btn btn-primary" id="st-upload-btn" style="margin-top:10px">${t('stickerEditor.uploadButton')}</button>
    </div>
    <div class="divider"></div>
    <div class="field">
      <label>${stickers.length} ${stickers.length === 1 ? t('stickerEditor.countSingular') : t('stickerEditor.countPlural')}</label>
      <div id="st-grid" style="display:flex;flex-wrap:wrap;gap:10px"></div>
    </div>`;

  const gridEl = container.querySelector('#st-grid');
  gridEl.innerHTML = stickers.length
    ? stickers.map((s) => `
        <div style="width:120px;display:flex;flex-direction:column;align-items:center;gap:4px;padding:10px;text-align:center;border-radius:var(--radius-sm)" class="list-row">
          <img class="anim-hover" src="${escapeHtml(s.image_path)}" alt="${escapeHtml(s.name)}" style="width:64px;height:64px;object-fit:contain">
          <div style="font-size:12px;font-weight:500;word-break:break-all">${escapeHtml(s.name)}</div>
          ${s.description ? `<div style="font-size:11px;color:var(--text-muted)">${escapeHtml(s.description)}</div>` : ''}
          <button class="btn-icon" data-sticker-delete="${s.id}" title="${t('stickerEditor.removeTitle')}">${icons.trash(14)}</button>
        </div>`).join('')
    : `<div class="empty-state" style="height:auto;padding:16px 0"><p>${t('stickerEditor.emptyState')}</p></div>`;

  gridEl.querySelectorAll('[data-sticker-delete]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try { await remove(Number(btn.dataset.stickerDelete)); onChange(); }
      catch (err) { toast(apiErrorMessage(err, t('stickerEditor.removeError')), { type: 'error' }); }
    });
  });

  let chosenFile = null;
  const fileInput = container.querySelector('#st-file-input');
  container.querySelector('#st-file-btn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    chosenFile = fileInput.files[0] || null;
    container.querySelector('#st-file-name').textContent = chosenFile ? chosenFile.name : '';
  });

  container.querySelector('#st-upload-btn').addEventListener('click', async () => {
    const name = container.querySelector('#st-name').value.trim();
    const description = container.querySelector('#st-desc').value.trim();
    const errEl = container.querySelector('#st-err');
    if (!/^[a-zA-Z0-9_]{2,32}$/.test(name)) { errEl.textContent = t('stickerEditor.nameInvalid'); return; }
    if (!chosenFile) { errEl.textContent = t('stickerEditor.chooseImageFirst'); return; }
    try {
      await upload(name, description, chosenFile);
      onChange();
      toast(t('stickerEditor.uploadSuccess'));
    } catch (err) { errEl.textContent = apiErrorMessage(err, t('stickerEditor.uploadError')); }
  });
}
