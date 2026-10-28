import { icons } from './icons.js';
import { EMOJI_SHORTCODES } from './emojiShortcodes.js';

export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Exact inverse of escapeHtml's 5-entity mapping — needed because fenced code blocks reach
// applyMarkdown already escaped (renderMessageContent always escapes first), but highlight.js
// needs genuinely raw source to tokenize correctly (an escaped "&lt;" in a JS comparison like
// `a < b` would otherwise never match the language grammar's `<` operator pattern).
function unescapeHtml(str) {
  return str.replace(/&amp;|&lt;|&gt;|&quot;|&#39;/g, (e) => ({
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  }[e]));
}

// Self-hosted (no CDN, no third-party network calls) via @highlightjs/cdn-assets, served locally
// from server/index.js's /vendor/highlightjs static mount. Core + a curated language subset
// (not the full ~190-language bundle) to keep the one-time fetch small. Fire-and-forget at
// module load — by the time any real message with a code block renders, this has long since
// resolved; until then, fenced blocks just render unhighlighted (graceful, no error).
const HLJS_LANGUAGES = [
  'javascript', 'typescript', 'python', 'bash', 'shell', 'json', 'css', 'xml', 'sql', 'java',
  'c', 'cpp', 'csharp', 'go', 'rust', 'php', 'ruby', 'yaml', 'markdown', 'dockerfile',
  'powershell', 'kotlin', 'swift', 'lua', 'ini', 'plaintext',
];
let hljs = null;
(async () => {
  try {
    const core = await import('/vendor/highlightjs/es/core.min.js');
    const instance = core.default;
    await Promise.all(HLJS_LANGUAGES.map(async (lang) => {
      const mod = await import(`/vendor/highlightjs/es/languages/${lang}.min.js`);
      instance.registerLanguage(lang, mod.default);
    }));
    hljs = instance;
  } catch { /* highlighting stays unavailable; fenced blocks render as plain code */ }
})();

// Admin-gated raw-HTML messages (per-server opt-in, servers.raw_html_enabled): a ```html fenced
// block renders as sanitized live HTML instead of a code block. Self-hosted DOMPurify, no CDN.
// FORBID_TAGS blocks iframe/object/embed deliberately — the dedicated embeddable-page feature has
// its own admin-configured allowlist of trusted URLs; this general per-message mode must not
// become a side-door around that, so anyone who can send a message gets formatting, not embeds.
let purify = null;
(async () => {
  try { purify = (await import('/vendor/dompurify/purify.es.mjs')).default; } catch { /* raw HTML stays disabled, renders as plain code */ }
})();
const HTML_FORBID_TAGS = ['iframe', 'object', 'embed', 'script', 'style', 'link', 'meta', 'base', 'form', 'input', 'svg'];

// Turns escaped text content into HTML with clickable links, @mentions, #channel references,
// and line breaks preserved via CSS white-space (caller sets white-space: pre-wrap).
// `channels`, when passed (server-channel scope only), resolves #name against real channels in
// the current server so only actual channels become clickable refs — everything else (e.g. a
// GitHub "#123") stays plain text. @mentions are styled on sight, unresolved — there's no
// autocomplete to guarantee the name is real, so treat it the same way Discord's own renderer
// does for a raw, non-autocompleted "@word".
const URL_RE = /(https?:\/\/[^\s<]+)/g;
const MENTION_RE = /@([a-zA-Z0-9_.]{2,32})/g;
const CHANNEL_REF_RE = /#([a-zA-Z0-9_-]{1,80})/g;

function linkifyMentionsAndChannels(text, channels, styleMentions = true) {
  let out = styleMentions ? text.replace(MENTION_RE, (m, name) => `<span class="mention">@${name}</span>`) : text;
  if (channels && channels.length) {
    out = out.replace(CHANNEL_REF_RE, (m, name) => {
      const ch = channels.find((c) => c.name.toLowerCase() === name.toLowerCase());
      return ch ? `<span class="channel-ref" data-channel-id="${ch.id}">#${escapeHtml(ch.name)}</span>` : m;
    });
  }
  return out;
}

// :name: -> an inline <img> for a server's own uploaded custom emoji (self-hosted, data/emoji/ —
// no third-party emoji service). Runs alongside mentions/channel-refs, before applyMarkdown, so
// it shares that same pre-existing limitation of not being backtick-code-span-aware.
const CUSTOM_EMOJI_RE = /:([a-zA-Z0-9_+-]{2,32}):/g;
function replaceCustomEmoji(text, customEmoji) {
  return text.replace(CUSTOM_EMOJI_RE, (m, name) => {
    const lower = name.toLowerCase();
    const found = customEmoji?.find((e) => e.name.toLowerCase() === lower);
    if (found) return `<img class="custom-emoji" src="${escapeHtml(found.image_path)}" alt=":${name}:" title=":${name}:">`;
    return Object.hasOwn(EMOJI_SHORTCODES, lower) ? EMOJI_SHORTCODES[lower] : m;
  });
}

