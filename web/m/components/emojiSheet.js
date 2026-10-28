import { openSheet } from './bottomSheet.js';
import { escapeHtml } from '../../js/utils.js';
import { t } from '../../js/i18n.js';
import { EMOJI_CATEGORIES } from '../../js/emoji-data.js';
import { EMOJI_SHORTCODES } from '../../js/emojiShortcodes.js';
import { isEmojiSupported } from '../../js/emojiSupport.js';

export const QUICK_EMOJI = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

const RECENT_KEY = 'mc.recentEmoji';
function recentEmoji() { try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch { return []; } }
function pushRecent(e) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([e, ...recentEmoji().filter((x) => x !== e)].slice(0, 24))); } catch { /* storage unavailable */ }
}

// Resolves to a unicode character, or ":name:" for a server custom emoji.
export function openEmojiSheet(customEmoji = []) {
  return new Promise((resolve) => {
    let chosen = null;
    const recent = recentEmoji();
    const cats = [
      customEmoji.length && { id: 'custom', icon: '⭐', label: t('emojiPicker.thisServer'), custom: customEmoji },
      recent.length && { id: 'recent', icon: '🕘', label: t('m.emojiRecent'), emoji: recent },
      ...EMOJI_CATEGORIES.filter((c) => c.id !== 'all').map((c) => ({ ...c, emoji: c.emoji.filter(isEmojiSupported) })).filter((c) => c.emoji.length),
    ].filter(Boolean);
    const shortcodes = Object.entries(EMOJI_SHORTCODES);
    const cell = (e) => (e.image_path
      ? `<button class="m-emoji-btn" data-e=":${escapeHtml(e.name)}:" title=":${escapeHtml(e.name)}:"><img class="custom-emoji" src="${escapeHtml(e.image_path)}" alt=":${escapeHtml(e.name)}:"></button>`
      : `<button class="m-emoji-btn" data-e="${escapeHtml(e)}">${e}</button>`);
    openSheet({
      html: `<input class="m-input" id="e-search" placeholder="${escapeHtml(t('m.emojiSearch'))}" autocomplete="off">
        <div class="m-emoji-tabs" id="e-tabs">${cats.map((c) => `<button data-cat="${c.id}" title="${escapeHtml(c.label)}">${c.icon}</button>`).join('')}</div>
        <div class="m-emoji-scroll" id="e-list"></div>`,
      onMount: (body, close) => {
        const list = body.querySelector('#e-list');
        const paint = (q) => {
          q = q.trim().toLowerCase();
          if (q) {
            const custom = customEmoji.filter((e) => e.name.toLowerCase().includes(q));
            const named = shortcodes.filter(([n]) => n.includes(q)).map(([, g]) => g);
            list.innerHTML = custom.length || named.length
              ? `<div class="m-emoji-grid">${custom.map(cell).join('')}${[...new Set(named)].map(cell).join('')}</div>`
              : `<div class="m-empty">${t('m.emojiNone')}</div>`;
            return;
          }
          list.innerHTML = cats.map((c) => `<div class="m-emoji-label" id="cat-${c.id}">${escapeHtml(c.label)}</div>
            <div class="m-emoji-grid">${(c.custom || c.emoji).map(cell).join('')}</div>`).join('');
        };
        paint('');
        body.querySelector('#e-search').addEventListener('input', (ev) => paint(ev.target.value));
        body.querySelector('#e-tabs').addEventListener('click', (ev) => {
          const b = ev.target.closest('[data-cat]');
          if (b) { body.querySelector('#e-search').value = ''; paint(''); list.querySelector(`#cat-${b.dataset.cat}`)?.scrollIntoView({ block: 'start' }); }
        });
        body.addEventListener('click', (ev) => {
          const b = ev.target.closest('[data-e]');
          if (b) { chosen = b.dataset.e; pushRecent(chosen); close(); }
        });
      },
      onClose: () => resolve(chosen),
    });
  });
}

export function openStickerSheet(ctx) {
  return new Promise((resolve) => {
    let chosen = null;
    const stickers = ctx.detail?.stickers || [];
    openSheet({
      title: t('m.stickers'),
      html: `<input class="m-input" id="s-search" placeholder="${escapeHtml(t('stickerPicker.searchPlaceholder'))}" autocomplete="off"><div id="s-grid"></div>`,
      onMount: (body, close) => {
        const grid = body.querySelector('#s-grid');
        const paint = (q) => {
          q = q.trim().toLowerCase();
          const shown = q ? stickers.filter((s) => s.name.toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q)) : stickers;
          grid.innerHTML = shown.length
            ? `<div class="m-sticker-grid">${shown.map((s) => `<button class="m-sticker-btn" data-s="${s.id}"><img class="anim-hover" src="${escapeHtml(s.image_path)}" alt="${escapeHtml(s.name)}"><small>${escapeHtml(s.name)}</small></button>`).join('')}</div>`
            : `<div class="m-empty">${t('stickerPicker.noMatching')}</div>`;
        };
        paint('');
        body.querySelector('#s-search').addEventListener('input', (ev) => paint(ev.target.value));
        body.addEventListener('click', (ev) => {
          const b = ev.target.closest('[data-s]');
          if (b) { chosen = Number(b.dataset.s); close(); }
        });
      },
      onClose: () => resolve(chosen),
    });
  });
}
