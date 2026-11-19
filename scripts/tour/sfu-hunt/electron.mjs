// Scenario 10: the Electron shell (dev electron.exe + electron/main.js, and the built
// Client/MeshCrowd.exe with --built) in SFU and mesh rooms: join, navigate, minimize/restore,
// close-to-tray with a live call, screen share through setDisplayMediaRequestHandler, quit with a
// live call (the server must free the peer).
// Safety: snapshots and restores the mcr:// protocol key, the Run values Electron touches and the
// shell config file (byte-exact), in every exit path. Never touches E:\MeshCrowdClient.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as H from './lib.mjs';
const { check, section, sleep, waitFor } = H;

const BUILT = process.argv.includes('--built');
const EXE = BUILT ? path.join(H.root, 'Client/MeshCrowd.exe') : path.join(H.root, 'node_modules/electron/dist/electron.exe');
const CONFIG = BUILT ? path.join(H.root, 'Client/data/dismesh-client-config.json') : path.join(process.env.APPDATA, 'Electron/dismesh-client-config.json');
const RUN_KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_NAMES = ['electron.app.MeshCrowd', 'electron.app.Electron'];
const snapDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-hunt-electron-'));
const sha = (f) => (fs.existsSync(f) ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') : 'missing');
const ps = (cmd, env = {}) => execFileSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8', env: { ...process.env, ...env } }).trim();

function snapshot() {
  execFileSync('reg', ['export', 'HKCU\\Software\\Classes\\mcr', path.join(snapDir, 'mcr.reg'), '/y'], { stdio: 'ignore' });
  const run = {};
  for (const n of RUN_NAMES) {
    const v = ps(`$p = Get-ItemProperty '${RUN_KEY}' -Name $env:N -ErrorAction SilentlyContinue; if ($p) { $p.$env:N } else { '<<none>>' }`, { N: n });
    run[n] = v === '<<none>>' ? null : v;
  }
  const cfgExists = fs.existsSync(CONFIG);
  if (cfgExists) fs.copyFileSync(CONFIG, path.join(snapDir, 'config.json'));
  const mcr = ps("(Get-ItemProperty 'HKCU:\\Software\\Classes\\mcr\\shell\\open\\command').'(default)'");
  return { run, cfgExists, cfgSha: sha(CONFIG), mcr };
}

let snap = null;
let restored = false;
function restore() {
  if (!snap || restored) return;
  restored = true;
  // every step on its own, so one failure cannot skip the others
  const step = (fn) => { try { fn(); } catch (e) { console.error('restore step failed', e.message); } };
  step(() => { if (snap.cfgExists) fs.copyFileSync(path.join(snapDir, 'config.json'), CONFIG); else fs.rmSync(CONFIG, { force: true }); });
  step(() => execFileSync('reg', ['delete', 'HKCU\\Software\\Classes\\mcr', '/f'], { stdio: 'ignore' }));
  step(() => execFileSync('reg', ['import', path.join(snapDir, 'mcr.reg')], { stdio: 'ignore' }));
  for (const [n, v] of Object.entries(snap.run)) {
    if (v === null) step(() => ps(`if (Get-ItemProperty '${RUN_KEY}' -Name $env:N -ErrorAction SilentlyContinue) { Remove-ItemProperty '${RUN_KEY}' -Name $env:N }`, { N: n }));
    else step(() => ps(`Set-ItemProperty '${RUN_KEY}' -Name $env:N -Value $env:V`, { N: n, V: v }));
  }
  const after = snapshot();
  console.log(`RESTORE mcr: ${after.mcr} | run: ${JSON.stringify(after.run)} | config sha ${after.cfgSha} (before ${snap.cfgSha})`);
  const ok = after.mcr === snap.mcr && JSON.stringify(after.run) === JSON.stringify(snap.run) && after.cfgSha === snap.cfgSha;
  check('registry and shell config restored exactly', ok);
  fs.rmSync(snapDir, { recursive: true, force: true });
}

H.run(BUILT ? 'electron-built' : 'electron-dev', async () => {
  snap = snapshot();
  console.log(`SNAPSHOT mcr: ${snap.mcr} | run: ${JSON.stringify(snap.run)} | config sha ${snap.cfgSha}`);
  H.onCleanup(async () => restore());

  const srv = await H.startServer({ port: 8079, sfuPort: 46090 });
  const { apis, server, ch, general } = await H.world(srv, { users: ['alice', 'bob', 'carol'], voice: ['Lounge', 'MeshRoom'] });
  const { alice, bob, carol } = apis;
  const L = ch.Lounge.id;
  const prev = snap.cfgExists ? JSON.parse(fs.readFileSync(CONFIG, 'utf8')) : {};
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify({ ...prev, serverUrl: `${srv.base}/`, closeToTray: true, startMinimized: false, startWithWindows: !!snap.run[BUILT ? 'electron.app.MeshCrowd' : 'electron.app.Electron'], handleInviteLinks: false, windowBounds: { x: 40, y: 40, width: 1200, height: 800 } }, null, 2));

  const args = [...(BUILT ? [] : [path.join(H.root, 'electron/main.js')]), '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'];
  const app = await H._electron.launch({ executablePath: EXE, args, cwd: H.root, timeout: 60000 });
  const appPid = app.process().pid;
  H.onCleanup(async () => {
    await app.close().catch(() => {});
    if (H.alive(appPid)) { try { execFileSync('taskkill', ['/pid', String(appPid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } }
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
  const ua = await win.evaluate(() => navigator.userAgent);
  check('the shell runs Electron and loaded the app', /Electron\//.test(ua), ua.slice(-60));
  const winCall = (fn) => app.evaluate(({ BrowserWindow }, f) => { const w = BrowserWindow.getAllWindows()[0]; return new Function('w', `return (${f})(w)`)(w); }, fn.toString());

  const pb = await H.openPage('bob'), pc = await H.openPage('carol');
  await H.loginPage(pb, srv, bob); await H.loginPage(pc, srv, carol);
  const all = [win, pb, pc];
  const counts = async () => { const s = await alice.sfuStatus(); return { rooms: s.rooms, t: s.transports, p: s.producers, c: s.consumers }; };

  section('10a. join an SFU room from the shell');
  for (const p of all) await H.joinVoice(p, server.id, L);
  let f = await H.waitFlowing(all, [2, 2, 2], 20000);
  check('3-way SFU audio with the shell', f.ok, H.fmt(f.last));
  check('shell: send + recv transport, mode sfu', (await H.livePcIds(win)).length === 2 && (await H.lastState(win, L))?.mode === 'sfu');
  const micOk = await win.evaluate(() => navigator.permissions.query({ name: 'microphone' }).then((r) => r.state).catch((e) => `err ${e.message}`));
  H.note('shell microphone permission state:', micOk);

  section('10b. navigate to a text channel during the call');
  const pcs0 = await H.livePcIds(win);
  await H.openChannel(win, server.id, general.id);
  await sleep(800);
  f = await H.measure(all);
  check('audio keeps flowing while the shell shows a text channel', f.every((x) => x.flowing === 2) && JSON.stringify(await H.livePcIds(win)) === JSON.stringify(pcs0), H.fmt(f));

  section('10c. minimize / restore, close-to-tray / show');
  await winCall((w) => w.minimize());
  await sleep(4000);
  f = await H.measure(all);
  check('minimized: audio both ways', f.every((x) => x.flowing === 2), H.fmt(f));
  await winCall((w) => { w.restore(); w.show(); });
  await sleep(500);
  await winCall((w) => w.close());
  await sleep(1500);
  const visible = await winCall((w) => w.isVisible());
  check('close with closeToTray hides the window instead of quitting', visible === false);
  await sleep(4000);
  f = await H.measure(all);
  check('hidden to tray: audio both ways, same transports', f.every((x) => x.flowing === 2) && JSON.stringify(await H.livePcIds(win)) === JSON.stringify(pcs0), H.fmt(f));
  await winCall((w) => { w.show(); w.focus(); });
  await sleep(500);
  check('shown again, still in the call (call bar)', !!(await win.$('#cb-leave')));

  section('10d. screen share through the display-media handler');
  await win.click('#cb-return');
  await win.waitForSelector('#voice-panel #vc-screenshare');
  await win.click('#vc-screenshare');
  const shared = await waitFor(() => pb.evaluate((u) => [...document.querySelectorAll('#voice-panel video[data-stream-key]')].some((v) => v.dataset.streamKey === `${u}:screen` && v.videoWidth > 0), alice.user.id), 15000);
  check('bob sees the shell\'s screen share', !!shared, JSON.stringify(await H.toasts(win)));
  if (shared) {
    await win.click('#vc-screenshare');
    check('stopping the share removes it for bob', !!(await waitFor(() => pb.evaluate((u) => ![...document.querySelectorAll('#voice-panel video[data-stream-key]')].some((v) => v.dataset.streamKey === `${u}:screen`), alice.user.id), 5000)));
  }

  section('10e. a second window of the app');
  const wins = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  H.note('BrowserWindows:', wins, '(the shell opens one main window; window.open targets are external)');

  section('10f. mesh room from the shell');
  for (const p of all) await H.leaveVoice(p);
  await alice.patch('/api/admin/calls', { voice: { mode: 'mesh' } });
  for (const p of [win, pb]) await H.joinVoice(p, server.id, ch.MeshRoom.id);
  f = await H.waitFlowing([win, pb], [1, 1], 20000);
  check('mesh audio both ways with the shell, 1 PC', f.ok && (await H.livePcIds(win)).length === 1, H.fmt(f.last));
  for (const p of [win, pb]) await H.leaveVoice(p);
  await alice.patch('/api/admin/calls', { voice: { mode: 'sfu' } });

  section('10g. quit the shell with a live SFU call');
  for (const p of all) await H.joinVoice(p, server.id, L);
  f = await H.waitFlowing(all, [2, 2, 2], 20000);
  check('back in a 3-way SFU call', f.ok, H.fmt(f.last));
  H.checkNoPageErrors(all, 'no page errors in the shell or the browsers');
  await app.evaluate(({ app: a }) => { a.isQuitting = true; a.quit(); });
  await Promise.race([new Promise((r) => app.process().once('exit', r)), sleep(10000)]);
  check('the shell process exited', !H.alive(appPid));
  const freed = await waitFor(async () => { const c = await counts(); return c.t === 4 && c.p === 2 && c; }, 8000);
  check('the server freed the shell\'s peer (2 peers left)', !!freed, JSON.stringify(await counts()));
  f = await H.waitFlowing([pb, pc], [1, 1], 8000);
  check('bob and carol keep talking', f.ok, H.fmt(f.last));
  await H.stopServer(srv);
  check('server log has no exceptions', srv.problems.length === 0, srv.problems.slice(0, 3).join(' | '));
});