// Discord-style markdown ("bbcodes" in the old IRC sense): **bold**, *italic*/_italic_,
// ***bold italic***, __underline__, ~~strikethrough~~, `inline code`, ```fenced code```,
// # / ## / ### headings, -# subtext, - / * bullet lists, > blockquote (one line) / >>>
// blockquote (rest of the message), ||spoiler||. Applied to an already-HTML-escaped string, so
// none of these punctuation marks need escaping themselves — only real `<`/`>`/etc from the
// original message content do, and escapeHtml already handled those before this runs.
//
// \x01 is a control character that never appears in ordinary message text, so it's a safe
// placeholder delimiter — unlike a plain "space-digit-space" marker, it can't collide with real
// content in the message. The stash itself is local to each call, not module-level, so it can't
// grow unbounded across the many renderMessageContent() calls a full message-list re-render makes.
const STASH_MARK = '\x01';

// Line-start markers: headings, subtext, bullets, and both blockquote forms. `>>>` (multi-line
// quote) is a whole-message-from-here trigger in real Discord — everything from that marker to
// the end becomes one blockquote, not just that line — so it's handled as a separate first pass
// before the single-line markers below (a `>>>` line would otherwise just match the `>` bullet
// prefix rule and only quote itself).
function applyLineMarkers(text) {
  const lines = text.split(/\r\n|\r|\n/);
  const multiIdx = lines.findIndex((l) => /^&gt;&gt;&gt;\s?/.test(l));
  if (multiIdx !== -1) {
    const head = lines.slice(0, multiIdx).map(applySingleLineMarker);
    const quoted = lines.slice(multiIdx);
    quoted[0] = quoted[0].replace(/^&gt;&gt;&gt;\s?/, '');
    return [...head, `<span class="md-quote-block">${quoted.join('\n')}</span>`].join('\n');
  }
  return lines.map(applySingleLineMarker).join('\n');
}

