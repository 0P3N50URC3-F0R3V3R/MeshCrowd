// Shared harness for the SFU bug-hunt scenarios: throwaway servers (own temp data dirs, never data/),
// headless portable Chrome pages with fake media, a cookie API client, RTP measurements and a raw
// authenticated WebSocket. Every scenario script imports this and calls finish() at the end.
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const root = path.resolve(import.meta.dirname, '../../..');
const require = createRequire(import.meta.url);
export const { chromium, _electron } = require(path.join(root, 'node_modules/playwright'));
export const WebSocket = require(path.join(root, 'node_modules/ws'));
export const CHROME = path.join(root, 'ChromePortable/GoogleChromePortable/App/Chrome-bin/chrome.exe');
export const PASSWORD = 'huntpass1234';
export const KEEP = process.argv.includes('--keep');
export const en = JSON.parse(fs.readFileSync(path.join(root, 'lang/en.json'), 'utf8'));
export const hu = JSON.parse(fs.readFileSync(path.join(root, 'lang/hu.json'), 'utf8'));

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const started = Date.now();
export let failures = 0;
const results = [];
export const check = (name, cond, extra = '') => {
  console.log(cond ? 'PASS' : 'FAIL', name, extra);
  results.push({ name, ok: !!cond, extra });
  if (!cond) failures++;
  return !!cond;
};
export const note = (...a) => console.log('NOTE', ...a);
export const section = (name) => console.log(`\n== ${name}`);

export async function waitFor(fn, timeoutMs, intervalMs = 250) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= end) return null;
    await sleep(intervalMs);
  }
}

// ---- servers ----
export const servers = [];

export function seedDataDir({ port, sfuPort, mode = 'sfu', announcedHost = '127.0.0.1', extra = {} }) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-sfu-hunt-'));
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({
    useHttps: false, port,
    voice: { mode, sfu: { port: sfuPort, workers: 1, announcedHost } },
    ...extra,
  }));
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(path.join(data, 'dismesh.db'));
  d.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  d.prepare('INSERT OR IGNORE INTO meta (key,value) VALUES (?,?)').run('security_settings', JSON.stringify({ captcha: { registerRequired: false } }));
  d.close();
  return data;
}

// opts.data reuses an existing data dir (restart on the same data).
export async function startServer(opts) {
  if (opts.port < 8070 || opts.port > 8079) throw new Error('hunt servers use ports 8070-8079 only');
  const data = opts.data || seedDataDir(opts);
  const base = `http://localhost:${opts.port}`;
  const logPath = path.join(data, `server-${Date.now()}.log`);
  const log = fs.openSync(logPath, 'w');
  const proc = spawn(process.execPath, [path.join(root, 'server/index.js')], { cwd: root, env: { ...process.env, DISMESH_DATA_DIR: data, ...(opts.env || {}) }, stdio: ['ignore', log, log] });
  const exited = new Promise((r) => proc.once('exit', (code, sig) => r({ code, sig })));
  const srv = { proc, data, base, port: opts.port, logPath, log, exited, opts };
  servers.push(srv);
  const up = await waitFor(async () => { try { return (await fetch(`${base}/api/config`)).ok; } catch { return false; } }, 30000);
  if (!up) throw new Error(`server on ${opts.port} did not come up`);
  if (proc.exitCode !== null) throw new Error(`server on ${opts.port} exited (port in use?)`);
  return srv;
}

export function serverLog(srv) {
  try { return fs.readFileSync(srv.logPath, 'utf8'); } catch { return ''; }
}

// Lines that mean the server hit something it did not expect.
export function serverProblems(srv) {
  return serverLog(srv).split('\n').filter((l) => /uncaught|unhandled|TypeError|ReferenceError|RangeError|FATAL|\bat .+\.js:\d+/i.test(l));
}

export function childWorkerPids(pid) {
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | Where-Object { $_.Name -like 'mediasoup-worker*' } | ForEach-Object { $_.ProcessId }`], { encoding: 'utf8' });
  return out.split(/\s+/).filter(Boolean).map(Number);
}

export function processMemoryMb(pid) {
  const out = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).WorkingSet64`], { encoding: 'utf8' });
  return Math.round(Number(out.trim()) / 1048576);
}

