// Voice input settings on every client: push-to-talk release delay, voice activation while push-to-talk
// is on, echo reduction (playback ducking), the settings UI and the mic constraints. The client under test
// ("me") is alice in an SFU call with bob (a desktop Chrome page).
// Usage: node scripts/tour/sfu-hunt/voice-input.mjs --target web|electron|csharp|android [--exe <C# exe>] [--host <LAN ip>]
// Electron/C#/Android targets snapshot and restore the registry, config and device state like their own scenarios.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as H from './lib.mjs';
const { check, section, sleep, waitFor } = H;

const argv = process.argv;
const TARGET = argv[argv.indexOf('--target') + 1];
if (!['web', 'electron', 'csharp', 'android'].includes(TARGET)) throw new Error('--target web|electron|csharp|android');
const PORTS = { web: [8070, 46700], electron: [8071, 46710], csharp: [8072, 46720], android: [8074, 46740] };
const [PORT, SFU_PORT] = PORTS[TARGET];
const hasUi = TARGET !== 'android';

const setPrefs = (page, patch) => page.evaluate((p) => import('/js/voicePrefs.js').then(({ voicePrefs }) => voicePrefs.set(p)), patch);
const getPrefs = (page) => page.evaluate(() => import('/js/voicePrefs.js').then(({ voicePrefs }) => ({ ...voicePrefs.get() })));
const senderEnabled = (page) => page.evaluate(() => {
  const s = window.__pcs.filter((pc) => pc.connectionState !== 'closed').flatMap((pc) => pc.getSenders()).find((x) => x.track?.kind === 'audio');
  return s ? s.track.enabled : null;
});
const key = (page, type, code = 'KeyV') => page.evaluate(([t, c]) => document.dispatchEvent(new KeyboardEvent(t, { code: c, key: 'v', bubbles: true })), [type, code]);
// Samples the outbound track's enabled flag every 50 ms for `ms`.
const sampleEnabled = (page, ms) => page.evaluate(async (d) => {
  const out = [];
  const end = performance.now() + d;
  while (performance.now() < end) {
    const s = window.__pcs.filter((pc) => pc.connectionState !== 'closed').flatMap((pc) => pc.getSenders()).find((x) => x.track?.kind === 'audio');
    out.push(s ? s.track.enabled : null);
    await new Promise((r) => setTimeout(r, 50));
  }
  return out;
}, ms);
const volumes = (page) => page.evaluate(() => [...document.querySelectorAll('body > audio')].map((a) => a.volume));
const sampleVolumeMin = (page, ms) => page.evaluate(async (d) => {
  let min = 2, max = -1;
  const end = performance.now() + d;
  while (performance.now() < end) {
    for (const a of document.querySelectorAll('body > audio')) { min = Math.min(min, a.volume); max = Math.max(max, a.volume); }
    await new Promise((r) => setTimeout(r, 50));
  }
  return { min, max };
}, ms);

