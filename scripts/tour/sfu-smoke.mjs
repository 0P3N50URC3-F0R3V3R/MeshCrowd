// Two-browser smoke test of voice on a throwaway server (own temp data dir, never data/).
//   node scripts/tour/sfu-smoke.mjs            SFU room: mode, audio both ways, old-client denial, leave
//   node scripts/tour/sfu-smoke.mjs --mesh     mesh room: mode, audio both ways, direct path, leave
// Options: --port N (default 8097), --root DIR (serve another checkout, e.g. a worktree of HEAD).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : def; };
const MESH = process.argv.includes('--mesh');
const PORT = Number(arg('--port', 8097));
const SFU_PORT = Number(arg('--sfu-port', 45400));
const here = path.resolve(import.meta.dirname, '../..');
const root = path.resolve(arg('--root', here));
process.env.TOUR_BASE = `http://localhost:${PORT}`;
const { Client, BASE, sleep, PASSWORD } = await import('./lib.mjs');
const require = createRequire(import.meta.url);
const { chromium } = require(path.join(here, 'node_modules/playwright'));
const WebSocket = require(path.join(here, 'node_modules/ws'));
const CHROME = path.join(here, 'ChromePortable/GoogleChromePortable/App/Chrome-bin/chrome.exe');

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-sfu-smoke-'));
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({
  useHttps: false, port: PORT,
  voice: { mode: MESH ? 'mesh' : 'sfu', sfu: { port: SFU_PORT, workers: 1, announcedHost: '127.0.0.1' } },
}));
{
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(path.join(data, 'dismesh.db'));
  d.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  d.prepare('INSERT OR IGNORE INTO meta (key,value) VALUES (?,?)').run('security_settings', JSON.stringify({ captcha: { registerRequired: false } }));
  d.close();
}
const serverLog = fs.openSync(path.join(data, 'server.log'), 'w');
const server = spawn(process.execPath, [path.join(root, 'server/index.js')], { cwd: root, env: { ...process.env, DISMESH_DATA_DIR: data }, stdio: ['ignore', serverLog, serverLog] });

let failures = 0;
const check = (name, cond, extra = '') => { console.log(cond ? 'PASS' : 'FAIL', name, extra); if (!cond) failures++; };
const browsers = [];
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    for (const b of browsers) await b.close().catch(() => {});
    server.kill();
    await sleep(500);
    fs.rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    process.exit(130);
  });
}

// Records every voice_state the page receives and every RTCPeerConnection it creates.
const INIT = `(() => {
  window.__states = [];
  window.__pcs = [];
  const O = window.RTCPeerConnection;
  window.RTCPeerConnection = function (...a) { const pc = new O(...a); window.__pcs.push(pc); return pc; };
  window.RTCPeerConnection.prototype = O.prototype;
  const W = window.WebSocket;
  window.WebSocket = function (...a) {
    const s = new W(...a);
    (window.__sockets ||= []).push(s);
    s.addEventListener('message', (e) => { try { const m = JSON.parse(e.data); if (m.type === 'voice_state') window.__states.push(m); } catch {} });
    return s;
  };
  window.WebSocket.prototype = W.prototype;
  Object.assign(window.WebSocket, { OPEN: 1, CONNECTING: 0, CLOSING: 2, CLOSED: 3 });
})();`;

async function openPage() {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, handleSIGINT: false, handleSIGTERM: false, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  browsers.push(browser);
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 }, permissions: ['microphone', 'camera'], locale: 'en-US' });
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERR', e.message));
  return page;
}

async function loginAndJoin(page, user) {
  await page.goto(BASE + '/');
  await page.waitForSelector('#f-username');
  await page.fill('#f-username', user);
  await page.fill('#f-password', PASSWORD);
  await page.click('#auth-submit');
  await page.waitForSelector('.auth-screen', { state: 'detached' });
  await sleep(1200);
  await page.locator('[data-server]').first().click();
  await sleep(800);
  await page.locator('#sh-channel-list').getByText('Lounge', { exact: true }).first().click();
  await page.click('#vc-join');
}

