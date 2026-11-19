// End-to-end proof of SFU voice with real browsers: boots throwaway MeshCrowd servers (own temp data
// dirs, never data/) and drives headless Chrome pages with fake media devices through the scenarios
// below, asserting on inbound/outbound RTP stats, the voice roster and the admin SFU status.
// Usage: node scripts/sfu-e2e.mjs [--keep]   (--keep leaves the temp data dirs and server logs behind)
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const { chromium } = require(path.join(root, 'node_modules/playwright'));
const WebSocket = require(path.join(root, 'node_modules/ws'));
const CHROME = path.join(root, 'ChromePortable/GoogleChromePortable/App/Chrome-bin/chrome.exe');
const PASSWORD = 'e2epass1234';
const KEEP = process.argv.includes('--keep');
const MAIN = { port: 8096, sfuPort: 45500 };
const BLOCKED = { port: 8094, sfuPort: 45510, announcedHost: '203.0.113.1' };
const en = JSON.parse(fs.readFileSync(path.join(root, 'lang/en.json'), 'utf8')).voice;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const started = Date.now();
let failures = 0;
const check = (name, cond, extra = '') => { console.log(cond ? 'PASS' : 'FAIL', name, extra); if (!cond) failures++; };
const section = (name) => console.log(`\n== ${name}`);

async function waitFor(fn, timeoutMs, intervalMs = 250) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= end) return null;
    await sleep(intervalMs);
  }
}

// ---- servers ----
const servers = [];

function seedDataDir({ port, sfuPort, announcedHost = '127.0.0.1' }) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-sfu-e2e-'));
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({
    useHttps: false, port,
    voice: { mode: 'sfu', sfu: { port: sfuPort, workers: 1, announcedHost } },
  }));
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(path.join(data, 'dismesh.db'));
  d.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  d.prepare('INSERT OR IGNORE INTO meta (key,value) VALUES (?,?)').run('security_settings', JSON.stringify({ captcha: { registerRequired: false } }));
  d.close();
  return data;
}

async function startServer(opts) {
  const data = seedDataDir(opts);
  const base = `http://localhost:${opts.port}`;
  const logPath = path.join(data, 'server.log');
  const log = fs.openSync(logPath, 'w');
  const proc = spawn(process.execPath, [path.join(root, 'server/index.js')], { cwd: root, env: { ...process.env, DISMESH_DATA_DIR: data }, stdio: ['ignore', log, log] });
  const exited = new Promise((r) => proc.once('exit', r));
  const srv = { proc, data, base, port: opts.port, logPath, log, exited };
  servers.push(srv);
  const up = await waitFor(async () => { try { return (await fetch(`${base}/api/config`)).ok; } catch { return false; } }, 30000);
  if (!up) throw new Error(`server on ${opts.port} did not come up`);
  return srv;
}