// ---- Electron safety (same snapshot/restore as electron.mjs) ----
const ELECTRON_CONFIG = path.join(process.env.APPDATA || '', 'Electron/dismesh-client-config.json');
const RUN_KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_NAMES = ['electron.app.MeshCrowd', 'electron.app.Electron'];
const sha = (f) => (fs.existsSync(f) ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') : 'missing');
const ps = (cmd, env = {}) => execFileSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8', env: { ...process.env, ...env } }).trim();
const reg = (args) => { try { return execFileSync('reg', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return '(absent)'; } };
const regSnapshot = () => ({
  mcr: reg(['query', 'HKCU\\Software\\Classes\\mcr', '/s']),
  run: reg(['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run']).split('\n').filter((l) => /MeshCrowd|Electron/i.test(l)).join('\n'),
});

// ---- Android ----
const ADB = process.env.ADB || 'E:/android-tools/sdk/platform-tools/adb.exe';
const PKG = 'com.meshcrowd.app';
const adb = (...a) => { const r = spawnSync(ADB, a, { encoding: 'utf8' }); return (r.stdout || '') + (r.stderr || ''); };
const adbIn = (input, ...a) => spawnSync(ADB, a, { input, encoding: 'utf8' });

// Chrome's fake mic only beeps for the first seconds, so the desktop clients get a looping noise file as the
// mic for a constant, above-threshold level. The emulator has no mic: its analysers are fed a fixed level.
function writeNoiseWav(file) {
  const rate = 48000, n = rate * 2;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round((Math.random() * 2 - 1) * 11000), 44 + i * 2);
  fs.writeFileSync(file, b);
}

async function launchClient(srv, alice, snapDir) {
  const noise = path.join(snapDir, 'noise.wav');
  writeNoiseWav(noise);
  const NOISE_ARG = `--use-file-for-fake-audio-capture=${noise}`;
  if (TARGET === 'web') {
    const page = await H.openPage('me', { extraArgs: [NOISE_ARG] });
    await H.loginPage(page, srv, alice);
    return page;
  }
  if (TARGET === 'electron') {
    const snap = { reg: regSnapshot(), cfgExists: fs.existsSync(ELECTRON_CONFIG), cfgSha: sha(ELECTRON_CONFIG) };
    if (snap.cfgExists) fs.copyFileSync(ELECTRON_CONFIG, path.join(snapDir, 'config.json'));
    const mcrBackup = path.join(snapDir, 'mcr.reg');
    try { execFileSync('reg', ['export', 'HKCU\\Software\\Classes\\mcr', mcrBackup, '/y'], { stdio: 'ignore' }); } catch { /* none */ }
    const runBefore = {};
    for (const n of RUN_NAMES) {
      const v = ps(`$p = Get-ItemProperty '${RUN_KEY}' -Name $env:N -ErrorAction SilentlyContinue; if ($p) { $p.$env:N } else { '<<none>>' }`, { N: n });
      runBefore[n] = v === '<<none>>' ? null : v;
    }
    H.onCleanup(() => {
      const step = (fn) => { try { fn(); } catch (e) { console.error('restore step failed', e.message); } };
      step(() => { if (snap.cfgExists) fs.copyFileSync(path.join(snapDir, 'config.json'), ELECTRON_CONFIG); else fs.rmSync(ELECTRON_CONFIG, { force: true }); });
      step(() => { if (fs.existsSync(mcrBackup)) { execFileSync('reg', ['delete', 'HKCU\\Software\\Classes\\mcr', '/f'], { stdio: 'ignore' }); execFileSync('reg', ['import', mcrBackup], { stdio: 'ignore' }); } });
      for (const [n, v] of Object.entries(runBefore)) {
        if (v === null) step(() => ps(`if (Get-ItemProperty '${RUN_KEY}' -Name $env:N -ErrorAction SilentlyContinue) { Remove-ItemProperty '${RUN_KEY}' -Name $env:N }`, { N: n }));
        else step(() => ps(`Set-ItemProperty '${RUN_KEY}' -Name $env:N -Value $env:V`, { N: n, V: v }));
      }
      const after = regSnapshot();
      check('registry and shell config restored exactly', after.mcr === snap.reg.mcr && after.run === snap.reg.run && sha(ELECTRON_CONFIG) === snap.cfgSha);
    });
    const prev = snap.cfgExists ? JSON.parse(fs.readFileSync(ELECTRON_CONFIG, 'utf8')) : {};
    fs.mkdirSync(path.dirname(ELECTRON_CONFIG), { recursive: true });
    fs.writeFileSync(ELECTRON_CONFIG, JSON.stringify({ ...prev, serverUrl: `${srv.base}/`, closeToTray: false, startMinimized: false, startWithWindows: !!runBefore['electron.app.Electron'], handleInviteLinks: false, windowBounds: { x: 40, y: 40, width: 1200, height: 800 } }, null, 2));
    const exe = path.join(H.root, 'node_modules/electron/dist/electron.exe');
    const app = await H._electron.launch({ executablePath: exe, args: [path.join(H.root, 'electron/main.js'), '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', NOISE_ARG], cwd: H.root, timeout: 60000 });
    const pid = app.process().pid;
    H.onCleanup(async () => {
      await app.close().catch(() => {});
      if (H.alive(pid)) { try { execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } }
    });
    const win = await app.firstWindow();
    win.__name = 'electron'; win.__errors = [];
    win.on('pageerror', (e) => { win.__errors.push(`pageerror: ${e.message}`); console.log('PAGEERR[electron]', e.message); });
    win.on('console', (m) => { if (m.type() === 'error' && !/favicon|status of 40[134]|ERR_CONNECTION_REFUSED/.test(m.text())) { win.__errors.push(`console.error: ${m.text()}`); console.log('CONSOLEERR[electron]', m.text().slice(0, 200)); } });
    await win.context().addInitScript(H.INIT);
    await win.context().addCookies([{ name: 'dismesh_session', value: alice.session(), domain: 'localhost', path: '/', httpOnly: true }]);
    await win.goto(`${srv.base}/`);
    await win.waitForSelector('[data-server]', { timeout: 30000 });
    await waitFor(() => win.evaluate(() => window.__sockets?.some((s) => s.readyState === 1)), 10000);
    check('the shell runs Electron', /Electron\//.test(await win.evaluate(() => navigator.userAgent)));
    return win;
  }
  if (TARGET === 'csharp') {
    const CDP = 9335;
    const exeArg = argv.indexOf('--exe');
    const SRC = exeArg > 0 ? argv[exeArg + 1] : path.join(H.root, 'ClientC#/MeshCrowd.Client/bin/Release/net10.0-windows/win-x64/MeshCrowd.exe');
    const regBefore = regSnapshot();
    const dir = path.join(snapDir, 'cs');
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    H.onCleanup(() => { const a = regSnapshot(); check('registry unchanged by the C# client', a.mcr === regBefore.mcr && a.run === regBefore.run); });
    const exe = path.join(dir, 'MeshCrowd.exe');
    fs.copyFileSync(SRC, exe);
    for (const f of fs.readdirSync(path.dirname(SRC))) if (!/\.(pdb)$/.test(f) && f !== 'MeshCrowd.exe' && fs.statSync(path.join(path.dirname(SRC), f)).isFile()) fs.copyFileSync(path.join(path.dirname(SRC), f), path.join(dir, f));
    fs.writeFileSync(path.join(dir, 'data/dismesh-client-config.json'), JSON.stringify({ serverUrl: `${srv.base}/`, trustedFingerprints: {}, closeToTray: false, startMinimized: false, startWithWindows: false, handleInviteLinks: false }, null, 2));
    const proc = spawn(exe, ['--dev'], { cwd: dir, env: { ...process.env, MESHCROWD_CDP_PORT: String(CDP), MESHCROWD_BROWSER_ARGS: `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream --autoplay-policy=no-user-gesture-required --use-file-for-fake-audio-capture=${noise}` }, stdio: 'ignore' });
    H.onCleanup(() => { if (proc.exitCode === null) { try { execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } } });
    const up = await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${CDP}/json/version`)).ok; } catch { return false; } }, 30000);
    if (!up) throw new Error('C# client CDP port did not come up');
    const cb = await H.chromium.connectOverCDP(`http://127.0.0.1:${CDP}`);
    H.onCleanup(() => cb.close().catch(() => {}));
    const page = await waitFor(() => cb.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith(srv.base)) || null, 30000);
    if (!page) throw new Error('C# client page not found');
    page.__name = 'csharp'; page.__errors = []; page.__benign = [];
    page.on('pageerror', (e) => { page.__errors.push(`pageerror: ${e.message}`); console.log('PAGEERR[csharp]', e.message); });
    page.on('console', (m) => { if (m.type() === 'error' && !/favicon|status of 40[134]|WebSocket connection/i.test(m.text())) { page.__errors.push(`console.error: ${m.text()}`); console.log('CONSOLEERR[csharp]', m.text().slice(0, 300)); } });
    await page.evaluate(async ([u, pw]) => { const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: pw }) }); if (!r.ok) throw new Error(`login ${r.status}`); }, ['alice', H.PASSWORD]);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Page.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: H.INIT });
    await page.reload();
    await page.waitForSelector('[data-server]', { timeout: 30000 });
    await waitFor(() => page.evaluate(() => window.__sockets?.some((s) => s.readyState === 1)), 15000);
    return page;
  }
  // android
  const CDP_PKG = PKG;
  const { _android } = createRequire(import.meta.url)(path.join(H.root, 'node_modules/playwright'));
  const prefsBefore = adb('shell', 'run-as', PKG, 'cat', 'shared_prefs/meshcrowd.xml');
  const perm = (p) => /granted=true/.test((adb('shell', 'dumpsys', 'package', PKG).split('\n').find((l) => l.includes(`${p}:`)) || ''));
  const permsBefore = { RECORD_AUDIO: perm('android.permission.RECORD_AUDIO'), CAMERA: perm('android.permission.CAMERA') };
  H.onCleanup(() => {
    adb('shell', 'am', 'force-stop', PKG);
    adbIn(prefsBefore, 'shell', `run-as ${PKG} sh -c 'cat > /data/data/${PKG}/shared_prefs/meshcrowd.xml'`);
    for (const [p, was] of Object.entries(permsBefore)) adb('shell', 'pm', was ? 'grant' : 'revoke', PKG, `android.permission.${p}`);
    adb('reverse', '--remove', `tcp:${PORT}`);
    const after = adb('shell', 'run-as', PKG, 'cat', 'shared_prefs/meshcrowd.xml');
    check('app prefs restored exactly', after === prefsBefore);
  });
  adb('reverse', `tcp:${PORT}`, `tcp:${PORT}`);
  adb('shell', 'pm', 'grant', CDP_PKG, 'android.permission.RECORD_AUDIO');
  adb('shell', 'pm', 'grant', CDP_PKG, 'android.permission.CAMERA');
  adb('shell', 'am', 'force-stop', PKG);
  adbIn(`<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n    <string name="origin">http://localhost:${PORT}</string>\n</map>\n`, 'shell', `run-as ${PKG} sh -c 'cat > /data/data/${PKG}/shared_prefs/meshcrowd.xml'`);
  adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`);
  const pid = await waitFor(() => adb('shell', 'pidof', PKG).trim() || null, 15000);
  if (!pid) throw new Error('app not running');
  const device = (await _android.devices({ omitDriverInstall: true }))[0];
  H.onCleanup(() => device?.close().catch(() => {}));
  const wv = await device.webView({ pkg: PKG }, { timeout: 20000 });
  const page = await wv.page();
  await waitFor(() => page.url().startsWith(`http://localhost:${PORT}`), 20000);
  page.__name = 'phone'; page.__errors = []; page.__benign = [];
  page.on('pageerror', (e) => { page.__errors.push(`pageerror: ${e.message}`); console.log('PAGEERR[phone]', e.message); });
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|status of 40[134]|WebSocket connection|ERR_CONNECTION_REFUSED|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED/i.test(m.text())) { page.__errors.push(`console.error: ${m.text()}`); console.log('CONSOLEERR[phone]', m.text().slice(0, 300)); } });
  await page.evaluate(async ([u, pw]) => { const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: pw }) }); if (!r.ok) throw new Error(`login ${r.status}`); }, ['alice', H.PASSWORD]);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Page.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: H.INIT });
  await page.reload();
  await page.waitForSelector('#m-host', { timeout: 30000 });
  await waitFor(() => page.evaluate(() => window.__sockets?.some((s) => s.readyState === 1)), 15000);
  await sleep(1000);
  return page;
}