export function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Kills only the server's own process tree (PID based), never by image name.
export async function stopServer(srv, { keepData = false } = {}) {
  if (srv.stopped) return;
  srv.stopped = true;
  let workers = [];
  try { workers = childWorkerPids(srv.proc.pid); } catch { /* best effort */ }
  if (srv.proc.exitCode === null) {
    try { execFileSync('taskkill', ['/pid', String(srv.proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
    await Promise.race([srv.exited, sleep(5000)]);
  }
  for (const pid of workers) if (alive(pid)) { try { process.kill(pid); } catch { /* raced */ } }
  try { fs.closeSync(srv.log); } catch { /* closed */ }
  const problems = serverProblems(srv);
  if (problems.length) console.log(`--- suspicious server log lines (:${srv.port}) ---\n${problems.slice(0, 40).join('\n')}`);
  if (failures) {
    const lines = serverLog(srv).trim().split('\n');
    console.log(`--- last server log lines (:${srv.port}) ---\n${lines.slice(-25).join('\n')}`);
  }
  srv.problems = problems;
  if (!keepData && !KEEP) {
    // the same data dir may still be used by a later server instance
    if (!servers.some((s) => s !== srv && s.data === srv.data && !s.stopped)) fs.rmSync(srv.data, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } else if (KEEP) console.log('kept', srv.data);
}

// ---- API ----
export class Api {
  constructor(base) { this.base = base; this.cookie = ''; this.user = null; }

  async req(method, p, body) {
    const init = { method, headers: {} };
    if (this.cookie) init.headers.cookie = this.cookie;
    if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
    const res = await fetch(this.base + p, init);
    const set = res.headers.getSetCookie?.() || [];
    if (set.length) this.cookie = set.map((c) => c.split(';')[0]).join('; ');
    const text = await res.text();
    if (!res.ok) { const e = new Error(`${method} ${p} -> ${res.status} ${text.slice(0, 300)}`); e.status = res.status; e.body = text; throw e; }
    return text ? JSON.parse(text) : null;
  }

  get(p) { return this.req('GET', p); }
  post(p, b = {}) { return this.req('POST', p, b); }
  patch(p, b = {}) { return this.req('PATCH', p, b); }
  put(p, b = {}) { return this.req('PUT', p, b); }
  del(p) { return this.req('DELETE', p); }

  async register(username) {
    this.user = (await this.post('/api/auth/register', { username, displayName: username, email: `${username}@hunt.local`, password: PASSWORD })).user;
    return this;
  }

  async login(username) {
    this.user = (await this.post('/api/auth/login', { username, password: PASSWORD })).user;
    return this;
  }

  session() { return /dismesh_session=([^;]+)/.exec(this.cookie)?.[1]; }
  calls() { return this.get('/api/admin/calls'); }
  sfuStatus() { return this.calls().then((c) => c.voice.status); }
}

// Standard world: admin alice + bob/carol/dave, one private server with voice rooms.
export async function world(srv, { users = ['alice', 'bob', 'carol', 'dave'], voice = ['Lounge'], stage = [], text = [] } = {}) {
  const apis = {};
  for (const u of users) apis[u] = await new Api(srv.base).register(u);
  const owner = apis[users[0]];
  const { server } = await owner.post('/api/servers', { name: 'Hunt', visibility: 'private' });
  const detail = await owner.get(`/api/servers/${server.id}`);
  for (const u of users.slice(1)) await apis[u].post('/api/servers/join', { inviteCode: detail.server.invite_code });
  const ch = {};
  for (const name of voice) ch[name] = (await owner.post(`/api/servers/${server.id}/channels`, { name, type: 'voice' })).channel;
  for (const name of stage) ch[name] = (await owner.post(`/api/servers/${server.id}/channels`, { name, type: 'stage' })).channel;
  for (const name of text) ch[name] = (await owner.post(`/api/servers/${server.id}/channels`, { name, type: 'text' })).channel;
  const general = (await owner.get(`/api/servers/${server.id}`)).channels.find((c) => c.type === 'public');
  return { apis, server, ch, general };
}

// ---- raw websocket ----
// Opens an authenticated socket and records every frame. Resolves once open.
export function rawSocket(srv, api) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://localhost:${srv.port}/ws`, { headers: { cookie: api.cookie, origin: srv.base } });
    const frames = [];
    const closed = new Promise((r) => sock.once('close', (code) => r(code)));
    const h = {
      sock, frames, closed,
      send: (m) => sock.send(typeof m === 'string' ? m : JSON.stringify(m)),
      sendRaw: (s) => sock.send(s),
      wait: (pred, ms = 5000) => waitFor(() => frames.find(pred), ms, 50),
      close: () => new Promise((r) => { if (sock.readyState === 3) return r(); sock.once('close', r); sock.close(); }),
      isOpen: () => sock.readyState === 1,
    };
    let n = 0;
    h.request = async (scope, op, data, ms = 5000) => {
      const id = `raw-${++n}-${Math.random().toString(36).slice(2, 7)}`;
      h.send({ type: 'sfu_request', id, ...scope, op, data });
      return h.wait((f) => f.type === 'sfu_response' && f.id === id, ms);
    };
    sock.on('message', (raw) => { try { frames.push(JSON.parse(raw.toString())); } catch { /* binary */ } });
    sock.on('open', () => resolve(h));
    sock.on('error', (e) => { if (sock.readyState !== 1) reject(e); });
  });
}

// ---- browsers ----
export const browsers = [];

export const INIT = `(() => {
  window.__states = []; window.__sent = []; window.__responses = {}; window.__toasts = []; window.__pcs = []; window.__frames = []; window.__sockets = [];
  let n = 0;
  const O = window.RTCPeerConnection;
  window.RTCPeerConnection = function (...a) { const pc = new O(...a); pc.__id = ++n; window.__pcs.push(pc); return pc; };
  window.RTCPeerConnection.prototype = O.prototype;
  const W = window.WebSocket;
  window.WebSocket = function (...a) {
    const s = new W(...a);
    window.__sockets.push(s);
    const send = s.send.bind(s);
    s.send = (d) => { try { window.__sent.push(JSON.parse(d)); } catch {} return send(d); };
    s.addEventListener('message', (e) => {
      try {
        const m = JSON.parse(e.data);
        if (m.type !== 'pong') window.__frames.push(m);
        if (window.__frames.length > 3000) window.__frames.splice(0, 1000);
        if (m.type === 'voice_state') window.__states.push(m);
        if (m.type === 'sfu_response') window.__responses[m.id] = m;
      } catch {}
    });
    return s;
  };
  window.WebSocket.prototype = W.prototype;
  Object.assign(window.WebSocket, { OPEN: 1, CONNECTING: 0, CLOSING: 2, CLOSED: 3 });
  document.addEventListener('DOMContentLoaded', () => {
    new MutationObserver((list) => {
      for (const r of list) for (const node of r.addedNodes) if (node.classList?.contains('toast')) window.__toasts.push(node.textContent);
    }).observe(document.body, { childList: true, subtree: true });
  });
})();`;

// Console errors that are expected noise, not bugs (checked case-insensitively).
const BENIGN = [/favicon/i, /Failed to load resource: the server responded with a status of 40[134]/i, /ERR_INTERNET_DISCONNECTED/i, /WebSocket connection to .* failed/i, /net::ERR_CONNECTION_REFUSED/i];

export async function openPage(name, { locale = 'en-US', viewport = { width: 1200, height: 800 }, extraArgs = [] } = {}) {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--auto-select-desktop-capture-source=Entire screen', ...extraArgs] });
  browsers.push(browser);
  const ctx = await browser.newContext({ viewport, permissions: ['microphone', 'camera'], locale });
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  page.__name = name;
  page.__errors = [];
  page.__benign = [];
  page.on('pageerror', (e) => { page.__errors.push(`pageerror: ${e.message}`); console.log(`PAGEERR[${name}]`, e.message); });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (BENIGN.some((r) => r.test(text))) { page.__benign.push(text); return; }
    page.__errors.push(`console.error: ${text}`);
    console.log(`CONSOLEERR[${name}]`, text.slice(0, 300));
  });
  return page;
}

