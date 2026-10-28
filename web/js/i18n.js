import { api } from './api.js';

const FALLBACK_CODE = 'en';
const STORAGE_KEY = 'dismesh_lang';

let activeCode = FALLBACK_CODE;
let dict = {};       // active language, merged over English
let baseDict = {};   // English, always loaded as the fallback floor

function getPath(obj, dotPath) {
  return dotPath.split('.').reduce((acc, k) => (acc && typeof acc === 'object' ? acc[k] : undefined), obj);
}

function deepMerge(base, override) {
  const out = { ...base };
  for (const key of Object.keys(override || {})) {
    const b = base?.[key];
    const o = override[key];
    out[key] = (b && typeof b === 'object' && o && typeof o === 'object') ? deepMerge(b, o) : o;
  }
  return out;
}

async function fetchLangFile(code) {
  const res = await fetch(`/lang/${code}.json`, { credentials: 'include' });
  if (!res.ok) throw new Error(`language file ${code} not found`);
  return res.json();
}

function guessBrowserCode(available) {
  const langs = navigator.languages || [navigator.language || FALLBACK_CODE];
  for (const l of langs) {
    const short = l.slice(0, 2).toLowerCase();
    if (available.has(short)) return short;
  }
  return FALLBACK_CODE;
}

// Resolves the language to use and loads it. `user` is the logged-in user (camelCase, may be
// null pre-login). English is always loaded first as the fallback floor, then the chosen
// language is merged over it so a partial translation never breaks the UI.
export async function initI18n(user) {
  baseDict = await fetchLangFile(FALLBACK_CODE).catch(() => ({}));

  let code = user?.language;
  if (!code) {
    try { code = window.localStorage.getItem(STORAGE_KEY) || undefined; } catch { /* ignore */ }
  }
  if (!code) {
    let available = new Set([FALLBACK_CODE]);
    try {
      const { languages } = await api.getLanguages();
      available = new Set(languages.map((l) => l.code));
    } catch { /* stay on English if the list can't be fetched */ }
    code = guessBrowserCode(available);
  }

  if (code === FALLBACK_CODE) {
    activeCode = FALLBACK_CODE;
    dict = baseDict;
    return;
  }

  try {
    const override = await fetchLangFile(code);
    dict = deepMerge(baseDict, override);
    activeCode = code;
  } catch {
    // Chosen language is missing/disabled (e.g. an admin removed it) — fall back to English
    // rather than breaking the UI.
    activeCode = FALLBACK_CODE;
    dict = baseDict;
  }
}

export function currentLanguage() {
  return activeCode;
}

// Persists the pre-login pick so returning to the login screen keeps it (there's no account yet
// to store it on). A logged-in user's choice lives server-side instead (see api.setMyLanguage).
export function setPreLoginLanguage(code) {
  try { window.localStorage.setItem(STORAGE_KEY, code); } catch { /* ignore */ }
}

// `t('chat.userJoined', { user: 'Alice' })` — dot-path lookup + `{placeholder}` substitution.
// Falls back to the key itself if missing from both the active language and English, so a
// typo'd key is visibly wrong rather than silently blank. Returns plain text: callers assigning
// the result via `innerHTML` (instead of `textContent`) must escapeHtml() any interpolated
// values themselves, same as the app's existing convention for user-controlled content.
export function t(key, vars) {
  const value = getPath(dict, key);
  const str = typeof value === 'string' ? value : key;
  if (!vars) return str;
  return str.replace(/\{(\w+)\}/g, (_, name) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : `{${name}}`));
}

// Fills any `data-i18n="key"` static markup once the language has resolved.
export function applyStaticI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
}