function childWorkerPids(pid) {
  if (process.platform !== 'win32') {
    try { return execFileSync('pgrep', ['-P', String(pid), 'mediasoup-worker'], { encoding: 'utf8' }).split(/\s+/).filter(Boolean).map(Number); } catch { return []; }
  }
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | Where-Object { $_.Name -like 'mediasoup-worker*' } | ForEach-Object { $_.ProcessId }`], { encoding: 'utf8' });
  return out.split(/\s+/).filter(Boolean).map(Number);
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function stopServer(srv) {
  if (srv.stopped) return;
  srv.stopped = true;
  let workers = [];
  try { workers = childWorkerPids(srv.proc.pid); } catch { /* the query is best effort */ }
  if (srv.proc.exitCode === null) {
    if (process.platform === 'win32') {
      try { execFileSync('taskkill', ['/pid', String(srv.proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
    } else srv.proc.kill();
    await Promise.race([srv.exited, sleep(5000)]);
  }
  for (const pid of workers) if (alive(pid)) { try { process.kill(pid); } catch { /* raced */ } }
  fs.closeSync(srv.log);
  if (failures) {
    const lines = fs.readFileSync(srv.logPath, 'utf8').trim().split('\n');
    console.log(`--- last server log lines (:${srv.port}) ---\n${lines.slice(-30).join('\n')}`);
  }
  if (!KEEP) fs.rmSync(srv.data, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  else console.log('kept', srv.data);
}

// ---- API ----
class Api {
  constructor(base) { this.base = base; this.cookie = ''; this.user = null; }

  async req(method, p, body) {
    const init = { method, headers: {} };
    if (this.cookie) init.headers.cookie = this.cookie;
    if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
    const res = await fetch(this.base + p, init);
    const set = res.headers.getSetCookie?.() || [];
    if (set.length) this.cookie = set.map((c) => c.split(';')[0]).join('; ');
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }

  get(p) { return this.req('GET', p); }
  post(p, b = {}) { return this.req('POST', p, b); }
  patch(p, b = {}) { return this.req('PATCH', p, b); }

  async register(username) {
    this.user = (await this.post('/api/auth/register', { username, displayName: username, email: `${username}@e2e.local`, password: PASSWORD })).user;
    return this;
  }

  sfuStatus() { return this.get('/api/admin/calls').then((c) => c.voice.status); }
}

// A raw WebSocket as the given user: sends voice_join and resolves with the denial, or with the
// voice_state that lists the user in that room, or null after 5 s. The socket is left open; the
// caller closes it (closing a socket makes the server drop the user's voice membership).
function rawJoin(srv, api, channelId, sfuFlag) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://localhost:${srv.port}/ws`, { headers: { cookie: api.cookie, origin: srv.base } });
    const done = (m) => { clearTimeout(timer); resolve({ msg: m, close: () => new Promise((r) => { sock.once('close', r); sock.close(); }) }); };
    const timer = setTimeout(() => done(null), 5000);
    sock.on('open', () => sock.send(JSON.stringify({ type: 'voice_join', channelId, ...(sfuFlag ? { sfu: true } : {}) })));
    sock.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.channelId !== channelId) return;
      if (m.type === 'voice_join_denied' || (m.type === 'voice_state' && m.participants.some((u) => u.id === api.user.id))) done(m);
    });
    sock.on('error', reject);
  });
}

// ---- browsers ----
const browsers = [];

