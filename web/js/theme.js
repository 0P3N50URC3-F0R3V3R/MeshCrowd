// Per-user custom theme: a curated set of CSS custom-property overrides (colors + font), built
// from the picker UI in Settings > Appearance. Deliberately NOT free-form CSS — see
// server/lib/theme.js sanitizeTheme for why (closes off url()/@import-based abuse a raw
// "paste your own CSS" box would allow). This module and the server's sanitizeTheme must stay in
// sync by hand on field names and the font-key allowlist, same split as icons.js/serverLayout.js
// already have between the browser (ESM) and server (CJS) sides.

export const FONT_STACKS = {
  default: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji", sans-serif',
  serif: 'Georgia, Cambria, "Times New Roman", Times, serif',
  mono: '"Cascadia Code", Consolas, "SF Mono", monospace',
  comic: '"Comic Sans MS", "Comic Sans", cursive',
  verdana: 'Verdana, Geneva, sans-serif',
};
export const FONT_LABELS = { default: 'Default', serif: 'Serif', mono: 'Monospace', comic: 'Comic Sans', verdana: 'Verdana' };

// `default` is the app's actual built-in value for that variable (see web/css/base.css :root) —
// used to seed a native <input type=color> when the user hasn't overridden that field (an empty
// theme value means "inherit the app default", but the color input itself needs *some* hex).
export const COLOR_FIELDS = [
  { key: 'brand', label: 'Accent Color', cssVar: '--brand', default: '#0d9488' },
  { key: 'bgRail', label: 'Server Rail', cssVar: '--bg-rail', default: '#1e1f22' },
  { key: 'bgSidebar', label: 'Sidebar', cssVar: '--bg-sidebar', default: '#2b2d31' },
  { key: 'bgPrimary', label: 'Chat Background', cssVar: '--bg-primary', default: '#313338' },
  { key: 'bgFloating', label: 'Popover / Modal', cssVar: '--bg-floating', default: '#111214' },
  { key: 'textPrimary', label: 'Primary Text', cssVar: '--text-primary', default: '#f2f3f5' },
  { key: 'textSecondary', label: 'Secondary Text', cssVar: '--text-secondary', default: '#b5bac1' },
];

export const GRADIENT_FIELDS = [
  { key: 'gradFrom', label: 'Gradient Start', default: '#0d9488' },
  { key: 'gradTo', label: 'Gradient End', default: '#1e1f22' },
];

export const DEFAULT_THEME = {
  brand: '', bgRail: '', bgSidebar: '', bgPrimary: '', bgFloating: '', textPrimary: '', textSecondary: '', font: 'default',
  gradFrom: '', gradTo: '', gradAngle: 135,
};

