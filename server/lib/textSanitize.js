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

// Display names allow any text (every script, emoji, symbols) but not characters that make the GUI or
// the server logic misbehave: control and line characters, invisible/format characters (zero-width,
// bidi overrides and isolates, tag characters, byte-order marks), unpaired surrogates, private-use
// and non-characters. ZWJ and variation selectors stay because emoji sequences need them, and runs of
// combining marks are capped so stacked "zalgo" text cannot spill out of its row. Length counts
// characters (code points), not UTF-16 units, so an emoji is never cut in half.
const BS = String.fromCharCode(92);
const cp = (n) => `${BS}u{${n.toString(16)}}`;
const charClass = (ranges) => `[${ranges.map(([a, b]) => (a === b ? cp(a) : `${cp(a)}-${cp(b)}`)).join('')}]`;
const DISALLOWED_NAME_CHARS = new RegExp(charClass([
  [0x0, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x34f, 0x34f], [0x61c, 0x61c], [0x115f, 0x1160], [0x17b4, 0x17b5],
  [0x180b, 0x180f], [0x200b, 0x200c], [0x200e, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0x2800, 0x2800],
  [0x3164, 0x3164], [0xfeff, 0xfeff], [0xffa0, 0xffa0], [0xfff0, 0xffff], [0xe000, 0xf8ff],
  [0xe0000, 0xe007f], [0xe0100, 0xe01ef], [0xf0000, 0x10ffff],
]), 'gu');
const COMBINING_RUN = new RegExp(`(${BS}p{M}{3})${BS}p{M}+`, 'gu');

function displayName(value, maxLen = 32) {
  const cleaned = String(value ?? '')
    .toWellFormed()
    .normalize('NFC')
    .replace(DISALLOWED_NAME_CHARS, ' ')
    .replace(COMBINING_RUN, '$1')
    .replace(/\s+/gu, ' ')
    .trim();
  return Array.from(cleaned).slice(0, maxLen).join('').trim();
}

module.exports = { singleLine, displayName, statusEmoji };
