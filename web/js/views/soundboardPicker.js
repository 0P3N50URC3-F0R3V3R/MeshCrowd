import { escapeHtml } from '../utils.js';
import { t } from '../i18n.js';

// Soundboard popover anchored above the voice panel's soundboard button. Picking a sound doesn't
// play anything locally — `onPick(sound)` just sends the play request; the actual playback comes
// back as a ws:voice_soundboard_play broadcast to everyone in the room, sender included, so every
// participant (even the one who clicked) plays from the exact same trigger.
export function openSoundboardPicker(anchorEl, sounds, onPick) {
  document.querySelectorAll('.sticker-picker').forEach((n) => n.remove());

  const picker = document.createElement('div');
  picker.className = 'emoji-picker sticker-picker';
  let query = '';

  function renderList() {
    const list = picker.querySelector('.ep-list');
    const q = query.trim().toLowerCase();
    const matches = q ? sounds.filter((s) => s.name.toLowerCase().includes(q)) : sounds;
    list.innerHTML = matches.length
      ? `<div class="ep-cat-label">${t('soundboardPicker.thisServer')}</div>
         <div class="sticker-grid">${matches.map((s) => `
           <button class="sticker-item" type="button" data-sound-id="${s.id}" title="${escapeHtml(s.name)}">
             <span style="font-size:28px;line-height:56px">${escapeHtml(s.emoji) || '🔊'}</span>
             <span>${escapeHtml(s.name)}</span>
           </button>`).join('')}</div>`
      : `<div class="ep-cat-label">${sounds.length ? t('soundboardPicker.noMatching') : t('soundboardPicker.noneUploaded')}</div>`;
    list.querySelectorAll('.sticker-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        const sound = sounds.find((s) => s.id === Number(btn.dataset.soundId));
        if (sound) onPick(sound);
      });
    });
  }

  picker.innerHTML = `
    <div class="ep-search">
      <input type="text" placeholder="${t('soundboardPicker.searchPlaceholder')}" id="sb-search-input">
    </div>
    <div class="ep-list"></div>`;

  document.body.appendChild(picker);
  positionPicker();
  renderList();

  picker.querySelector('#sb-search-input').addEventListener('input', (e) => {
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