// Records voice_state, outgoing frames, sfu_responses, toasts and every RTCPeerConnection.
const INIT = `(() => {
  window.__states = []; window.__sent = []; window.__responses = {}; window.__toasts = []; window.__pcs = [];
  let n = 0;
  const O = window.RTCPeerConnection;
  window.RTCPeerConnection = function (...a) { const pc = new O(...a); pc.__id = ++n; window.__pcs.push(pc); return pc; };
  window.RTCPeerConnection.prototype = O.prototype;
  const W = window.WebSocket;
  window.WebSocket = function (...a) {
    const s = new W(...a);
    const send = s.send.bind(s);
    s.send = (d) => { try { window.__sent.push(JSON.parse(d)); } catch {} return send(d); };
    s.addEventListener('message', (e) => {
      try {
        const m = JSON.parse(e.data);
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

async function openPage() {
  // Playwright's own signal handlers exit the process before the servers and temp dirs are cleaned up.
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  browsers.push(browser);
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 }, permissions: ['microphone', 'camera'], locale: 'en-US' });
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERR', e.message));
  return page;
}

async function login(page, srv, user) {
  await page.goto(srv.base + '/');
  await page.fill('#f-username', user);
  await page.fill('#f-password', PASSWORD);
  // A submit can be lost while the app is still booting (seen about once in seven runs), so retry it.
  for (let attempt = 1; ; attempt++) {
    await page.click('#auth-submit');
    try {
      await page.waitForSelector('.auth-screen', { state: 'detached', timeout: 10000 });
      break;
    } catch (err) {
      const shown = await page.locator('.auth-screen').innerText().catch(() => '');
      console.log(`login ${user}: attempt ${attempt} still on the auth screen: ${shown.replace(/\s+/g, ' ').slice(0, 200)}`);
      if (attempt === 3) throw err;
    }
  }
  await page.locator('[data-server]').first().click();
  await page.waitForSelector('#sh-channel-list');
}

const channelItem = (page, name) => page.locator('#sh-channel-list').getByText(name, { exact: true }).first();

// #voice-panel is rebuilt on every channel switch, so a marked panel tells the old view from the new.
async function openVoice(page, name) {
  await page.evaluate(() => document.getElementById('voice-panel')?.setAttribute('data-stale', ''));
  await channelItem(page, name).click();
  await page.waitForSelector('#voice-panel:not([data-stale]) .voice-controls');
}

async function joinVoice(page, name) {
  await openVoice(page, name);
  await page.click('#voice-panel:not([data-stale]) #vc-join');
  await page.waitForSelector('#vc-leave');
}

async function leaveVoice(page) {
  await page.click('#vc-leave');
  await page.waitForSelector('#vc-join');
}

const sentCount = (page, type) => page.evaluate((t) => window.__sent.filter((m) => m.type === t).length, type);
const livePcIds = (page) => page.evaluate(() => window.__pcs.filter((pc) => pc.connectionState !== 'closed').map((pc) => pc.__id));
const remoteAudioEls = (page) => page.evaluate(() => [...document.querySelectorAll('body > audio')]
  .filter((a) => a.srcObject?.getAudioTracks().some((t) => t.readyState === 'live')).length);
const tileUids = (page) => page.$$eval('#voice-panel .voice-tile', (els) => els.map((e) => Number(e.dataset.uid)));
const lastState = (page, channelId) => page.evaluate((id) => window.__states.filter((s) => s.channelId === id).at(-1) || null, channelId);

const audioSample = (page) => page.evaluate(async () => {
  const inbound = {};
  let sent = 0;
  for (const pc of window.__pcs) {
    if (pc.connectionState === 'closed') continue;
    (await pc.getStats()).forEach((s) => {
      if (s.kind !== 'audio') return;
      if (s.type === 'inbound-rtp') inbound[`${pc.__id}:${s.ssrc}`] = { packets: s.packetsReceived || 0, lost: s.packetsLost || 0 };
      if (s.type === 'outbound-rtp') sent += s.packetsSent || 0;
    });
  }
  return { inbound, sent };
});

// Two stats samples 2 s apart on every page at once; per page the inbound audio streams with their
// counters and how many of them grew, plus the outbound audio packet growth.
async function measure(pages) {
  const a = await Promise.all(pages.map(audioSample));
  await sleep(2000);
  const b = await Promise.all(pages.map(audioSample));
  return pages.map((_, i) => {
    const streams = Object.entries(b[i].inbound).map(([key, s]) => {
      const p0 = a[i].inbound[key]?.packets ?? 0;
      return { key, p0, p1: s.packets, lost: s.lost };
    });
    return { streams, flowing: streams.filter((s) => s.p1 > s.p0).length, sent: b[i].sent - a[i].sent };
  });
}

const fmt = (m) => m.map((x) => `${x.flowing}/${x.streams.length}`).join(' ');

// Repeats measure() until every page has the expected number of growing inbound streams.
async function waitFlowing(pages, expected, timeoutMs) {
  const t0 = Date.now();
  let last = null;
  const ok = await waitFor(async () => {
    last = await measure(pages);
    return last.every((x, i) => x.flowing === expected[i]);
  }, timeoutMs, 0);
  return { ok: !!ok, last, ms: Date.now() - t0 };
}

// Memoized: a signal and the main flow (which fails once its browsers close) share one cleanup.
let cleaning = null;
function cleanup() {
  cleaning ||= (async () => {
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

try {
  const main = await startServer(MAIN);
  const alice = await new Api(main.base).register('alice');
  const bob = await new Api(main.base).register('bob');
  const carol = await new Api(main.base).register('carol');
  const dave = await new Api(main.base).register('dave');
  const { server: s } = await alice.post('/api/servers', { name: 'SfuE2E', visibility: 'private' });
  const detail = await alice.get(`/api/servers/${s.id}`);
  for (const u of [bob, carol, dave]) await u.post('/api/servers/join', { inviteCode: detail.server.invite_code });
  const mkVoice = async (name) => (await alice.post(`/api/servers/${s.id}/channels`, { name, type: 'voice' })).channel;
  const lounge = await mkVoice('Lounge');
  const lounge2 = await mkVoice('Lounge Two');
  const meshRoom = await mkVoice('Mesh Room');
  const ids = { alice: alice.user.id, bob: bob.user.id, carol: carol.user.id };

  const [pa, pb, pc] = await Promise.all([openPage(), openPage(), openPage()]);
  const all = [pa, pb, pc];
  await Promise.all([login(pa, main, 'alice'), login(pb, main, 'bob'), login(pc, main, 'carol')]);

  section('1. three participants in one SFU room');
  const joinedAt = Date.now();
  for (const p of all) await joinVoice(p, 'Lounge');
  const modes = await Promise.all(all.map((p) => lastState(p, lounge.id).then((st) => st?.mode)));
  check('the room is in SFU mode on every page', modes.every((m) => m === 'sfu'), JSON.stringify(modes));
  const els = await waitFor(async () => { const n = await Promise.all(all.map(remoteAudioEls)); return n.every((x) => x === 2) && n; }, 15000);
  check('every page plays two remote audio streams', !!els, JSON.stringify(els || await Promise.all(all.map(remoteAudioEls))));
  check('every page has one send and one recv transport', (await Promise.all(all.map(livePcIds))).every((l) => l.length === 2));
  await sleep(Math.max(0, 5000 - (Date.now() - joinedAt)));
  const m1 = await measure(all);
  m1.forEach((m, i) => {
    const name = ['alice', 'bob', 'carol'][i];
    check(`${name}: two inbound audio streams, each >0 and increasing`, m.streams.length === 2 && m.streams.every((x) => x.p0 > 0 && x.p1 > x.p0), m.streams.map((x) => `${x.p0}->${x.p1}`).join(', '));
    check(`${name}: packet loss < 5% on each stream`, m.streams.length > 0 && m.streams.every((x) => x.lost / x.p1 < 0.05), m.streams.map((x) => `${x.lost}/${x.p1}`).join(', '));
  });

  section('5. old-client join is denied');
  {
    const r = await rawJoin(main, dave, lounge.id, false);
    check('voice_join without sfu:true to an SFU room is denied with update_required', r.msg?.type === 'voice_join_denied' && r.msg.reason === 'update_required', JSON.stringify(r.msg));
    await r.close();
    const st = await lastState(pa, lounge.id);
    check('the denied user never shows up in the roster', !st.participants.some((u) => u.id === dave.user.id));
  }

  section('2. navigating to a text channel mid-call');
  {
    const pcsBefore = await livePcIds(pb);
    const joinsBefore = await sentCount(pb, 'voice_join');
    await pb.evaluate(() => document.getElementById('voice-panel')?.setAttribute('data-stale', ''));
    await channelItem(pb, 'general').click();
    await pb.waitForSelector('#voice-panel', { state: 'detached' });
    check('bob is on the text channel (voice view gone)', (await pb.$$('#vc-leave')).length === 0);
    const m = await measure(all);
    check('audio keeps flowing to every page while bob reads text', m.every((x) => x.flowing === 2), fmt(m));
    check('bob keeps sending audio (outbound packets increase)', m[1].sent > 0, `+${m[1].sent}`);
    await openVoice(pb, 'Lounge');
    check('back in the voice view bob is still joined', (await pb.$$('#vc-leave')).length === 1);
    const tiles = await tileUids(pb);
    check('bob sees all three participants', [ids.alice, ids.bob, ids.carol].every((id) => tiles.includes(id)), JSON.stringify(tiles));
    const pcsAfter = await livePcIds(pb);
    check('the same send/recv transports are still live', JSON.stringify(pcsAfter) === JSON.stringify(pcsBefore), `${JSON.stringify(pcsBefore)} -> ${JSON.stringify(pcsAfter)}`);
    check('no new voice_join was sent', (await sentCount(pb, 'voice_join')) === joinsBefore, `${joinsBefore} -> ${await sentCount(pb, 'voice_join')}`);
    const m2 = await measure(all);
    check('audio still flows both ways after returning', m2.every((x) => x.flowing === 2), fmt(m2));
  }

  section('9. server-enforced mute');
  {
    const wsSend = (page, msg) => page.evaluate((m) => import('/js/ws.js').then(({ ws }) => ws.send(m)), msg);
    await wsSend(pa, { type: 'voice_force_mute', channelId: lounge.id, userId: ids.carol });
    const muted = await waitFlowing(all, [1, 1, 2], 10000);
    check('carol force-muted: alice and bob receive only one stream, carol still hears both', muted.ok, fmt(muted.last));
    const toastSeen = await waitFor(() => pc.evaluate((t) => window.__toasts.includes(t), en.moderatorMutedYouToast), 3000);
    check('carol is told a moderator muted her', !!toastSeen);
    const producerId = await pc.evaluate(() => {
      const req = window.__sent.filter((m) => m.type === 'sfu_request' && m.op === 'produce' && m.data?.media === 'audio').at(-1);
      return req && window.__responses[req.id]?.data?.producerId;
    });
    await pc.evaluate(({ channelId, producerId: id }) => import('/js/ws.js').then(({ ws }) => ws.send({ type: 'sfu_request', id: 'e2e-bypass', channelId, op: 'resume_producer', data: { producerId: id } })), { channelId: lounge.id, producerId });
    const bypass = await waitFor(() => pc.evaluate(() => window.__responses['e2e-bypass']), 5000);
    check('a hand-made resume_producer from the muted client is refused (muted)', bypass?.ok === false && bypass.error === 'muted', JSON.stringify(bypass));
    const still = await measure(all);
    check('after the bypass attempt carol is still silent for alice and bob', still[0].flowing === 1 && still[1].flowing === 1, fmt(still));
    await wsSend(pa, { type: 'voice_force_unmute', channelId: lounge.id, userId: ids.carol });
    await pc.waitForSelector('#vc-mute:not([disabled])');
    if (await pc.$('#vc-mute.active-danger')) await pc.click('#vc-mute');
    const back = await waitFlowing(all, [2, 2, 2], 10000);
    check('force-unmute (and carol unmuting herself) brings her audio back', back.ok, `${fmt(back.last)} in ${back.ms} ms`);
  }

  section('7. a mediasoup worker killed mid-call');
  {
    const workers = childWorkerPids(main.proc.pid);
    check('found the server\'s mediasoup worker process', workers.length > 0, JSON.stringify(workers));
    const joinsBefore = await Promise.all(all.map((p) => sentCount(p, 'voice_join')));
    const t0 = Date.now();
    for (const pid of workers) process.kill(pid);
    const back = await waitFlowing(all, [2, 2, 2], 15000);
    const ms = Date.now() - t0;
    check('all three pages receive audio again within 15 s', back.ok && ms <= 15000, `${fmt(back.last)} after ${ms} ms`);
    const joinsAfter = await Promise.all(all.map((p) => sentCount(p, 'voice_join')));
    check('every page rejoined exactly once', joinsAfter.every((n, i) => n === joinsBefore[i] + 1), `${joinsBefore} -> ${joinsAfter}`);
    const newWorkers = childWorkerPids(main.proc.pid);
    check('the server replaced the worker', newWorkers.length === workers.length && newWorkers.every((p) => !workers.includes(p)), JSON.stringify(newWorkers));
    const st = await alice.sfuStatus();
    check('one SFU room with 3 peers worth of transports', st.rooms === 1 && st.transports === 6, JSON.stringify({ rooms: st.rooms, transports: st.transports, producers: st.producers, consumers: st.consumers }));
  }

  section('3. one room per user');
  {
    const t0 = Date.now();
    await joinVoice(pc, 'Lounge Two');
    const gone = await waitFor(async () => {
      const [ta, tb, ea, eb] = await Promise.all([tileUids(pa), tileUids(pb), remoteAudioEls(pa), remoteAudioEls(pb)]);
      return !ta.includes(ids.carol) && !tb.includes(ids.carol) && ea === 1 && eb === 1;
    }, 2000, 100);
    check('joining Lounge Two: alice and bob see carol leave Lounge and drop her audio within 2 s', !!gone, `${Date.now() - t0} ms`);
    const order = await pc.evaluate(({ a, b }) => {
      const i = window.__sent.findLastIndex((m) => m.type === 'voice_leave' && m.channelId === a);
      const j = window.__sent.findLastIndex((m) => m.type === 'voice_join' && m.channelId === b);
      return { i, j };
    }, { a: lounge.id, b: lounge2.id });
    check('carol\'s client left Lounge before joining Lounge Two', order.i >= 0 && order.i < order.j, JSON.stringify(order));
    // Carol's Leave button shows on click, before the server's voice_state for Lounge Two reaches alice.
    const st2 = await waitFor(async () => { const s = await lastState(pa, lounge2.id); return s?.participants.some((u) => u.id === ids.carol) && s; }, 3000) || await lastState(pa, lounge2.id);
    check('Lounge Two is an SFU room with carol in it', st2?.mode === 'sfu' && st2.participants.some((u) => u.id === ids.carol), JSON.stringify(st2 && { mode: st2.mode, ids: st2.participants.map((u) => u.id) }));
    await joinVoice(pb, 'Lounge Two');
    const bobGone = await waitFor(async () => !(await tileUids(pa)).includes(ids.bob) && (await remoteAudioEls(pa)) === 0, 2000, 100);
    check('bob moving over: alice sees him leave Lounge', !!bobGone);
    const flow = await waitFlowing([pb, pc], [1, 1], 10000);
    check('audio flows between bob and carol in Lounge Two', flow.ok, fmt(flow.last));
    const st = await alice.sfuStatus();
    check('the server has two SFU rooms (Lounge with alice, Lounge Two)', st.rooms === 2, JSON.stringify({ rooms: st.rooms }));

    const r = await rawJoin(main, carol, lounge.id, true);
    check('a raw second voice_join for a user already in a room is refused', r.msg?.type === 'voice_join_denied', JSON.stringify(r.msg));
    const lst = await lastState(pa, lounge.id);
    check('carol did not reappear in Lounge', !lst.participants.some((u) => u.id === ids.carol));
    await r.close();
    const kept = await waitFlowing([pb, pc], [1, 1], 6000);
    const st2b = await lastState(pa, lounge2.id);
    check('closing that refused extra socket leaves carol\'s call alone', kept.ok && st2b.participants.some((u) => u.id === ids.carol), `${fmt(kept.last)} roster ${JSON.stringify(st2b.participants.map((u) => u.id))}`);
  }

  section('4. leaving');
  {
    await leaveVoice(pa);
    const one = await waitFor(async () => (await alice.sfuStatus()).rooms === 1, 3000);
    check('alice leaving the otherwise empty Lounge closes that room (rooms 2 -> 1)', !!one);
    check('alice\'s transports are closed', (await livePcIds(pa)).length === 0);
    const before = await alice.sfuStatus();
    const t0 = Date.now();
    await leaveVoice(pb);
    const closed = await waitFor(async () => (await remoteAudioEls(pc)) === 0 && !(await tileUids(pc)).includes(ids.bob), 2000, 100);
    check('bob leaves: carol\'s consumer for him closes within 2 s', !!closed, `${Date.now() - t0} ms`);
    const m = await measure([pc]);
    check('carol receives no audio stream any more', m[0].flowing === 0, fmt(m));
    const after = await alice.sfuStatus();
    check('server counts drop: room stays, bob\'s transports/producer/consumers gone', after.rooms === 1 && after.transports === before.transports - 2 && after.producers === before.producers - 1 && after.consumers === 0,
      `${JSON.stringify({ t: before.transports, p: before.producers, c: before.consumers })} -> ${JSON.stringify({ r: after.rooms, t: after.transports, p: after.producers, c: after.consumers })}`);
    await leaveVoice(pc);
    const zero = await waitFor(async () => { const x = await alice.sfuStatus(); return x.rooms === 0 && x.transports === 0 && x; }, 3000);
    check('the last participant leaving returns status.rooms to 0', !!zero, JSON.stringify(zero || await alice.sfuStatus()));
  }

  section('6. mesh mode in the same run');
  {
    await joinVoice(pc, 'Lounge Two');
    await waitFor(async () => (await alice.sfuStatus()).rooms === 1, 5000);
    const patched = await alice.patch('/api/admin/calls', { voice: { mode: 'mesh' } });
    check('admin PATCH switches voice.mode to mesh', patched.voice.mode === 'mesh' && patched.voice.effectiveMode === 'mesh', JSON.stringify({ mode: patched.voice.mode, effective: patched.voice.effectiveMode }));
    await joinVoice(pa, 'Mesh Room');
    await joinVoice(pb, 'Mesh Room');
    const ms = await Promise.all([pa, pb].map((p) => lastState(p, meshRoom.id).then((st) => st?.mode)));
    check('the new room is a mesh room', ms.every((m) => m === 'mesh'), JSON.stringify(ms));
    const flow = await waitFlowing([pa, pb], [1, 1], 15000);
    check('mesh audio flows both ways (inbound packets increase)', flow.ok, fmt(flow.last));
    check('one peer connection each in mesh', (await Promise.all([pa, pb].map(livePcIds))).every((l) => l.length === 1));
    const st2 = await lastState(pa, lounge2.id);
    check('the live Lounge Two room stays SFU', st2?.mode === 'sfu' && st2.participants.some((u) => u.id === ids.carol), JSON.stringify(st2 && st2.mode));
    const r = await rawJoin(main, dave, lounge2.id, false);
    check('an old client is still refused there (mode fixed per room)', r.msg?.type === 'voice_join_denied' && r.msg.reason === 'update_required', JSON.stringify(r.msg));
    await r.close();
    check('the SFU still counts that one room', (await alice.sfuStatus()).rooms === 1);
    for (const p of [pa, pb, pc]) await leaveVoice(p);
    await alice.patch('/api/admin/calls', { voice: { mode: 'sfu' } });
  }

  section('8. unreachable media port (announcedHost 203.0.113.1)');
  {
    const blocked = await startServer(BLOCKED);
    const erin = await new Api(blocked.base).register('erin');
    const { server: s2 } = await erin.post('/api/servers', { name: 'Blocked', visibility: 'private' });
    await erin.post(`/api/servers/${s2.id}/channels`, { name: 'Lounge', type: 'voice' });
    const pe = await openPage();
    await login(pe, blocked, 'erin');
    const t0 = Date.now();
    await joinVoice(pe, 'Lounge');
    const gaveUp = await waitFor(async () => (await pe.$$('#vc-join')).length === 1 && (await pe.evaluate((t) => window.__toasts.includes(t), en.sfuGaveUp)), 40000, 500);
    const ms = Date.now() - t0;
    check('the client gives up and leaves the call', !!gaveUp, `after ${ms} ms`);
    check('...within 30 s', !!gaveUp && ms <= 30000, `${ms} ms`);
    const toasts = await pe.evaluate(() => window.__toasts);
    check('the firewall hint toast was shown before giving up', toasts.includes(en.sfuConnectFailed), JSON.stringify(toasts));
    const joins0 = await sentCount(pe, 'voice_join');
    check('voice_join sent at most twice (join + one retry)', joins0 <= 2, String(joins0));
    const leaves = await sentCount(pe, 'voice_leave');
    check('the retry rejoined in place: the only voice_leave is the final one', leaves === 1, String(leaves));
    await sleep(5000);
    const joins1 = await sentCount(pe, 'voice_join');
    check('no further joins after giving up', joins1 === joins0, `${joins0} -> ${joins1}`);
    const st = await erin.sfuStatus();
    check('admin status counts the connect failures', st.connectFailures > 0, `connectFailures=${st.connectFailures}`);
    check('the failed room was closed', st.rooms === 0, `rooms=${st.rooms}`);
  }
} catch (err) {
  if (!interrupted) console.error(err);
  failures++;
} finally {
  await cleanup();
}
if (interrupted) process.exit(130);
console.log(`\n${failures ? `FAILED (${failures})` : 'ALL PASSED'} in ${Math.round((Date.now() - started) / 1000)} s`);
process.exit(failures ? 1 : 0);
