import { escapeHtml } from './utils.js';
import { t, currentLanguage } from './i18n.js';
import { icons } from './icons.js';

const UNITS = [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]];

export function timeAgo(iso) {
  const secs = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  let rtf;
  try { rtf = new Intl.RelativeTimeFormat(currentLanguage(), { numeric: 'auto' }); } catch { rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' }); }
  for (const [unit, size] of UNITS) {
    if (Math.abs(secs) >= size) return rtf.format(Math.round(secs / size), unit);
  }
  return rtf.format(0, 'second');
}

function glyph(emoji, customEmoji) {
  const m = /^:([a-zA-Z0-9_]{2,32}):$/.exec(emoji || '');
  const custom = m && (customEmoji || []).find((e) => e.name.toLowerCase() === m[1].toLowerCase());
  return custom ? `<img class="custom-emoji" src="${escapeHtml(custom.image_path)}" alt="${escapeHtml(emoji)}">` : escapeHtml(emoji || '');
}

export function matchesPost(p, q) {
  if (!q) return true;
  const hay = `${p.title} ${p.preview?.content || ''} ${p.createdBy?.displayName || ''}`.toLowerCase();
  return hay.includes(q.toLowerCase());
}

export function sortPosts(posts, mode) {
  const key = mode === 'newest' ? (p) => p.createdAt : (p) => p.lastMessageAt || p.createdAt;
  return posts.slice().sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || new Date(key(b)) - new Date(key(a)));
}

export function forumCardHtml(p, { customEmoji, active = false, tag = 'div', colorFor, canPin = false } = {}) {
  const author = p.preview?.author || p.createdBy?.displayName || '';
  const color = colorFor ? colorFor(p.preview?.authorId ?? p.createdBy?.id) : null;
  const authorStyle = color ? ` style="color:${escapeHtml(color)}"` : '';
  const body = p.preview?.content ? `<span class="fc-author"${authorStyle}>${escapeHtml(author)}</span>: ${escapeHtml(p.preview.content)}` : '';
  const pinLabel = escapeHtml(t(p.pinned ? 'forum.unpinPost' : 'forum.pinPost'));
  return `<${tag} class="forum-card${p.archived ? ' archived' : ''}${p.pinned ? ' pinned' : ''}${active ? ' active' : ''}" data-id="${p.id}">
    <div class="fc-main">
      ${p.pinned ? `<div class="fc-pinned">${icons.pin(12)} ${t('forum.pinnedBadge')}</div>` : ''}
      <div class="fc-title">${escapeHtml(p.title)}${p.archived ? ` <span class="fc-badge">${icons.lock(11)} ${t('forum.closedBadge')}</span>` : ''}</div>
      ${body ? `<div class="fc-preview">${body}</div>` : ''}
      <div class="fc-foot">
        ${p.reactionCount ? `<span class="fc-react">${glyph(p.topEmoji, customEmoji)} ${p.reactionCount}</span>` : ''}
        <span class="fc-count">${icons.messageSquare(13)} ${p.messageCount}</span>
        <span class="fc-time">${escapeHtml(timeAgo(p.lastMessageAt || p.createdAt))}</span>
      </div>
    </div>
    ${p.thumbnail ? `<img class="fc-thumb" src="${escapeHtml(p.thumbnail)}" alt="" loading="lazy">` : ''}
    ${canPin ? `<span class="fc-pin-btn" role="button" tabindex="0" data-pin="${p.id}" title="${pinLabel}" aria-label="${pinLabel}">${icons.pin(16)}</span>` : ''}
  </${tag}>`;
}