// Logs in by handing the browser the API session cookie (no UI login, no auth rate limit).
export async function loginPage(page, srv, api, { path: p = '/' } = {}) {
  await page.context().addCookies([{ name: 'dismesh_session', value: api.session(), domain: 'localhost', path: '/', httpOnly: true }]);
  await page.goto(srv.base + p);
  await page.waitForSelector('.auth-screen, [data-server]', { timeout: 20000 });
  if (await page.$('.auth-screen')) throw new Error(`${page.__name}: cookie login landed on the auth screen`);
  await waitFor(() => page.evaluate(() => window.__sockets.some((s) => s.readyState === 1)), 10000);
}

export const navigate = (page, view) => page.evaluate((v) => import('/js/bus.js').then(({ bus }) => bus.emit('ui:navigate', v)), view);
export const wsSend = (page, msg) => page.evaluate((m) => import('/js/ws.js').then(({ ws }) => ws.send(m)), msg);

// #voice-panel is rebuilt on every channel switch, so a marked panel tells the old view from the new.
export async function openChannel(page, serverId, channelId) {
  await page.evaluate(() => document.getElementById('voice-panel')?.setAttribute('data-stale', ''));
  await navigate(page, { type: 'server', serverId, channelId });
}

export async function openVoice(page, serverId, channelId) {
  await openChannel(page, serverId, channelId);
  await page.waitForSelector('#voice-panel:not([data-stale]) .voice-controls', { timeout: 15000 });
}

