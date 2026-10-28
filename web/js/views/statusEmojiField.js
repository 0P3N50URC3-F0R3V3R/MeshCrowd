import { escapeHtml } from '../utils.js';
import { openEmojiPicker } from './emojiPicker.js';
import { t } from '../i18n.js';

// Custom-status emoji chooser: a button that opens the full standard emoji picker (no
// custom/server emoji — those only resolve inside their own server). The chosen value lives in a
// hidden <input id=inputId> so callers read it exactly like the plain text field it replaced.
export function statusEmojiFieldHtml(inputId, value) {
  return `
    <input type="hidden" id="${inputId}" value="${escapeHtml(value || '')}">
    <button type="button" class="btn btn-secondary status-emoji-btn" data-emoji-btn="${inputId}" title="${t('userBar.pickStatusEmoji')}">${escapeHtml(value || '🙂')}</button>
    <button type="button" class="btn-icon status-emoji-clear" data-emoji-clear="${inputId}" title="${t('userBar.clearStatusEmoji')}" ${value ? '' : 'hidden'}>✕</button>`;
}

export function bindStatusEmojiField(root, inputId) {
  const input = root.querySelector(`#${inputId}`);
  const btn = root.querySelector(`[data-emoji-btn="${inputId}"]`);
  const clear = root.querySelector(`[data-emoji-clear="${inputId}"]`);
  const set = (emoji) => {
    input.value = emoji;
    btn.textContent = emoji || '🙂';
    clear.hidden = !emoji;
  };
  btn.addEventListener('click', () => openEmojiPicker(btn, (emoji) => {
    set(emoji);
    document.querySelectorAll('.emoji-picker').forEach((n) => n.remove());
  }));
  clear.addEventListener('click', () => set(''));
  return set;
}