H.run(`voice-input-${TARGET}`, async () => {
  const snapDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-hunt-vinput-'));
  H.onCleanup(() => fs.rmSync(snapDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }));
  let announcedHost = '127.0.0.1';
  if (TARGET === 'android') {
    const hostArg = argv.indexOf('--host');
    announcedHost = hostArg > 0 ? argv[hostArg + 1] : Object.values(os.networkInterfaces()).flat().find((i) => i.family === 'IPv4' && !i.internal && /^192\.168\.|^10\.(?!0\.2\.)/.test(i.address))?.address;
    if (!announcedHost) throw new Error('no LAN IPv4 found; pass --host');
    if (!/device/.test(adb('get-state'))) throw new Error('no emulator/device');
  }
  const srv = await H.startServer({ port: PORT, sfuPort: SFU_PORT, announcedHost });
  const { apis, server, ch } = await H.world(srv, { users: ['alice', 'bob'], voice: ['Lounge'] });
  const { alice, bob } = apis;
  const L = ch.Lounge.id;

  const me = await launchClient(srv, alice, snapDir);
  const pb = await H.openPage('bob');
  await H.loginPage(pb, srv, bob);
  const both = [me, pb];

  const PREF_KEY = 'dismesh_voice_prefs';
  await me.evaluate((k) => localStorage.removeItem(k), PREF_KEY);
  await me.reload();
  await me.waitForSelector('[data-server], #m-host', { timeout: 30000 });
  await waitFor(() => me.evaluate(() => window.__sockets?.some((s) => s.readyState === 1)), 15000);
  H.onCleanup(() => me.evaluate((k) => localStorage.removeItem(k), PREF_KEY).catch(() => {}));
  if (TARGET === 'android') await me.evaluate(() => { window.__fakeLevel = 100; AnalyserNode.prototype.getByteFrequencyData = function (a) { a.fill(window.__fakeLevel); }; });
  // count getUserMedia calls on the client under test (a mic graph rebuild opens a new capture)
  await me.evaluate(() => { window.__gum = 0; const o = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); navigator.mediaDevices.getUserMedia = (...a) => { window.__gum++; return o(...a); }; });
  const gum = () => me.evaluate(() => window.__gum);

  if (TARGET === 'android') {
    await me.evaluate(([s, c]) => import('/m/router.js').then(({ nav }) => nav.push('voice', { kind: 'channel', serverId: s, channelId: c })), [server.id, L]);
    await me.waitForSelector('.m-voice-room #vc-join', { timeout: 15000 });
    await me.evaluate(() => document.querySelector('.m-voice-room #vc-join').click());
    await me.waitForSelector('.m-voice-room #vc-leave', { timeout: 20000 });
    await H.joinVoice(pb, server.id, L);
  } else {
    await H.joinVoice(me, server.id, L);
    await H.joinVoice(pb, server.id, L);
  }
  let f = await H.waitFlowing(both, [1, 1], 25000);
  check(`${TARGET}: 2-way audio before the input tests`, f.ok, H.fmt(f.last));

  if (TARGET !== 'android') {
    const lv = await me.evaluate(async () => {
      const t = window.__pcs.flatMap((pc) => pc.getSenders()).find((x) => x.track?.kind === 'audio').track;
      const ctx = new AudioContext(); const an = ctx.createAnalyser(); an.fftSize = 256;
      ctx.createMediaStreamSource(new MediaStream([t.clone()])).connect(an);
      const d = new Uint8Array(an.frequencyBinCount); const out = [];
      for (let i = 0; i < 15; i++) { await new Promise((r) => setTimeout(r, 200)); an.getByteFrequencyData(d); out.push(Math.round(d.reduce((x, y) => x + y, 0) / d.length)); }
      ctx.close();
      return out;
    });
    H.note('test mic level samples', JSON.stringify(lv));
    check('the test mic delivers a constant level above 20', lv.slice(3).every((x) => x > 20), JSON.stringify(lv));
  }

  section('defaults and mic constraints');
  const d = await getPrefs(me);
  check('defaults: delay 0, voice-activation-with-PTT off, echo reduction off at 10 dB', d.pttReleaseDelayMs === 0 && d.pttVadAlt === false && d.echoReduction === false && d.echoReductionDb === 10, JSON.stringify(d));
  const cons = await me.evaluate(() => {
    const s = window.__pcs.filter((pc) => pc.connectionState !== 'closed').flatMap((pc) => pc.getSenders()).find((x) => x.track?.kind === 'audio');
    return s ? s.track.getSettings() : null;
  });
  H.note('mic track settings', JSON.stringify(cons));
  check('mic track has echoCancellation and autoGainControl on', !!cons && cons.echoCancellation === true && cons.autoGainControl === true, JSON.stringify(cons));
  check('noise suppression flag on', !!cons && cons.noiseSuppression === true, JSON.stringify(cons));
  check('no key, no PTT: mic open', (await senderEnabled(me)) === true);

  section('push-to-talk release delay');
  await setPrefs(me, { pttEnabled: true, pttKey: 'KeyV', pttReleaseDelayMs: 0, pttVadAlt: false, vadEnabled: false, vadThreshold: 80, echoReduction: false });
  await sleep(1500);
  check('PTT on, key up: mic closed', (await senderEnabled(me)) === false);
  await key(me, 'keydown');
  await sleep(200);
  check('key down: mic open', (await senderEnabled(me)) === true);
  await key(me, 'keyup');
  await sleep(200);
  check('delay 0: mic closed right after release', (await senderEnabled(me)) === false);

  await setPrefs(me, { pttReleaseDelayMs: 1000 });
  await sleep(300);
  await key(me, 'keydown'); await sleep(150);
  await key(me, 'keyup');
  const t0 = Date.now();
  await sleep(500);
  check('delay 1000: mic still open 0.5 s after release', (await senderEnabled(me)) === true);
  await waitFor(async () => (await senderEnabled(me)) === false, 2500, 50);
  const closedAfter = Date.now() - t0;
  check('delay 1000: mic closes about 1 s after release', closedAfter > 800 && closedAfter < 1700, `${closedAfter} ms`);

  await key(me, 'keydown'); await sleep(100);
  await key(me, 'keyup'); await sleep(400);
  await key(me, 'keydown');
  await sleep(1300);
  check('pressing again within the delay cancels the pending close', (await senderEnabled(me)) === true);
  await key(me, 'keyup');
  await sleep(300);
  check('...and the delay runs again after the second release', (await senderEnabled(me)) === true);
  await sleep(1200);
  check('...then the mic closes', (await senderEnabled(me)) === false);

  await key(me, 'keydown'); await key(me, 'keyup');
  await setPrefs(me, { pttEnabled: false });
  await sleep(1500);
  check('turning PTT off during a release delay: mic open (always-on mode)', (await senderEnabled(me)) === true);
  await setPrefs(me, { pttEnabled: true, pttReleaseDelayMs: 0 });
  await sleep(500);

  section('voice activation while using push-to-talk');
  check('PTT only, high threshold: mic closed', (await senderEnabled(me)) === false);
  let s = await sampleEnabled(me, 3000);
  check('PTT only: mic never opens by voice over 3 s', s.every((v) => v === false), `${s.filter(Boolean).length}/${s.length} open`);
  await setPrefs(me, { pttVadAlt: true, vadThreshold: 255 });
  await sleep(500);
  s = await sampleEnabled(me, 3000);
  check('voice activation on but threshold unreachable: mic stays closed', s.every((v) => v === false), `${s.filter(Boolean).length}/${s.length} open`);
  await setPrefs(me, { pttVadAlt: true, vadThreshold: 1 });
  s = await sampleEnabled(me, 4000);
  check('PTT + voice activation, low threshold: mic opens on voice without the key', s.some((v) => v === true), `${s.filter(Boolean).length}/${s.length} open`);
  await key(me, 'keydown');
  s = await sampleEnabled(me, 1500);
  check('PTT + voice activation: key held keeps it open', s.every((v) => v === true), `${s.filter(Boolean).length}/${s.length} open`);
  await key(me, 'keyup');
  await setPrefs(me, { pttVadAlt: false, vadThreshold: 80 });
  await sleep(600);
  s = await sampleEnabled(me, 2500);
  check('voice activation option off again: closed over 2.5 s', s.every((v) => v === false), `${s.filter(Boolean).length}/${s.length} open`);
  await setPrefs(me, { pttVadAlt: true, vadThreshold: 1 });
  await sleep(300);
  await setPrefs(me, { pttEnabled: false, pttVadAlt: true, vadEnabled: false });
  await sleep(1000);
  check('PTT off: the alternate-voice checkbox has no effect, mic open (always on)', (await senderEnabled(me)) === true);

  section('plain voice activation reopens after closing');
  await setPrefs(me, { pttEnabled: false, vadEnabled: true, vadThreshold: 255 });
  await sleep(1500);
  check('VAD, unreachable threshold: mic closed', (await senderEnabled(me)) === false);
  await setPrefs(me, { vadThreshold: 1 });
  s = await sampleEnabled(me, 3000);
  check('VAD: lowering the threshold reopens the mic (meter still hears while closed)', s.some((x) => x === true), `${s.filter(Boolean).length}/${s.length} open`);
  await setPrefs(me, { vadEnabled: false });
  await sleep(800);

  section('echo reduction');
  await setPrefs(me, { pttEnabled: false, pttVadAlt: false, vadEnabled: false, vadThreshold: 1, echoReduction: false, echoReductionDb: 20 });
  await sleep(500);
  let v = await sampleVolumeMin(me, 2500);
  check('echo reduction off: playback stays at full volume', v.min === 1 && v.max === 1, JSON.stringify(v));
  const gum0 = await gum();
  await setPrefs(me, { echoReduction: true, echoReductionDb: 20 });
  v = await sampleVolumeMin(me, 4000);
  check('20 dB: playback drops to 0.1 while speaking', v.min > 0.09 && v.min < 0.11, JSON.stringify(v));
  await setPrefs(me, { echoReductionDb: 6 });
  v = await sampleVolumeMin(me, 4000);
  check('6 dB: playback drops to about 0.5', v.min > 0.49 && v.min < 0.52, JSON.stringify(v));
  check('changing the dB value does not rebuild the mic (no new capture)', (await gum()) === gum0, `${gum0} -> ${await gum()}`);
  await setPrefs(me, { echoReduction: false });
  await sleep(1500);
  check('turned off: back to full volume at once', (await volumes(me)).every((x) => x === 1), JSON.stringify(await volumes(me)));
  await setPrefs(me, { echoReduction: true, echoReductionDb: 20 });
  await setPrefs(me, { vadThreshold: 255 });
  await sleep(1500);
  v = await sampleVolumeMin(me, 2500);
  check('quiet (above-threshold never reached): no ducking', v.min === 1, JSON.stringify(v));
  await setPrefs(me, { vadThreshold: 1 });
  await sleep(300);
  await setPrefs(me, { pttEnabled: true, pttVadAlt: false, vadThreshold: 1 });
  await sleep(1500);
  v = await sampleVolumeMin(me, 2500);
  check('PTT closed (not transmitting): no ducking', v.min === 1, JSON.stringify(v));
  await key(me, 'keydown');
  v = await sampleVolumeMin(me, 3500);
  check('PTT held and speaking: ducked', v.min < 0.11, JSON.stringify(v));
  await key(me, 'keyup');
  await sleep(1500);
  check('PTT released: volume restored', (await volumes(me)).every((x) => x === 1), JSON.stringify(await volumes(me)));
  await setPrefs(me, { pttEnabled: false, echoReduction: false });
  await sleep(500);

  section('settings that rebuild the mic still do');
  const g1 = await gum();
  await setPrefs(me, { inputVolume: 1.5 });
  await sleep(1500);
  check('input volume change rebuilds the capture', (await gum()) > g1, `${g1} -> ${await gum()}`);
  await setPrefs(me, { inputVolume: 1 });
  await sleep(1500);
  f = await H.waitFlowing(both, [1, 1], 12000);
  check('audio still flows after all the preference changes', f.ok, H.fmt(f.last));

  if (hasUi) {
    section('settings UI');
    await me.evaluate(() => import('/js/views/userSettings.js').then((m) => m.openUserSettings('voice')));
    await me.waitForSelector('input[name="f-input-mode"]', { timeout: 10000 });
    check('echo reduction checkbox is shown', !!(await me.$('#f-echo-reduction')));
    check('dB field hidden while echo reduction is off', !(await me.$('#f-echo-db')));
    check('PTT extras hidden while PTT is not selected', !(await me.$('#f-ptt-delay')) && !(await me.$('#f-ptt-vad')));
    await me.click('input[name="f-input-mode"][value="ptt"]');
    await me.waitForSelector('#f-ptt-delay');
    check('PTT selected: delay field and voice-activation checkbox appear', !!(await me.$('#f-ptt-vad')));
    check('sensitivity slider hidden until the voice-activation checkbox is on', !(await me.$('#f-vad-threshold')));
    await me.fill('#f-ptt-delay', '750'); await me.press('#f-ptt-delay', 'Tab');
    check('delay 750 saved', (await getPrefs(me)).pttReleaseDelayMs === 750);
    await me.fill('#f-ptt-delay', '99999'); await me.press('#f-ptt-delay', 'Tab');
    check('delay over the maximum clamps to 2000 and the field shows it', (await getPrefs(me)).pttReleaseDelayMs === 2000 && (await me.inputValue('#f-ptt-delay')) === '2000');
    await me.fill('#f-ptt-delay', '-5'); await me.press('#f-ptt-delay', 'Tab');
    check('negative delay clamps to 0', (await getPrefs(me)).pttReleaseDelayMs === 0);
    await me.click('#f-ptt-vad');
    await me.waitForSelector('#f-vad-threshold');
    check('voice-activation checkbox saved and the sensitivity slider appears', (await getPrefs(me)).pttVadAlt === true);
    await me.click('#f-echo-reduction');
    await me.waitForSelector('#f-echo-db');
    check('echo reduction saved, dB field shows the stored value', (await getPrefs(me)).echoReduction === true && (await me.inputValue('#f-echo-db')) === String((await getPrefs(me)).echoReductionDb));
    await me.fill('#f-echo-db', '15'); await me.press('#f-echo-db', 'Tab');
    check('15 dB saved', (await getPrefs(me)).echoReductionDb === 15);
    await me.fill('#f-echo-db', '500'); await me.press('#f-echo-db', 'Tab');
    check('500 dB clamps to 30', (await getPrefs(me)).echoReductionDb === 30 && (await me.inputValue('#f-echo-db')) === '30');
    await me.fill('#f-echo-db', '0'); await me.press('#f-echo-db', 'Tab');
    check('0 dB clamps to 1', (await getPrefs(me)).echoReductionDb === 1);
    await me.fill('#f-echo-db', ''); await me.press('#f-echo-db', 'Tab');
    check('empty dB field falls back to 10', (await getPrefs(me)).echoReductionDb === 10);
    await me.press('#f-echo-db', 'ArrowUp');
    await me.press('#f-echo-db', 'Tab');
    check('up arrow steps the dB value by 1', (await getPrefs(me)).echoReductionDb === 11, String((await getPrefs(me)).echoReductionDb));
    await me.click('input[name="f-input-mode"][value="always"]');
    await me.waitForSelector('#f-ptt-delay', { state: 'detached' });
    check('back to always-on hides the PTT extras, keeps the echo section', !(await me.$('#f-ptt-delay')) && !!(await me.$('#f-echo-reduction')));
    const prefsNow = await getPrefs(me);
    check('settings persisted to localStorage', await me.evaluate((p) => JSON.parse(localStorage.getItem('dismesh_voice_prefs')).echoReductionDb === p.echoReductionDb, prefsNow));
    await me.evaluate(() => document.querySelector('.modal-overlay, .settings-overlay, [class*="overlay"]')?.remove());
    await me.reload();
    await me.waitForSelector('[data-server]', { timeout: 30000 });
    check('settings survive a reload', (await getPrefs(me)).echoReductionDb === 11 && (await getPrefs(me)).pttVadAlt === true);

    section('Hungarian strings');
    check('EN keys present', ['pttReleaseDelayLabel', 'pttVadAltLabel', 'echoReductionLabel', 'echoReductionDbLabel', 'echoReductionHint', 'pttReleaseDelayHint', 'pttVadAltHint'].every((k) => H.en.userSettings[k] && H.hu.userSettings[k]));
  } else {
    section('hardware key on the emulator');
    await setPrefs(me, { pttEnabled: true, pttKey: 'KeyV', pttReleaseDelayMs: 0, pttVadAlt: false, vadThreshold: 80 });
    await sleep(800);
    adb('shell', 'input', 'keyevent', 'KEYCODE_V');
    await sleep(500);
    H.note('real KEYCODE_V reached the page (mic state after a tap, delay 0 so usually closed again):', await senderEnabled(me));
    await setPrefs(me, { pttEnabled: false });
  }

  H.checkNoPageErrors(both, `${TARGET}: no page errors`);
  await H.stopServer(srv);
  check('server log has no exceptions', srv.problems.length === 0, srv.problems.slice(0, 3).join(' | '));
});
