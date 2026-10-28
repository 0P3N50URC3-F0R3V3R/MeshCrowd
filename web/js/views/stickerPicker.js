import { escapeHtml } from '../utils.js';
import { t } from '../i18n.js';

// Sticker picker anchored above the composer's sticker button. Unlike the emoji picker, picking
// a sticker doesn't insert text — `onPick(sticker)` sends it immediately, same as Discord (a
// sticker is its own thing attached to a message, not typed inline).
export function openStickerPicker(anchorEl, stickers, onPick) {
  document.querySelectorAll('.sticker-picker').forEach((n) => n.remove());

  const picker = document.createElement('div');
  picker.className = 'emoji-picker sticker-picker';
  let query = '';

  function renderList() {
    const list = picker.querySelector('.ep-list');
    const q = query.trim().toLowerCase();
    const matches = q ? stickers.filter((s) => s.name.toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q)) : stickers;
    list.innerHTML = matches.length
      ? `<div class="ep-cat-label">${t('stickerPicker.thisServer')}</div>
         <div class="sticker-grid">${matches.map((s) => `
           <button class="sticker-item" type="button" data-sticker-id="${s.id}" title="${escapeHtml(s.name)}${s.description ? ` — ${escapeHtml(s.description)}` : ''}">
             <img class="anim-hover" src="${escapeHtml(s.image_path)}" alt="${escapeHtml(s.name)}">
             <span>${escapeHtml(s.name)}</span>
           </button>`).join('')}</div>`
      : `<div class="ep-cat-label">${stickers.length ? t('stickerPicker.noMatching') : t('stickerPicker.noneUploaded')}</div>`;
    list.querySelectorAll('.sticker-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        const sticker = stickers.find((s) => s.id === Number(btn.dataset.stickerId));
        if (sticker) { onPick(sticker); remove(); }
      });
    });
  }

  picker.innerHTML = `
    <div class="ep-search">
      <input type="text" placeholder="${t('stickerPicker.searchPlaceholder')}" id="sp-search-input">
    </div>
    <div class="ep-list"></div>`;

  document.body.appendChild(picker);
  positionPicker();
  renderList();

  picker.querySelector('#sp-search-input').addEventListener('input', (e) => {
    query = e.target.value;
    renderList();
  });

  function positionPicker() {
    picker.style.position = 'fixed';
    const rect = anchorEl.getBoundingClientRect();
    const pickerWidth = 320;
    const pickerHeight = 360;
    let left = rect.right - pickerWidth;
    let top = rect.top - pickerHeight - 8;
    if (top < 8) top = rect.bottom + 8;
    left = Math.max(8, Math.min(left, window.innerWidth - pickerWidth - 8));
    picker.style.left = `${left}px`;
    picker.style.top = `${top}px`;
  }

  function remove() {
    picker.remove();
    document.removeEventListener('mousedown', onDocClick);
    document.removeEventListener('keydown', onKey);
  }
  function onDocClick(e) {
    if (!picker.contains(e.target) && e.target !== anchorEl && !anchorEl.contains(e.target)) remove();
  }
  function onKey(e) { if (e.key === 'Escape') remove(); }
  setTimeout(() => {
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
  }, 0);

  return { remove };
}
