'use strict';

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

// Font *keys* only — the actual CSS font-stack values live entirely on the client
// (web/js/theme.js FONT_STACKS), same split as serverLayout.js's FOLDER_COLORS/FOLDER_BUILTIN_ICONS
// (browser ESM vs server CJS, kept in sync by hand). Must match that file's FONT_STACKS keys.
const FONT_KEYS = new Set(['default', 'serif', 'mono', 'comic', 'verdana']);

const COLOR_FIELDS = ['brand', 'bgRail', 'bgSidebar', 'bgPrimary', 'bgFloating', 'textPrimary', 'textSecondary', 'gradFrom', 'gradTo'];

const DEFAULT_THEME = Object.freeze({
  brand: '', bgRail: '', bgSidebar: '', bgPrimary: '', bgFloating: '', textPrimary: '', textSecondary: '', font: 'default',
  gradFrom: '', gradTo: '', gradAngle: 135,
});

// Validates/normalizes a client-submitted theme down to a known-safe shape: every color field is
// either empty (meaning "use the app default") or a strict #rrggbb hex, and font is one of a
// fixed allowlist — this never becomes free-form CSS. A raw "paste your own CSS" box would let a
// shared theme carry url()/@import (external-request beaconing, or a style-based clickjacking
// overlay over the real UI); generating the actual CSS text ourselves from these validated fields
// closes that off entirely. Anything invalid is dropped back to the default rather than erroring,
// same convention as sanitizeServerLayout.
function sanitizeTheme(input) {
  const out = { ...DEFAULT_THEME };
  if (!input || typeof input !== 'object') return out;
  for (const field of COLOR_FIELDS) {
    const v = input[field];
    if (v === '' || (typeof v === 'string' && HEX_RE.test(v))) out[field] = v;
  }
  if (Number.isInteger(input.gradAngle) && input.gradAngle >= 0 && input.gradAngle <= 360) out.gradAngle = input.gradAngle;
  if (typeof input.font === 'string' && FONT_KEYS.has(input.font)) out.font = input.font;
  return out;
}

module.exports = { sanitizeTheme, DEFAULT_THEME, FONT_KEYS, COLOR_FIELDS };
