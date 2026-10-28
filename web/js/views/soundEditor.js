import { icons } from '../icons.js';
import { escapeHtml, toast, apiErrorMessage } from '../utils.js';
import { openEmojiPicker } from './emojiPicker.js';
import { t } from '../i18n.js';

// Shared grid+upload-form UI for managing a server's soundboard — used by both Server Settings
// (per-server MANAGE_SERVER) and the site Admin Panel (MANAGE_ANY_SERVER, any server). Mirrors
// stickerEditor.js's shape, but each row gets a Play preview button instead of an image thumbnail
// since there's nothing to show visually beyond the emoji the uploader picked for it.
export function renderSoundEditor(container, { sounds, upload, remove, onChange }) {
  let pendingEmoji = '';
  container.innerHTML = `
    <p class="hint" style="margin:0 0 16px">${t('soundEditor.hint')}</p>
    <div class="field">
      <label>${t('soundEditor.uploadNewLabel')}</label>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button type="button" class="btn btn-secondary" id="sn-emoji-btn" style="width:44px;font-size:18px">${pendingEmoji || icons.smile(18)}</button>
        <input class="input" id="sn-name" placeholder="${t('soundEditor.namePlaceholder')}" maxlength="32" style="width:180px">
        <button type="button" class="btn btn-secondary" id="sn-file-btn">${t('soundEditor.chooseAudio')}</button>
        <input type="file" id="sn-file-input" class="hidden" accept="audio/mpeg,audio/ogg,audio/wav,audio/webm">
        <span id="sn-file-name" class="hint"></span>
      </div>
      <div class="hint" style="margin-top:6px">${t('soundEditor.fileHint')}</div>
      <div class="error-text" id="sn-err"></div>
      <button class="btn btn-primary" id="sn-upload-btn" style="margin-top:10px">${t('soundEditor.uploadButton')}</button>
    </div>
    <div class="divider"></div>
    <div class="field">
      <label>${sounds.length} ${sounds.length === 1 ? t('soundEditor.countSingular') : t('soundEditor.countPlural')}</label>
      <div id="sn-list"></div>
    </div>`;

  const listEl = container.querySelector('#sn-list');
  listEl.innerHTML = sounds.length
    ? sounds.map((s) => `
        <div class="list-row" data-sound="${s.id}">
          <button class="btn-icon" data-sound-play="${s.id}" title="${t('soundEditor.previewTitle')}">${s.emoji ? escapeHtml(s.emoji) : icons.music(18)}</button>
          <div class="lr-main"><div class="lr-title">${escapeHtml(s.name)}</div></div>
          <div class="lr-actions">
            <button class="btn-icon" data-sound-delete="${s.id}" title="${t('soundEditor.removeTitle')}">${icons.trash(16)}</button>
          </div>
        </div>`).join('')
    : `<div class="empty-state" style="height:auto;padding:16px 0"><p>${t('soundEditor.emptyState')}</p></div>`;

  listEl.querySelectorAll('[data-sound-play]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sound = sounds.find((s) => s.id === Number(btn.dataset.soundPlay));
      if (sound) new Audio(sound.audio_path).play().catch(() => {});
    });
  });
  listEl.querySelectorAll('[data-sound-delete]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try { await remove(Number(btn.dataset.soundDelete)); onChange(); }
      catch (err) { toast(apiErrorMessage(err, t('soundEditor.removeError')), { type: 'error' }); }
    });
  });

  let chosenFile = null;
  const fileInput = container.querySelector('#sn-file-input');
  container.querySelector('#sn-file-btn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    chosenFile = fileInput.files[0] || null;
    container.querySelector('#sn-file-name').textContent = chosenFile ? chosenFile.name : '';
  });

  const emojiBtn = container.querySelector('#sn-emoji-btn');
  emojiBtn.addEventListener('click', () => {
    openEmojiPicker(emojiBtn, (emoji) => {
      pendingEmoji = emoji;
      emojiBtn.textContent = emoji;
    });
  });

  container.querySelector('#sn-upload-btn').addEventListener('click', async () => {
    const name = container.querySelector('#sn-name').value.trim();
    const errEl = container.querySelector('#sn-err');
    if (!/^[a-zA-Z0-9_]{2,32}$/.test(name)) { errEl.textContent = t('soundEditor.nameInvalid'); return; }
    if (!chosenFile) { errEl.textContent = t('soundEditor.chooseAudioFirst'); return; }
    try {
      await upload(name, pendingEmoji, chosenFile);
      onChange();
      toast(t('soundEditor.uploadSuccess'));
    } catch (err) { errEl.textContent = apiErrorMessage(err, t('soundEditor.uploadError')); }
  });
}