const inboundAudio = (page) => page.evaluate(async () => {
  let packets = 0;
  for (const pc of window.__pcs) {
    if (pc.connectionState === 'closed') continue;
    const r = await pc.getStats();
    r.forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === 'audio') packets += s.packetsReceived || 0; });
  }
  return packets;
});
const liveConnections = (page) => page.evaluate(() => window.__pcs.filter((pc) => pc.connectionState !== 'closed').length);
const myModes = (page, me) => page.evaluate((id) => window.__states.filter((s) => s.participants.some((u) => u.id === id)).map((s) => s.mode), me);

async function pathSeen(page) {
  for (let i = 0; i < 40; i++) {
    const titles = await page.$$eval('.voice-tile .vc-quality', (els) => els.map((e) => e.title));
    const hit = titles.find((x) => / - /.test(x.split('\n')[0]));
    if (hit) return hit.split('\n')[0].split(' - ')[1];
    await sleep(500);
  }
  return null;
}

function rawJoin(cookie, channelId, sfuFlag) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://localhost:${PORT}/ws`, { headers: { cookie, origin: BASE } });
    const timer = setTimeout(() => { sock.close(); resolve(null); }, 5000);
    sock.on('open', () => sock.send(JSON.stringify({ type: 'voice_join', channelId, ...(sfuFlag ? { sfu: true } : {}) })));
    sock.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'voice_join_denied' || (m.type === 'voice_state' && m.channelId === channelId)) {
        clearTimeout(timer);
        sock.close();
        resolve(m);
      }
    });
    sock.on('error', reject);
  });
}

