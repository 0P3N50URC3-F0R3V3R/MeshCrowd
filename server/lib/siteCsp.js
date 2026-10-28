'use strict';

const MAX_ORIGINS = 20;

function normalizeOne(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s || s.includes('*') || /\s/.test(s)) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  if (u.pathname !== '/' || u.search || u.hash) return null;
  return u.origin;
}

function normalizeOrigins(list) {
  if (!Array.isArray(list)) return { ok: false, error: 'origins must be a list' };
  if (list.length > MAX_ORIGINS) return { ok: false, error: `at most ${MAX_ORIGINS} origins` };
  const out = [];
  for (const item of list) {
    const o = normalizeOne(item);
    if (!o) return { ok: false, error: `invalid origin: ${String(item).slice(0, 100)}` };
    if (!out.includes(o)) out.push(o);
  }
  return { ok: true, origins: out };
}

function buildSiteCsp(origins) {
  const o = origins.length ? ` ${origins.join(' ')}` : '';
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${o}`,
    `style-src 'self' 'unsafe-inline'${o}`,
    `img-src 'self' data: blob:${o}`,
    `font-src 'self' data:${o}`,
    `connect-src 'self'${o}`,
    origins.length ? `frame-src ${origins.join(' ')}` : "frame-src 'none'",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

module.exports = { normalizeOrigins, buildSiteCsp, MAX_ORIGINS };
