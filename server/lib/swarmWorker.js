'use strict';

const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const advert = require('./swarmAdvert');
const instanceProfile = require('./instanceProfile');
const registration = require('./registration');
const { safeFetch } = require('./federationSsrf');

const BACKOFF_FIRST = 60_000;
const BACKOFF_MAX = 3_600_000;
const STALE_AFTER = 3_600_000;
const MAX_ENTRIES_PER_TRACKER = 500;
const MAX_FUTURE_SKEW = 5 * 60_000;

const STATE_FILE = path.join(path.dirname(config.CONFIG_PATH), 'swarm-state.json');
const MAX_DELETE_TRIES = 3;

// config.json can be edited by hand or with `config set`, so trackers are re-checked every time they are read.
function cleanTrackers(list) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (typeof item !== 'string') continue;
    let u;
    try { u = new URL(item.trim()); } catch { continue; }
    const loopbackTest = process.env.DISMESH_FEDERATION_ALLOW_LOOPBACK === '1' && u.protocol === 'http:';
    if ((u.protocol !== 'https:' && !loopbackTest) || u.username || u.password || u.search || u.hash) continue;
    const base = `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
    if (!out.includes(base)) out.push(base);
  }
  return out.slice(0, 20);
}

// Why this server cannot be advertised right now (trackers only accept an https address), or null.
function addressProblem(cfg) {
  const given = cfg.federationPublicUrl ? String(cfg.federationPublicUrl).trim() : '';
  if (!given && !cfg.useHttps) return 'This server is not served over https. Set federationPublicUrl to its public https address to advertise it.';
  if (!given && !String(cfg.publicHost || '').trim()) return 'publicHost is empty, so there is no address to advertise.';
  try {
    const u = new URL(ownUrl(cfg));
    if (u.protocol !== 'https:' || u.username || u.password || !u.hostname) throw new Error('bad');
  } catch { return 'The public address is not a valid https address (check publicHost, httpsPort and federationPublicUrl).'; }
  return null;
}

function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { fingerprint: typeof s.fingerprint === 'string' ? s.fingerprint : null, updated: Number(s.updated) || 0, announcedTo: cleanTrackers(s.announcedTo) };
  } catch { return { fingerprint: null, updated: 0, announcedTo: [] }; }
}

function ownUrl(cfg) {
  const own = cfg.federationPublicUrl ? String(cfg.federationPublicUrl).replace(/\/+$/, '') : '';
  if (own) return own;
  return `https://${cfg.publicHost}${Number(cfg.httpsPort) === 443 ? '' : `:${cfg.httpsPort}`}`;
}