try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/api/config`)).ok) break; } catch { /* booting */ } await sleep(250); }
  const alice = new Client('alice'); await alice.register('alice', 'Alice');
  const bob = new Client('bob'); await bob.register('bob', 'Bob');
  const carol = new Client('carol'); await carol.register('carol', 'Carol');
  const { server: s } = await alice.post('/api/servers', { name: 'SfuSmoke', visibility: 'private' });
  const detail = await alice.get(`/api/servers/${s.id}`);
  await bob.post('/api/servers/join', { inviteCode: detail.server.invite_code });
  await carol.post('/api/servers/join', { inviteCode: detail.server.invite_code });
  const { channel } = await alice.post(`/api/servers/${s.id}/channels`, { name: 'Lounge', type: 'voice' });
  const expectMode = MESH ? 'mesh' : 'sfu';

  const pa = await openPage();
  const pb = await openPage();
  await loginAndJoin(pa, 'alice');
  await loginAndJoin(pb, 'bob');
  const paths = await Promise.all([pathSeen(pa), pathSeen(pb)]);
  check('both sides report a connection path', paths.every(Boolean), paths.join(' | '));
  if (MESH) check('mesh path is direct', paths.every((p) => /direct/.test(p || '')), paths.join(' | '));
  else check('sfu path badge', paths.every((p) => /SFU/.test(p || '')), paths.join(' | '));

  const modes = [await myModes(pa, alice.user.id), await myModes(pb, bob.user.id)];
  check(`voice_state.mode is '${expectMode}' on both pages`, modes.every((m) => m.length > 0 && m.every((x) => x === expectMode)), JSON.stringify(modes));

  const before = [await inboundAudio(pa), await inboundAudio(pb)];
  await sleep(3000);
  const after = [await inboundAudio(pa), await inboundAudio(pb)];
  check('inbound audio packetsReceived increases on both pages', after[0] > before[0] && after[1] > before[1], `alice ${before[0]}->${after[0]}, bob ${before[1]}->${after[1]}`);
  const conns = [await liveConnections(pa), await liveConnections(pb)];
  check(MESH ? 'one peer connection each' : 'one send + one recv transport each', conns.every((n) => n === (MESH ? 1 : 2)), JSON.stringify(conns));

  await pa.click('#vc-camera');
  let seenVideo = false;
  for (let i = 0; i < 20 && !seenVideo; i++) { await sleep(500); seenVideo = await pb.$$eval(`.voice-tile.has-video[data-uid="${alice.user.id}"] video`, (els) => els.length > 0); }
  check('camera on is seen by the other side', seenVideo);
  await pa.click('#vc-camera');
  let videoGone = false;
  for (let i = 0; i < 20 && !videoGone; i++) { await sleep(500); videoGone = await pb.$$eval(`.voice-tile.has-video[data-uid="${alice.user.id}"]`, (els) => els.length === 0); }
  check('camera off removes the video tile', videoGone);

  await pb.evaluate(() => { for (const s of window.__sockets) s.close(); });
  await sleep(6000);
  const r0 = await inboundAudio(pa);
  const rb0 = await inboundAudio(pb);
  await sleep(2500);
  const r1 = await inboundAudio(pa);
  const rb1 = await inboundAudio(pb);
  check('after a WebSocket reconnect audio flows both ways again', r1 > r0 && rb1 > rb0, `alice ${r0}->${r1}, bob ${rb0}->${rb1}`);
  check('after the reconnect the old connections are closed', (await liveConnections(pb)) === (MESH ? 1 : 2), String(await liveConnections(pb)));

  if (!MESH) {
    await pb.click('#vc-mute');
    await sleep(1500);
    const m0 = await inboundAudio(pa);
    await sleep(2000);
    const m1 = await inboundAudio(pa);
    check('local mute pauses the producer: no audio reaches the other side', m1 === m0, `${m0}->${m1}`);
    await pb.click('#vc-mute');
    await sleep(2000);
    const m2 = await inboundAudio(pa);
    check('unmute resumes it', m2 > m1, `${m1}->${m2}`);

    const denied = await rawJoin(carol.cookie, channel.id, false);
    check('a join without sfu:true is denied with update_required', denied?.type === 'voice_join_denied' && denied.reason === 'update_required', JSON.stringify(denied));
    const admitted = await rawJoin(carol.cookie, channel.id, true);
    check('the same join with sfu:true is admitted', admitted?.type === 'voice_state' && admitted.mode === 'sfu', admitted && admitted.type);
  }

  await pa.click('#vc-leave');
  await sleep(1500);
  check('leaving closes every connection of the leaver', (await liveConnections(pa)) === 0);
  const bobSees = await pb.$$eval('.voice-tile', (els) => els.map((e) => Number(e.dataset.uid)));
  check('the other side sees the leaver gone', !bobSees.includes(alice.user.id), JSON.stringify(bobSees));
  if (!MESH) {
    await sleep(500);
    check('the remaining SFU side keeps its transports', (await liveConnections(pb)) === 2);
  }
  await pb.click('#vc-leave');
  await sleep(1000);
  check('second leave closes its connections too', (await liveConnections(pb)) === 0);

  if (!MESH) {
    // Stage audience: the server refuses bob's audio producer ('muted'); promotion retries it.
    const { channel: stageCh } = await alice.post(`/api/servers/${s.id}/channels`, { name: 'Stage', type: 'stage' });
    for (const p of [pa, pb]) {
      await p.locator('#sh-channel-list').getByText('Stage', { exact: true }).first().click();
      await sleep(600);
      await p.click('#vc-join');
      await sleep(2500);
    }
    const s0 = await inboundAudio(pa);
    await sleep(2000);
    const s1 = await inboundAudio(pa);
    check('stage audience sends no audio (producer refused)', s1 === s0, `${s0}->${s1}`);
    check('the audience member still hears the speaker', (await inboundAudio(pb)) > 0);
    await pa.evaluate(({ channelId, userId }) => import('/js/ws.js').then(({ ws }) => ws.send({ type: 'stage_invite_speaker', channelId, userId })), { channelId: stageCh.id, userId: bob.user.id });
    await sleep(3000);
    const s2 = await inboundAudio(pa);
    await sleep(1500);
    const s3 = await inboundAudio(pa);
    check('promotion to speaker retries the producer and audio flows', s3 > s2 && s2 >= s1, `${s1}->${s2}->${s3}`);
    await pa.click('#vc-leave');
    await pb.click('#vc-leave');
    await sleep(1000);
  }
} catch (err) {
  console.error(err);
  failures++;
} finally {
  for (const b of browsers) await b.close().catch(() => {});
  server.kill();
  await sleep(500);
  fs.closeSync(serverLog);
  if (failures) console.log('server log:', path.join(data, 'server.log'));
  else fs.rmSync(data, { recursive: true, force: true });
}
console.log(failures ? `FAILED (${failures})` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