export async function joinVoice(page, serverId, channelId) {
  await openVoice(page, serverId, channelId);
  await page.click('#voice-panel:not([data-stale]) #vc-join');
  await page.waitForSelector('#vc-leave', { timeout: 15000 });
}

export async function openDmCall(page, dmId) {
  await navigate(page, { type: 'dm', dmId, autoOpenCall: true });
  await page.waitForSelector('#dm-voice-panel .voice-controls', { timeout: 15000 });
}

export async function joinDm(page, dmId) {
  await openDmCall(page, dmId);
  await page.click('#dm-voice-panel #vc-join');
  await page.waitForSelector('#dm-voice-panel #vc-leave', { timeout: 15000 });
}

export async function leaveVoice(page) {
  await page.click('#vc-leave');
  await page.waitForSelector('#vc-join', { timeout: 10000 });
}

export const sentCount = (page, type) => page.evaluate((t) => window.__sent.filter((m) => m.type === t).length, type);
export const framesOf = (page, type) => page.evaluate((t) => window.__frames.filter((m) => m.type === t), type);
export const livePcIds = (page) => page.evaluate(() => window.__pcs.filter((pc) => pc.connectionState !== 'closed').map((pc) => pc.__id));
export const remoteAudioEls = (page) => page.evaluate(() => [...document.querySelectorAll('body > audio')]
  .filter((a) => a.srcObject?.getAudioTracks().some((t) => t.readyState === 'live')).length);
export const allAudioEls = (page) => page.evaluate(() => document.querySelectorAll('body > audio').length);
export const tileUids = (page) => page.$$eval('.voice-tile:not(.has-video) , .voice-tile', (els) => [...new Set(els.map((e) => Number(e.dataset.uid)))]);
export const lastState = (page, key) => page.evaluate((k) => window.__states.filter((s) => (k.dm ? s.dmChannelId === k.dm : s.channelId === k)).at(-1) || null, key);
export const toasts = (page) => page.evaluate(() => window.__toasts);
export const inCall = async (page) => (await page.$$('#vc-leave')).length > 0;