function applySingleLineMarker(line) {
  let m;
  if ((m = line.match(/^###\s+(.*)$/))) return `<span class="md-h3">${m[1]}</span>`;
  if ((m = line.match(/^##\s+(.*)$/))) return `<span class="md-h2">${m[1]}</span>`;
  if ((m = line.match(/^#\s+(.*)$/))) return `<span class="md-h1">${m[1]}</span>`;
  if ((m = line.match(/^-#\s+(.*)$/))) return `<span class="md-subtext">${m[1]}</span>`;
  if ((m = line.match(/^[-*]\s+(.*)$/))) return `<span class="md-bullet">${m[1]}</span>`;
  if ((m = line.match(/^&gt;\s?(.*)$/))) return `<span class="md-quote-line">${m[1]}</span>`;
  return line;
}

// Pulls fenced/inline code out and replaces it with a stash marker — must run on the FULL
// message text before URL-splitting (renderMessageContent), not per-segment: a URL inside a code
// span (very common — code comments link to things) would otherwise get cut out by the URL split,
// leaving an unbalanced ``` behind that falls through as broken plain text instead of code. This
// bit everything downstream of a code block: syntax highlighting, diff coloring, and especially
// raw-HTML sanitization, where unsanitized-looking markup leaking through as literal text is a
// much better failure mode than it would be for an actual live-HTML feature, but still wrong.
function extractCode(text, stashCode, rawHtmlEnabled) {
  text = text.replace(/```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g, (m, lang, code) => {
    const language = lang.toLowerCase();
    if (language === 'html' && rawHtmlEnabled && purify) {
      const clean = purify.sanitize(unescapeHtml(code), { FORBID_TAGS: HTML_FORBID_TAGS, FORBID_ATTR: ['style'] });
      return stashCode(`<div class="md-raw-html">${clean}</div>`);
    }
    if (language === 'diff') {
      const html = code.split('\n').map((line) => {
        if (/^\+(?!\+\+)/.test(line)) return `<span class="md-diff-add">${line}</span>`;
        if (/^-(?!--)/.test(line)) return `<span class="md-diff-del">${line}</span>`;
        if (/^@@/.test(line)) return `<span class="md-diff-hunk">${line}</span>`;
        return line;
      }).join('\n');
      return stashCode(`<pre class="md-codeblock md-diff"><code>${html}</code></pre>`);
    }
    if (language && hljs?.getLanguage(language)) {
      const highlighted = hljs.highlight(unescapeHtml(code), { language }).value;
      return stashCode(`<pre class="md-codeblock hljs"><code>${highlighted}</code></pre>`);
    }
    return stashCode(`<pre class="md-codeblock"><code>${code}</code></pre>`);
  });
  return text.replace(/`([^`\n]+)`/g, (m, code) => stashCode(`<code class="md-code">${code}</code>`));
}

function applyMarkdown(text) {
  text = text.replace(/~~(.+?)~~/g, '<del>$1</del>');
  text = text.replace(/__(.+?)__/g, '<u>$1</u>');
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(?<![*\w])\*(?!\s)(.+?)(?<!\s)\*(?!\*)/g, '<em>$1</em>');
  text = text.replace(/(?<![_\w])_(?!\s)(.+?)(?<!\s)_(?!\w)/g, '<em>$1</em>');
  text = text.replace(/\|\|(.+?)\|\|/g, '<span class="md-spoiler" data-action="spoiler">$1</span>');

  return applyLineMarkers(text);
}

// `remote` content comes from another instance: its @names do not refer to anyone on this one, so
// they are not styled as mentions, and it never gets raw HTML, channel refs or this server's emoji.
export function renderMessageContent(content, { channels, customEmoji, rawHtmlEnabled, remote = false } = {}) {
  const stash = [];
  const stashCode = (html) => { stash.push(html); return `${STASH_MARK}${stash.length - 1}${STASH_MARK}`; };
  const unstashCode = (t) => t.replace(new RegExp(`${STASH_MARK}(\\d+)${STASH_MARK}`, 'g'), (m, i) => stash[Number(i)]);

  // Code extraction runs once, on the whole message, before URL-splitting — see extractCode's
  // own comment for why that order matters.
  // A backslash before a markdown character makes it literal (`\_` shows `_`); stashed like code so
  // the markdown passes never see it. A lone backslash, paths and `\\` are left untouched.
  const withCodeStashed = extractCode(escapeHtml(content), stashCode, remote ? false : rawHtmlEnabled)
    .replace(/\\([*_~|])/g, (m, ch) => stashCode(ch));

  // Split keeps URL_RE's capture group in the result, alternating [text, url, text, url, ...] —
  // process markdown/@/#/emoji only in the text segments so a URL's own '#fragment', '@', or
  // stray markdown-looking punctuation never gets touched.
  const linked = withCodeStashed.split(URL_RE).map((part, i) => (i % 2 === 1
    ? `<a href="${part}" target="_blank" rel="noopener noreferrer">${part}</a>`
    : applyMarkdown(replaceCustomEmoji(linkifyMentionsAndChannels(part, remote ? null : channels, !remote), remote ? null : customEmoji)))).join('');

  return unstashCode(linked);
}

// A message body that is *only* emoji (and whitespace) renders large, like Discord — either a
// handful of real Unicode emoji, or a handful of :shortcode: custom emoji (not a mix; keeping the
// two checks separate is simpler than a combined regex and the mixed case is rare enough not to
// bother with).
const EMOJI_ONLY_RE = /^(?:\p{Extended_Pictographic}️?‍?|\s)+$/u;
const CUSTOM_EMOJI_ONLY_RE = /^:[a-zA-Z0-9_]{2,32}:$/;
export function isEmojiOnly(content, customEmoji) {
  const trimmed = (content || '').trim();
  if (trimmed.length === 0) return false;
  if (trimmed.length <= 24 && EMOJI_ONLY_RE.test(trimmed)) return true;
  if (customEmoji && customEmoji.length) {
    const tokens = trimmed.split(/\s+/);
    if (tokens.length <= 6 && tokens.every((t) => CUSTOM_EMOJI_ONLY_RE.test(t)
      && customEmoji.some((e) => e.name.toLowerCase() === t.slice(1, -1).toLowerCase()))) return true;
  }
  return false;
}

export function initials(name) {
  const s = (name || '').trim();
  if (!s) return '?';
  const parts = s.split(/\s+/);
  if (parts.length === 1) return s.slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

const AVATAR_PALETTE = ['#0d9488', '#57f287', '#fee75c', '#eb459e', '#ed4245', '#f0b232', '#00a8fc', '#0891b2'];
export function colorForId(id) {
  const n = Number(id) || 0;
  return AVATAR_PALETTE[n % AVATAR_PALETTE.length];
}

export function avatarHtml(user, size = 40) {
  const style = `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.4)}px`;
  if (user?.avatarPath) {
    return `<img class="avatar" style="${style}" src="${escapeHtml(user.avatarPath)}" alt="" draggable="false">`;
  }
  const bg = colorForId(user?.id);
  return `<div class="avatar avatar-fallback" style="${style};background:${bg}">${escapeHtml(initials(user?.displayName || user?.username))}</div>`;
}

// Profile card top ("banner") background: image wins over color, falls back to the CSS default
// gradient when neither is set.
export function bannerStyle(user) {
  if (user?.bannerPath) return `background-image:url('${escapeHtml(user.bannerPath)}');background-size:cover;background-position:center;`;
  if (user?.bannerColor) return `background:${escapeHtml(user.bannerColor)};`;
  return '';
}

// Profile card bottom ("card") background. An image always gets a darkening gradient baked in —
// the name/username/bio text sits directly on top of it and needs to stay legible regardless of
// what the image looks like; a flat color needs no such treatment.
export function cardStyle(user) {
  if (user?.cardPath) {
    return `background-image:linear-gradient(180deg, rgba(0,0,0,.35), rgba(0,0,0,.75)), url('${escapeHtml(user.cardPath)}');background-size:cover;background-position:center;`;
  }
  if (user?.cardColor) return `background:${escapeHtml(user.cardColor)};`;
  return '';
}

export function serverIconHtml(server, size = 48) {
  const style = `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.4)}px`;
  const iconPath = server?.icon_path || server?.iconPath;
  if (server?.kind === 'site' && !iconPath) return icons.globe(Math.round(size * 0.5));
  if (iconPath) {
    return `<img style="${style};width:100%;height:100%;object-fit:cover" src="${escapeHtml(iconPath)}" alt="" draggable="false">`;
  }
  return `<span>${escapeHtml(serverInitials(server?.name))}</span>`;
}

function serverInitials(name) {
  const s = (name || '').trim();
  if (!s) return '?';
  return s.split(/\s+/).map((w) => w[0]).slice(0, 3).join('').toUpperCase();
}

export function formatTimestamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  const isYest = d.toDateString() === yest.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return `Today at ${time}`;
  if (isYest) return `Yesterday at ${time}`;
  return `${d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric', year: 'numeric' })} ${time}`;
}

export function formatShortTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function isImageMime(mime) {
  return /^image\/(png|jpe?g|gif|webp|avif)$/i.test(mime || '');
}

// Inline video preview covers the formats every major browser plays natively via <video> with no
// extra codec/plugin — self-hosted file, same /uploads/attachments origin as everything else here.
export function isVideoMime(mime) {
  return /^video\/(mp4|webm|ogg)$/i.test(mime || '');
}

// Compact attachment thumbnails for a message preview context too narrow for the full chat-view
// attachment size (pinned messages, search results) — images shrink to fit, everything else is
// just a small filename chip. Caller supplies the wrapper class (e.g. "pi-attachments").
export function renderCompactAttachments(attachments, wrapperClass) {
  if (!attachments || !attachments.length) return '';
  return `<div class="${wrapperClass}">${attachments.map((a) => (
    isImageMime(a.mimeType)
      ? `<img class="compact-attachment-thumb" src="${escapeHtml(a.url)}" alt="${escapeHtml(a.fileName)}" loading="lazy">`
      : `<span class="compact-attachment-file">${icons.file(13)}${escapeHtml(a.fileName)}</span>`
  )).join('')}</div>`;
}

// Same idea for a poll — too small a space for the real interactive card, so just the question
// with a chart glyph.
export function renderCompactPoll(poll) {
  if (!poll) return '';
  return `<div class="compact-poll">${icons.barChart(13)} ${escapeHtml(poll.question)}</div>`;
}

let toastHost = null;
// The settings overlays rebuild their tab strip on every render; keep the phone's scroll position
// and keep the active tab in view instead of snapping back to the first tab.
export function navScroll(overlay) {
  return overlay.querySelector('.settings-nav')?.scrollLeft || 0;
}
export function restoreNavScroll(overlay, x) {
  const nav = overlay.querySelector('.settings-nav');
  if (!nav) return;
  nav.scrollLeft = x;
  const a = nav.querySelector('.snav-item.active');
  if (!a || nav.scrollWidth <= nav.clientWidth) return;
  const l = a.offsetLeft - nav.offsetLeft;
  if (l < x) nav.scrollLeft = l - 8;
  else if (l + a.offsetWidth > x + nav.clientWidth) nav.scrollLeft = l + a.offsetWidth - nav.clientWidth + 8;
}

export function toast(message, { type = 'info', ttl = 4000, action } = {}) {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.className = 'toast-stack';
    document.body.appendChild(toastHost);
  }
  const node = document.createElement('div');
  node.className = `toast ${type === 'error' ? 'error' : ''}`;
  node.textContent = message;
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => { action.onClick?.(); node.remove(); });
    node.appendChild(btn);
  }
  toastHost.appendChild(node);
  setTimeout(() => node.remove(), ttl);
}

export function apiErrorMessage(err, fallback = 'something went wrong') {
  if (err && err.body && err.body.error) return err.body.error;
  if (err && err.message) return err.message;
  return fallback;
}
