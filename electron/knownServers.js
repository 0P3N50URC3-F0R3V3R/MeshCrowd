'use strict';

const MAX_SERVERS = 50;
const MAX_NAME = 60;
const MAX_ICON_URI = 24000;
const MODES = [null, 'keep', 'session'];

function normalizeOrigin(raw) {
  if (typeof raw !== 'string') return null;
  let u;
  try { u = new URL(raw.trim()); } catch { return null; }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) return null;
  return u.origin;
}

const sameOrigin = (a, b) => normalizeOrigin(a) === normalizeOrigin(b);

function upsert(list, { url, name, icon }, now) {
  const origin = normalizeOrigin(url);
  if (!origin) return list;
  const prev = list.find((e) => e.url === origin);
  const cleanName = String(name || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME) || new URL(origin).host;
  const cleanIcon = typeof icon === 'string' && icon.startsWith('data:image/png;base64,') && icon.length <= MAX_ICON_URI ? icon : '';
  const entry = { url: origin, name: cleanName, icon: cleanIcon, lastUsed: now, signIn: prev ? prev.signIn : null };
  return [entry, ...list.filter((e) => e.url !== origin)].slice(0, MAX_SERVERS);
}

const remove = (list, url) => list.filter((e) => !sameOrigin(e.url, url));

function setSignIn(list, url, mode) {
  if (!MODES.includes(mode)) return list;
  return list.map((e) => (sameOrigin(e.url, url) ? { ...e, signIn: mode } : e));
}

// A page can only ask for https servers, or an http one the user already connected to on purpose.
function switchTarget(raw, list) {
  const origin = normalizeOrigin(raw);
  if (!origin) return null;
  return origin.startsWith('https:') || list.some((e) => e.url === origin) ? origin : null;
}

module.exports = { normalizeOrigin, sameOrigin, upsert, remove, setSignIn, switchTarget, MAX_SERVERS };
