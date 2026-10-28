import { EMOJI_CATEGORIES } from '../emoji-data.js';
import { isEmojiSupported } from '../emojiSupport.js';
import { escapeHtml } from '../utils.js';
import { nextZIndex } from '../zstack.js';
import { t } from '../i18n.js';

// Built-in emoji this device can actually draw, computed once per session.
let supportedCategories = null;
function getSupportedCategories() {
  supportedCategories = supportedCategories || EMOJI_CATEGORIES
    .map((cat) => ({ ...cat, emoji: cat.emoji.filter(isEmojiSupported) }))
    .filter((cat) => cat.emoji.length);
  return supportedCategories;
}

// Popover emoji picker anchored above the composer's emoji button. `onPick(value)` receives a raw
// unicode character for a built-in emoji, or a ":name:" shortcode for a server custom emoji.
// `customEmoji` (optional, [{id, name, image_path}]) adds a "This Server" tab of uploaded images —
// self-hosted (data/emoji/), no third-party emoji service involved.
export function openEmojiPicker(anchorEl, onPick, customEmoji = []) {
  document.querySelectorAll('.emoji-picker').forEach((n) => n.remove());

  const picker = document.createElement('div');
  picker.className = 'emoji-picker';
  const categories = customEmoji.length
    ? [{ id: 'custom', label: t('emojiPicker.thisServer'), icon: '⭐', custom: true, emoji: customEmoji }, ...getSupportedCategories()]
    : getSupportedCategories();
  let activeCat = categories[0].id;
  let query = '';

  function renderCategoryGrid(cat) {
    if (cat.custom) {
      return `
        <div class="ep-cat-label">${cat.label}</div>
        <div class="ep-grid">${cat.emoji.map((e) => `
          <button class="ep-emoji" type="button" data-custom-name="${escapeHtml(e.name)}" title=":${escapeHtml(e.name)}:">
            <img src="${escapeHtml(e.image_path)}" alt=":${escapeHtml(e.name)}:" style="width:22px;height:22px;object-fit:contain">
          </button>`).join('')}</div>`;
    }
    return `
      <div class="ep-cat-label">${cat.label}</div>
      <div class="ep-grid">${cat.emoji.map((e) => `<button class="ep-emoji" type="button">${e}</button>`).join('')}</div>`;
  }

  function wireEmojiButtons(list) {
    list.querySelectorAll('.ep-emoji').forEach((btn) => {
      btn.addEventListener('click', () => onPick(btn.dataset.customName ? `:${btn.dataset.customName}:` : btn.textContent));
    });
  }

  function renderList() {
    const list = picker.querySelector('.ep-list');
    const q = query.trim().toLowerCase();
    if (q) {
      const matches = categories.filter((cat) => cat.label.toLowerCase().includes(q));
      list.innerHTML = matches.length
        ? matches.map(renderCategoryGrid).join('')
        : `<div class="ep-cat-label">${t('emojiPicker.noMatchingCategories')}</div>`;
    } else {
      const cat = categories.find((c) => c.id === activeCat) || categories[0];
      list.innerHTML = renderCategoryGrid(cat);
    }
    wireEmojiButtons(list);
  }

  picker.innerHTML = `
    <div class="ep-search">
      <input type="text" placeholder="${t('emojiPicker.searchPlaceholder')}" id="ep-search-input">
    </div>
    <div class="ep-tabs">
      ${categories.map((c) => `<button type="button" data-cat="${c.id}" class="${c.id === activeCat ? 'active' : ''}">${c.icon}</button>`).join('')}
    </div>
    <div class="ep-list"></div>`;

  picker.style.zIndex = nextZIndex();
  document.body.appendChild(picker);
  positionPicker();
  renderList();

  picker.querySelectorAll('.ep-tabs button').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeCat = btn.dataset.cat;
      query = '';
      picker.querySelector('#ep-search-input').value = '';
      picker.querySelectorAll('.ep-tabs button').forEach((b) => b.classList.toggle('active', b === btn));
      renderList();
    });
  });
  picker.querySelector('#ep-search-input').addEventListener('input', (e) => {
    query = e.target.value;
    renderList();
  });

  // Fixed-position popover computed from the anchor's own screen position, clamped to the
  // viewport — works for any anchor (composer button, a message's react button, etc.), not just
  // ones inside a positioned container.
  function positionPicker() {
    picker.style.position = 'fixed';
    const rect = anchorEl.getBoundingClientRect();
    const pickerWidth = 340;
    const pickerHeight = 380;
    let left = rect.right - pickerWidth;
    let top = rect.top - pickerHeight - 8;
    if (top < 8) top = rect.bottom + 8; // not enough room above — drop it below the anchor instead
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