// One-click starting points. "MeshCrowd Dark" is just DEFAULT_THEME (the app's own built-in look
// already IS Discord-dark-styled) — listed explicitly so it shows up as a selectable card instead
// of being an unlabeled implicit option.
export const PRESETS = [
  { name: 'MeshCrowd Dark', theme: { ...DEFAULT_THEME } },
  { name: 'MeshCrowd Light', theme: { brand: '#0d9488', bgRail: '#e3e5e8', bgSidebar: '#f2f3f5', bgPrimary: '#ffffff', bgFloating: '#ffffff', textPrimary: '#060607', textSecondary: '#4e5058', font: 'default' } },
  { name: 'Midnight Purple', theme: { brand: '#9b59f6', bgRail: '#15111f', bgSidebar: '#1c1730', bgPrimary: '#211c38', bgFloating: '#100d1c', textPrimary: '#f0eaff', textSecondary: '#b9a9e8', font: 'default' } },
  { name: 'Forest', theme: { brand: '#2f9e5c', bgRail: '#101a14', bgSidebar: '#16261c', bgPrimary: '#1b2e22', bgFloating: '#0c140f', textPrimary: '#e7f5ec', textSecondary: '#a3c4ae', font: 'default' } },
  { name: 'Sunset', theme: { brand: '#f2683f', bgRail: '#1f1512', bgSidebar: '#2b1c17', bgPrimary: '#33221c', bgFloating: '#180f0c', textPrimary: '#fcece5', textSecondary: '#d9ab97', font: 'default' } },
  { name: 'High Contrast', theme: { brand: '#ffcc00', bgRail: '#000000', bgSidebar: '#000000', bgPrimary: '#000000', bgFloating: '#000000', textPrimary: '#ffffff', textSecondary: '#ffffff', font: 'default' } },
];

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function clamp255(v) { return Math.max(0, Math.min(255, v)); }
function darken(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const r = clamp255((n >> 16) - amount);
  const g = clamp255(((n >> 8) & 0xff) - amount);
  const b = clamp255((n & 0xff) - amount);
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
function relativeLuminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

// Builds the actual `:root{...}` override text from a validated theme object — this exact string
// is both what gets injected into the page AND what the "Copy CSS" export box shows, so sharing a
// theme with someone else really is "paste this block into Settings > Appearance > Import".
export function generateCss(theme) {
  const t = theme || DEFAULT_THEME;
  const lines = [];
  for (const { key, cssVar } of COLOR_FIELDS) {
    const v = t[key];
    if (v && HEX_RE.test(v)) lines.push(`  ${cssVar}: ${v};`);
  }
  if (t.brand && HEX_RE.test(t.brand)) {
    lines.push(`  --brand-hover: ${darken(t.brand, 20)};`);
    lines.push(`  --brand-light: ${darken(t.brand, -20)};`);
  }
  // Form fields and secondary buttons (--bg-input/--bg-active/--bg-hover) aren't themselves
  // user-pickable fields - they're derived from the chat background so a preset like "Discord
  // Light" doesn't leave every input/secondary-button stuck on base.css's hardcoded dark default
  // while everything else around it turned light. Luminance decides the direction: a light
  // background needs its surfaces darkened a step to stand out; a dark one needs them lightened.
  if (t.bgPrimary && HEX_RE.test(t.bgPrimary)) {
    const isLight = relativeLuminance(t.bgPrimary) > 0.5;
    const step = isLight ? 1 : -1;
    lines.push(`  --bg-input: ${darken(t.bgPrimary, step * 14)};`);
    lines.push(`  --bg-hover: ${darken(t.bgPrimary, step * 8)};`);
    lines.push(`  --bg-active: ${darken(t.bgPrimary, step * 22)};`);
    lines.push(`  --bg-active-hover: ${darken(t.bgPrimary, step * 30)};`);
    lines.push(`  --bg-message-hover: ${darken(t.bgPrimary, step * 6)};`);
  }
  if (t.gradFrom && HEX_RE.test(t.gradFrom) && t.gradTo && HEX_RE.test(t.gradTo)) {
    const angle = Number.isInteger(t.gradAngle) && t.gradAngle >= 0 && t.gradAngle <= 360 ? t.gradAngle : 135;
    lines.push(`  --bg-gradient: linear-gradient(${angle}deg, ${t.gradFrom}, ${t.gradTo});`);
  }
  if (t.font && t.font !== 'default' && FONT_STACKS[t.font]) {
    lines.push(`  --font-stack: ${FONT_STACKS[t.font]};`);
  }
  if (lines.length === 0) return '';
  return `:root {\n${lines.join('\n')}\n}`;
}

// Parses a previously-exported (or shared) CSS block back into a theme object, for the "Import
// CSS" box. Same allowlist as the server's sanitizeTheme: only the exact custom properties this
// builder itself writes are recognized — anything else in a pasted block (selectors, url(),
// @import, unrelated properties) is simply ignored, never applied.
export function parseCss(cssText) {
  const theme = { ...DEFAULT_THEME };
  const varToKey = Object.fromEntries(COLOR_FIELDS.map((f) => [f.cssVar, f.key]));
  const re = /(--[a-z-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g;
  let m;
  while ((m = re.exec(String(cssText || '')))) {
    const key = varToKey[m[1]];
    if (key) theme[key] = m[2];
  }
  const gradMatch = String(cssText || '').match(/--bg-gradient\s*:\s*linear-gradient\((\d{1,3})deg,\s*(#[0-9a-fA-F]{6}),\s*(#[0-9a-fA-F]{6})\)\s*;/);
  if (gradMatch && Number(gradMatch[1]) <= 360) {
    theme.gradAngle = Number(gradMatch[1]); theme.gradFrom = gradMatch[2]; theme.gradTo = gradMatch[3];
  }
  const fontMatch = String(cssText || '').match(/--font-stack\s*:\s*([^;]+);/);
  if (fontMatch) {
    const value = fontMatch[1].trim();
    const found = Object.entries(FONT_STACKS).find(([, stack]) => stack === value);
    if (found) theme.font = found[0];
  }
  return theme;
}

let styleEl = null;
export function applyTheme(theme) {
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'user-theme';
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = generateCss(theme);
}
