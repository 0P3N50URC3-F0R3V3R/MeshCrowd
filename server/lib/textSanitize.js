'use strict';

// Strips newlines/tabs/control characters from user-supplied text that's always rendered inline
// as a single line (display names, nicknames, server/channel/role names, topics, status text).
// Without this, a name containing "\n" can visually split into multiple lines wherever it's
// rendered — e.g. faking a second line of chat under a real message, or breaking a member-list/
// channel-header layout — a text-injection trick distinct from HTML/SQL injection but just as
// exploitable for spoofing since escapeHtml() alone doesn't stop a literal newline from rendering.
function singleLine(value, maxLen = 200) {
  return String(value ?? '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

// Custom-status emoji: exactly one standard Unicode emoji (one grapheme, so ZWJ sequences, skin
// tones and flags survive). Anything else — ":name:" custom-emoji shortcodes, plain text, several
// emoji — collapses to '' since custom emoji/stickers are server-scoped and don't resolve elsewhere.
const EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
const COMBINING_KEYCAP = 0x20e3;
const isKeycap = (g) => /^[0-9#*]/.test(g) && g.codePointAt(g.length - 1) === COMBINING_KEYCAP;
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
function statusEmoji(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const graphemes = [...segmenter.segment(text)];
  if (graphemes.length !== 1) return '';
  const g = graphemes[0].segment;
  return g.length <= 32 && (EMOJI_RE.test(g) || isKeycap(g)) ? g : '';
}

module.exports = { singleLine, statusEmoji };
