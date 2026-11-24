(function (root) {
  'use strict';

  const MAX_ADVERT = 32768;
  const MAX_ICON_URI = 24000;
  const MAX_PER_TRACKER = 500;
  const MAX_FUTURE_SKEW = 5 * 60_000;
  const REGISTRATION = ['open', 'invite', 'closed'];

  function b64uToBytes(s) {
    const pad = '='.repeat((4 - (s.length % 4)) % 4);
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  const fail = (error) => ({ ok: false, error });

  async function verifyAdvert(str) {
    if (typeof str !== 'string' || str.length > MAX_ADVERT) return fail('bad advert size');
    const parts = str.split('.');
    if (parts.length !== 2) return fail('bad advert format');
    let payload; let a;
    try {
      payload = b64uToBytes(parts[0]);
      a = JSON.parse(new TextDecoder().decode(payload));
    } catch { return fail('bad advert payload'); }
    if (!a || typeof a !== 'object' || a.v !== 1) return fail('unsupported advert');
    if (typeof a.name !== 'string' || a.name.length > 60 || typeof a.description !== 'string' || a.description.length > 300) return fail('bad advert text');
    if (a.icon !== null && (typeof a.icon !== 'string' || a.icon.length > MAX_ICON_URI || !a.icon.startsWith('data:image/png;base64,'))) return fail('bad advert icon');
    if (!REGISTRATION.includes(a.registration) || !Number.isFinite(a.updated) || typeof a.pub !== 'string') return fail('bad advert fields');
    if (typeof a.url !== 'string' || a.url.length > 200) return fail('bad advert url');
    let u;
    try { u = new URL(a.url); } catch { return fail('bad advert url'); }
    if (u.protocol !== 'https:' || u.username || u.password) return fail('bad advert url');
    try {
      const key = await root.crypto.subtle.importKey('raw', b64uToBytes(a.pub), { name: 'Ed25519' }, false, ['verify']);
      if (!(await root.crypto.subtle.verify({ name: 'Ed25519' }, key, b64uToBytes(parts[1]), payload))) return fail('bad signature');
    } catch { return fail('bad signature'); }
    const { url, name, description, icon, registration, updated, pub } = a;
    return { ok: true, advert: { url, name, description, icon, registration, updated, pub } };
  }

  async function readTracker(tracker, fetchImpl, now, timeoutMs) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${tracker}/list`, { signal: ctl.signal });
      if (!res.ok) throw new Error(`answered ${res.status}`);
      const data = await res.json();
      const items = (Array.isArray(data && data.servers) ? data.servers : []).slice(0, MAX_PER_TRACKER);
      const out = [];
      for (const item of await Promise.all(items.map(async (it) => ({ it, v: it ? await verifyAdvert(it.advert) : fail('empty') })))) {
        if (item.v.ok && item.v.advert.updated <= now() + MAX_FUTURE_SKEW) out.push({ ...item.v.advert, lastSeen: Number(item.it.lastSeen) || 0, tracker });
      }
      return out;
    } finally { clearTimeout(timer); }
  }

  async function loadList({ trackers, fetchImpl = root.fetch.bind(root), now = Date.now, timeoutMs = 8000 }) {
    const errors = [];
    const results = await Promise.all(trackers.map((t) => readTracker(t, fetchImpl, now, timeoutMs).catch((e) => { errors.push({ tracker: t, error: String(e && e.message ? e.message : e) }); return []; })));
    const byUrl = new Map();
    for (const e of results.flat()) {
      const group = byUrl.get(e.url) || new Map();
      byUrl.set(e.url, group);
      group.set(e.pub, [...(group.get(e.pub) || []), e]);
    }
    const servers = [];
    for (const group of byUrl.values()) {
      let best = null;
      for (const items of group.values()) {
        const n = new Set(items.map((i) => i.tracker)).size;
        if (!best || n > best.n) best = { n, items };
      }
      const newest = best.items.reduce((m, i) => (i.updated > m.updated ? i : m));
      const { pub, tracker, ...rest } = newest;
      servers.push({ ...rest, lastSeen: Math.max(...best.items.map((i) => i.lastSeen)), trackers: [...new Set(best.items.map((i) => i.tracker))] });
    }
    servers.sort((x, y) => x.name.localeCompare(y.name));
    return { servers, errors };
  }

  const api = { verifyAdvert, loadList };
  root.MeshSwarm = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof window !== 'undefined' ? window : globalThis));