function createWorker({ fetchImpl = safeFetch, now = Date.now, load = config.load, timeoutMs = 10_000 } = {}) {
  const trackers = new Map();
  let timer = null;
  const state = readState();
  const deleteTries = new Map();
  let problem = null;

  const saveState = () => { try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch { /* the data folder is read-only: the worker still runs */ } };

  const stateOf = (url) => {
    let st = trackers.get(url);
    if (!st) { st = { url, ok: null, lastSuccess: 0, lastError: '', nextTry: 0, failures: 0, entries: [] }; trackers.set(url, st); }
    return st;
  };

  function call(url, opts) {
    let t;
    const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('request timed out')), timeoutMs); });
    return Promise.race([Promise.resolve().then(() => fetchImpl(url, { ...opts, headers: opts.body === undefined ? opts.headers : { ...opts.headers, 'content-length': String(Buffer.byteLength(opts.body)) }, signal: AbortSignal.timeout(timeoutMs) })), timeout]).finally(() => clearTimeout(t));
  }

  function fail(st, err) {
    st.ok = false;
    st.failures += 1;
    st.lastError = String(err && err.message ? err.message : err).slice(0, 200);
    st.nextTry = now() + Math.min(BACKOFF_FIRST * 2 ** (st.failures - 1), BACKOFF_MAX);
  }

  function succeed(st) {
    st.ok = true;
    st.failures = 0;
    st.lastError = '';
    st.lastSuccess = now();
    st.nextTry = 0;
  }

  function currentAdvert(cfg) {
    const fields = {
      url: ownUrl(cfg), name: cfg.instance.name || '', description: cfg.instance.description || '',
      icon: instanceProfile.iconDataUri(), registration: registration.getMode(),
    };
    const fp = require('node:crypto').createHash('sha256').update(JSON.stringify(fields)).digest('hex');
    if (fp !== state.fingerprint) { state.fingerprint = fp; state.updated = now(); saveState(); }
    return advert.build({ ...fields, updated: state.updated });
  }

  async function talk(st, cfg, str, wantList) {
    try {
      if (str !== null) {
        const res = await call(`${st.url}/announce`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: str });
        if (!res.ok) throw new Error(`announce refused (${res.status})`);
      }
      if (wantList) {
        const res = await call(`${st.url}/list`, { method: 'GET' });
        if (!res.ok) throw new Error(`list refused (${res.status})`);
        const data = await res.json();
        const own = ownUrl(cfg);
        const out = [];
        for (const item of (Array.isArray(data && data.servers) ? data.servers : []).slice(0, MAX_ENTRIES_PER_TRACKER)) {
          const v = item && advert.verify(item.advert);
          if (v && v.ok && v.advert.url !== own && v.advert.updated <= now() + MAX_FUTURE_SKEW) out.push({ ...v.advert, lastSeen: Number(item.lastSeen) || 0 });
        }
        st.entries = out;
      }
      succeed(st);
    } catch (e) { fail(st, e); }
  }

  async function pass(force) {
    const cfg = load();
    const configured = cleanTrackers(cfg.swarm.trackers);
    problem = cfg.swarm.advertise ? addressProblem(cfg) : null;
    const urls = cfg.swarm.advertise && !problem ? configured : [];
    for (const url of [...trackers.keys()]) if (!configured.includes(url)) trackers.delete(url);

    // Anything that still holds our advert but should not (advertising off, tracker removed, address unusable,
    // also after a restart) is asked to drop it. A tracker that stays unreachable is given up on after a few passes.
    const stale = state.announcedTo.filter((u) => !urls.includes(u));
    if (stale.length) {
      const str = currentAdvert(cfg);
      await Promise.all(stale.map(async (u) => {
        try {
          await call(`${u}/announce`, { method: 'DELETE', headers: { 'content-type': 'text/plain' }, body: str });
          deleteTries.delete(u);
        } catch {
          const n = (deleteTries.get(u) || 0) + 1;
          if (n < MAX_DELETE_TRIES) { deleteTries.set(u, n); return; }
          deleteTries.delete(u);
        }
        state.announcedTo = state.announcedTo.filter((x) => x !== u);
      }));
      saveState();
    }
    if (!urls.length) {
      for (const st of trackers.values()) st.entries = [];
      return;
    }
    const str = currentAdvert(cfg);
    const due = urls.map(stateOf).filter((st) => force || st.nextTry <= now());
    await Promise.all(due.map(async (st) => {
      await talk(st, cfg, str, true);
      if (st.ok && !state.announcedTo.includes(st.url)) { state.announcedTo.push(st.url); saveState(); }
    }));
  }

  let current = null;
  let queued = false;
  let queuedForce = false;

  function run(force) {
    if (current) {
      queued = true;
      queuedForce = queuedForce || force;
      return current;
    }
    current = (async () => {
      let f = force;
      do {
        queued = false;
        try { await pass(f); } catch { /* a bad pass must never reach callers */ }
        f = queuedForce;
        queuedForce = false;
      } while (queued);
    })().finally(() => { current = null; });
    return current;
  }

  const pinned = new Map();

  function getList() {
    const cfg = load();
    if (!cfg.swarm.advertise) return { enabled: false, servers: [] };
    const byUrl = new Map();
    for (const st of trackers.values()) {
      if (!st.lastSuccess || now() - st.lastSuccess > STALE_AFTER) continue;
      for (const e of st.entries) {
        const group = byUrl.get(e.url) || new Map();
        byUrl.set(e.url, group);
        const mine = group.get(e.pub) || [];
        group.set(e.pub, [...mine, { e, tracker: st.url }]);
      }
    }
    const servers = [];
    for (const [url, group] of byUrl) {
      let best = null;
      for (const [pub, items] of group) {
        const rank = [new Set(items.map((i) => i.tracker)).size, pinned.get(url) === pub ? 1 : 0];
        if (!best || rank[0] > best.rank[0] || (rank[0] === best.rank[0] && rank[1] > best.rank[1])) best = { pub, items, rank };
      }
      pinned.set(url, best.pub);
      const newest = best.items.reduce((m, i) => (i.e.updated > m.e.updated ? i : m));
      const { pub, v, ...rest } = newest.e;
      servers.push({ ...rest, lastSeen: Math.max(...best.items.map((i) => i.e.lastSeen)), trackers: [...new Set(best.items.map((i) => i.tracker))] });
    }
    servers.sort((x, y) => x.name.localeCompare(y.name));
    return { enabled: true, servers };
  }

  function getStatus() {
    return [...trackers.values()].map(({ url, ok, lastSuccess, lastError, nextTry }) => ({ url, ok: ok === true, lastSuccess, lastError, nextTry }));
  }

  function schedule() {
    const secs = Math.max(60, Number(load().swarm.intervalSeconds) || 300);
    timer = setTimeout(async () => { await run(false); if (timer) schedule(); }, secs * 1000);
    timer.unref();
  }

  return {
    runPass: () => run(false),
    announceNow: () => run(true),
    start() { if (timer) return; run(false); schedule(); },
    stop() { if (timer) { clearTimeout(timer); timer = null; } },
    getList,
    getStatus,
    getProblem: () => problem,
    hasData: () => [...trackers.values()].some((st) => st.lastSuccess > 0),
  };
}

const worker = createWorker();

module.exports = { createWorker, worker, ownUrl, cleanTrackers, addressProblem };