const mediaSample = (page) => page.evaluate(async () => {
  const inbound = {};
  let sent = 0, videoSent = 0;
  for (const pc of window.__pcs) {
    if (pc.connectionState === 'closed') continue;
    (await pc.getStats()).forEach((s) => {
      // mediasoup's bandwidth probe (mid 'probator') is not a participant's stream
      if (s.type === 'inbound-rtp' && s.mid !== 'probator') inbound[`${pc.__id}:${s.ssrc}`] = { kind: s.kind, packets: s.packetsReceived || 0, lost: s.packetsLost || 0, frames: s.framesDecoded || 0, bytes: s.bytesReceived || 0 };
      if (s.type === 'outbound-rtp' && s.kind === 'audio') sent += s.packetsSent || 0;
      if (s.type === 'outbound-rtp' && s.kind === 'video') videoSent += s.bytesSent || 0;
    });
  }
  return { inbound, sent, videoSent, t: performance.now() };
});

// Two stats samples `ms` apart per page; per kind how many inbound streams grew.
export async function measure(pages, ms = 2000) {
  const a = await Promise.all(pages.map(mediaSample));
  await sleep(ms);
  const b = await Promise.all(pages.map(mediaSample));
  return pages.map((_, i) => {
    const streams = Object.entries(b[i].inbound).map(([key, s]) => {
      const s0 = a[i].inbound[key] || { packets: 0, frames: 0, bytes: 0 };
      return { key, kind: s.kind, p0: s0.packets, p1: s.packets, lost: s.lost, frames: s.frames - s0.frames, kbps: Math.round(((s.bytes - s0.bytes) * 8) / (b[i].t - a[i].t)) };
    });
    const audio = streams.filter((s) => s.kind === 'audio');
    const video = streams.filter((s) => s.kind === 'video');
    return {
      streams, audio, video,
      flowing: audio.filter((s) => s.p1 > s.p0).length,
      videoFlowing: video.filter((s) => s.p1 > s.p0).length,
      sent: b[i].sent - a[i].sent,
      videoKbpsOut: Math.round(((b[i].videoSent - a[i].videoSent) * 8) / (b[i].t - a[i].t)),
    };
  });
}

export const fmt = (m) => m.map((x) => `${x.flowing}/${x.audio.length}`).join(' ');
export const fmtV = (m) => m.map((x) => `${x.videoFlowing}/${x.video.length}`).join(' ');

export async function waitFlowing(pages, expected, timeoutMs, key = 'flowing') {
  const t0 = Date.now();
  let last = null;
  const ok = await waitFor(async () => {
    last = await measure(pages);
    return last.every((x, i) => x[key] === expected[i]);
  }, timeoutMs, 0);
  return { ok: !!ok, last, ms: Date.now() - t0 };
}

export function pageErrors(pages) {
  return pages.flatMap((p) => p.__errors.map((e) => `[${p.__name}] ${e}`));
}

export function checkNoPageErrors(pages, label = 'no pageerror/console.error on any page') {
  const errs = pageErrors(pages);
  check(label, errs.length === 0, errs.slice(0, 8).join(' | '));
  for (const p of pages) p.__errors.length = 0;
}

// ---- cleanup ----
let cleaning = null;
const cleanups = [];
export const onCleanup = (fn) => cleanups.push(fn);
export function cleanup() {
  cleaning ||= (async () => {
    for (const fn of cleanups.reverse()) { try { await fn(); } catch (e) { console.error('cleanup', e.message); } }
    for (const b of browsers) await b.close().catch(() => {});
    for (const s of servers) await stopServer(s).catch((e) => console.error('cleanup', e.message));
  })();
  return cleaning;
}
let interrupted = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n${sig}: cleaning up`);
    interrupted = true;
    failures++;
    cleanup().finally(() => process.exit(130));
  });
}

export async function run(name, body) {
  console.log(`### ${name}`);
  try {
    await body();
  } catch (err) {
    if (!interrupted) console.error(err);
    failures++;
  } finally {
    await cleanup();
  }
  if (interrupted) process.exit(130);
  const crashed = servers.filter((s) => s.problems?.length);
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${name}: ${failures ? `FAILED (${failures})` : 'ALL PASSED'} ${passed}/${results.length} checks in ${Math.round((Date.now() - started) / 1000)} s${crashed.length ? ' (server log had suspicious lines)' : ''}`);
  process.exit(failures ? 1 : 0);
}
