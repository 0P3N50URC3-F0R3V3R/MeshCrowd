// Scenario B1: the Android app (debug build, WebView debugging on) on the emulator against two
// desktop Chrome peers, in SFU and then mesh mode: join from the mobile voice screen, chat during the
// call, call bar, background (home key) + relaunch, screen rotation, camera + flip, leave/rejoin.
// Needs the emulator running with the debug app installed. The app's saved server address, the
// mic/camera permissions and the rotation settings are restored afterwards.
// Usage: node scripts/tour/sfu-hunt/android.mjs [--host <LAN IPv4 reachable from emulator and host>]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as H from './lib.mjs';
const { check, section, sleep, waitFor } = H;

const ADB = process.env.ADB || 'E:/android-tools/sdk/platform-tools/adb.exe';
const PKG = 'com.meshcrowd.app';
const PORT = 8076, SFU_PORT = 46760, CDP = 9333;
const hostArg = process.argv.indexOf('--host');
const LAN = hostArg > 0 ? process.argv[hostArg + 1] : Object.values(os.networkInterfaces()).flat().find((i) => i.family === 'IPv4' && !i.internal && /^192\.168\.|^10\.(?!0\.2\.)/.test(i.address))?.address;
const adb = (...a) => { const r = spawnSync(ADB, a, { encoding: 'utf8' }); return (r.stdout || '') + (r.stderr || ''); };
const adbIn = (input, ...a) => spawnSync(ADB, a, { input, encoding: 'utf8' });

const mnav = (page, name, params) => page.evaluate(([n, p]) => import('/m/router.js').then(({ nav }) => nav.push(n, p)), [name, params]);
const mback = (page) => page.evaluate(() => import('/m/router.js').then(({ nav }) => nav.back()));
const callBarText = (page) => page.evaluate(() => { const b = document.getElementById('m-callbar'); return b && !b.hidden ? b.innerText.trim() : null; });
const tapEl = (page, sel) => page.evaluate((s) => document.querySelector(s).click(), sel);

let restore = null;


const { _android } = createRequire(import.meta.url)(path.join(H.root, 'node_modules/playwright'));
let device = null;
async function connectApp() {
  const pid = await waitFor(() => adb('shell', 'pidof', PKG).trim() || null, 15000);
  if (!pid) throw new Error('app not running');
  device ||= (await _android.devices({ omitDriverInstall: true }))[0];
  const wv = await device.webView({ pkg: PKG }, { timeout: 20000 });
  const page = await wv.page();
  await waitFor(() => page.url().startsWith(`http://localhost:${PORT}`), 20000);
  page.__name = 'phone'; page.__errors = []; page.__benign = [];
  page.on('pageerror', (e) => { page.__errors.push(`pageerror: ${e.message}`); console.log('PAGEERR[phone]', e.message); });
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|status of 40[134]|WebSocket connection|ERR_CONNECTION_REFUSED|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED/i.test(m.text())) { page.__errors.push(`console.error: ${m.text()}`); console.log('CONSOLEERR[phone]', m.text().slice(0, 300)); } });
  return { browser: { close: async () => {} }, page, pid };
}

// The INIT hooks must be in place before the app's scripts run: reload the page with them injected.
async function instrument(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Page.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: H.INIT });
  await page.reload();
  await page.waitForSelector('#m-host', { timeout: 30000 });
  await waitFor(() => page.evaluate(() => window.__sockets?.some((s) => s.readyState === 1)), 15000);
  await sleep(1000);
}

H.run('android', async () => {
  if (!LAN) throw new Error('no LAN IPv4 found; pass --host');
  if (!/device/.test(adb('get-state'))) throw new Error('no emulator/device');
  if (!/DEBUGGABLE/.test(adb('shell', 'dumpsys', 'package', PKG))) throw new Error('the app on the device is not a debug build');
  H.note('announced host', LAN);

  // ---- snapshot device state ----
  const prefsBefore = adb('shell', 'run-as', PKG, 'cat', 'shared_prefs/meshcrowd.xml');
  const perm = (p) => /granted=true/.test((adb('shell', 'dumpsys', 'package', PKG).split('\n').find((l) => l.includes(`${p}:`)) || ''));
  const permsBefore = { RECORD_AUDIO: perm('android.permission.RECORD_AUDIO'), CAMERA: perm('android.permission.CAMERA') };
  const rotBefore = { acc: adb('shell', 'settings', 'get', 'system', 'accelerometer_rotation').trim(), user: adb('shell', 'settings', 'get', 'system', 'user_rotation').trim() };
  const backup = path.join(os.tmpdir(), `mc-hunt-android-prefs-${Date.now()}.xml`);
  fs.writeFileSync(backup, prefsBefore);
  H.note('device state before', JSON.stringify({ permsBefore, rotBefore }), 'prefs backup', backup);
  restore = async () => {
    adb('shell', 'am', 'force-stop', PKG);
    adbIn(prefsBefore, 'shell', `run-as ${PKG} sh -c 'cat > /data/data/${PKG}/shared_prefs/meshcrowd.xml'`);
    for (const [p, was] of Object.entries(permsBefore)) adb('shell', 'pm', was ? 'grant' : 'revoke', PKG, `android.permission.${p}`);
    adb('shell', 'settings', 'put', 'system', 'accelerometer_rotation', rotBefore.acc === 'null' ? '1' : rotBefore.acc);
    if (rotBefore.user !== 'null') adb('shell', 'settings', 'put', 'system', 'user_rotation', rotBefore.user);
    adb('shell', 'cmd', 'connectivity', 'airplane-mode', 'disable');
    adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
    adb('reverse', '--remove', `tcp:${PORT}`);
    adb('forward', '--remove', `tcp:${CDP}`);
    const after = adb('shell', 'run-as', PKG, 'cat', 'shared_prefs/meshcrowd.xml');
    console.log('RESTORE prefs identical:', after === prefsBefore, '| perms', JSON.stringify({ RECORD_AUDIO: perm('android.permission.RECORD_AUDIO'), CAMERA: perm('android.permission.CAMERA') }));
    if (after === prefsBefore) fs.rmSync(backup, { force: true });
  };
  H.onCleanup(() => restore?.());

  const srv = await H.startServer({ port: PORT, sfuPort: SFU_PORT, announcedHost: LAN });
  const { apis, server, ch, general } = await H.world(srv, { users: ['alice', 'bob', 'carol'], voice: ['Lounge', 'MeshRoom'] });
  const { alice, bob, carol } = apis;

  // ---- point the app at the throwaway server and log bob in ----
  adb('reverse', `tcp:${PORT}`, `tcp:${PORT}`);
  adb('shell', 'pm', 'grant', PKG, 'android.permission.RECORD_AUDIO');
  adb('shell', 'pm', 'grant', PKG, 'android.permission.CAMERA');
  adb('shell', 'am', 'force-stop', PKG);
  adbIn(`<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n    <string name="origin">http://localhost:${PORT}</string>\n</map>\n`, 'shell', `run-as ${PKG} sh -c 'cat > /data/data/${PKG}/shared_prefs/meshcrowd.xml'`);
  adb('shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0');
  adb('shell', 'settings', 'put', 'system', 'user_rotation', '0');
  adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`);
  let { browser: phoneBrowser, page: pb, pid } = await connectApp();
  await pb.evaluate(async ([u, pw]) => {
    const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: pw }) });
    if (!r.ok) throw new Error(`login ${r.status}`);
  }, ['bob', H.PASSWORD]);
  await instrument(pb);
  H.note('phone UA', await pb.evaluate(() => navigator.userAgent));

  const pa = await H.openPage('alice'), pc = await H.openPage('carol');
  await H.loginPage(pa, srv, alice); await H.loginPage(pc, srv, carol);

  for (const mode of ['sfu', 'mesh']) {
    section(`=== ${mode.toUpperCase()}`);
    const room = mode === 'sfu' ? ch.Lounge.id : ch.MeshRoom.id;
    if (mode === 'mesh') await alice.patch('/api/admin/calls', { voice: { mode: 'mesh' } });
    await H.joinVoice(pa, server.id, room); await H.joinVoice(pc, server.id, room);
    const all = [pa, pb, pc];

    section(`${mode} a. join from the phone`);
    await mnav(pb, 'voice', { kind: 'channel', serverId: server.id, channelId: room });
    await pb.waitForSelector('.m-voice-room #vc-join', { timeout: 15000 });
    await tapEl(pb, '.m-voice-room #vc-join');
    await pb.waitForSelector('.m-voice-room #vc-leave', { timeout: 20000 });
    let f = await H.waitFlowing(all, [2, 2, 2], 25000);
    check(`${mode}: 3-way audio with the phone`, f.ok, H.fmt(f.last));
    check(`${mode}: room mode`, (await H.lastState(pa, room))?.mode === mode, (await H.lastState(pa, room))?.mode);
    const pcs0 = await H.livePcIds(pb);
    const joins0 = await H.sentCount(pb, 'voice_join');
    check(`${mode}: phone has 2 peer connections`, pcs0.length === 2, JSON.stringify(pcs0));
    if (mode === 'sfu') {
      const cand = await pb.evaluate(async () => { for (const p of window.__pcs) { if (p.connectionState === 'closed') continue; let r = null; (await p.getStats()).forEach((s) => { if (s.type === 'remote-candidate') r = `${s.address || s.ip}:${s.port}/${s.protocol}`; }); if (r) return r; } return null; });
      check('sfu: phone reaches the SFU at the announced LAN host', !!cand && cand.startsWith(LAN), String(cand));
    }
    const stillInCall = async (label, pages = all, exp = [2, 2, 2]) => {
      const m = await H.waitFlowing(pages, exp, 12000);
      check(`${label}: audio flows`, m.ok, H.fmt(m.last));
      const ids = await H.livePcIds(pb), j = await H.sentCount(pb, 'voice_join');
      check(`${label}: same peer connections, no rejoin`, JSON.stringify(ids) === JSON.stringify(pcs0) && j === joins0, `${JSON.stringify(ids)} joins ${j}`);
    };

    section(`${mode} b. chat + call bar`);
    await mback(pb);
    await sleep(800);
    check(`${mode}: call bar after back`, ((await callBarText(pb)) || '').includes(mode === 'sfu' ? 'Lounge' : 'MeshRoom'), String(await callBarText(pb)));
    await mnav(pb, 'chat', { kind: 'channel', serverId: server.id, channelId: general.id });
    await sleep(1500);
    await stillInCall(`${mode} chat open`);
    await tapEl(pb, '#m-callbar-mute');
    await sleep(800);
    check(`${mode}: call-bar mute sets muted`, await pb.evaluate(() => import('/js/state.js').then(({ state }) => state.voice.muted)));
    await tapEl(pb, '#m-callbar-mute');
    await mback(pb);
    await sleep(500);

    section(`${mode} c. background (home key) and relaunch`);
    adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
    await sleep(8000);
    const fg = adb('shell', 'dumpsys', 'activity', 'activities').match(/mResumedActivity.*|topResumedActivity.*/)?.[0] || '';
    check(`${mode}: app is in the background`, !fg.includes(PKG), fg.trim());
    const svc = adb('shell', 'dumpsys', 'activity', 'services', PKG);
    check(`${mode}: call foreground service running in the background`, /CallService/.test(svc));
    f = await H.waitFlowing([pa, pc], [2, 2], 12000);
    check(`${mode}: desktops still hear the phone (and each other) while it is in the background`, f.ok, H.fmt(f.last));
    const bgIn = await H.measure([pb]).catch((e) => { H.note('background measure failed', e.message); return null; });
    if (bgIn) check(`${mode}: phone still receives both while in the background`, bgIn[0].flowing === 2, H.fmt(bgIn));
    adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`);
    await sleep(3000);
    check(`${mode}: same app process after relaunch`, adb('shell', 'pidof', PKG).trim() === pid);
    await stillInCall(`${mode} after relaunch`);
    check(`${mode}: call bar after relaunch`, !!(await callBarText(pb)), String(await callBarText(pb)));

    section(`${mode} d. rotation`);
    await tapEl(pb, '#m-callbar-open');
    await pb.waitForSelector('.m-voice-room #vc-leave', { timeout: 8000 });
    adb('shell', 'settings', 'put', 'system', 'user_rotation', '1');
    await sleep(3000);
    const land = await pb.evaluate(() => ({ w: innerWidth, h: innerHeight, sw: document.documentElement.scrollWidth, leave: document.querySelector('.m-voice-room #vc-leave')?.getBoundingClientRect().bottom }));
    check(`${mode}: landscape layout (wider than tall, Leave on screen, no horizontal scroll)`, land.w > land.h && land.leave && land.leave <= land.h && land.sw <= land.w, JSON.stringify(land));
    await stillInCall(`${mode} landscape`);
    adb('shell', 'settings', 'put', 'system', 'user_rotation', '0');
    await sleep(2500);
    await stillInCall(`${mode} portrait again`);

    section(`${mode} e. camera + flip`);
    await tapEl(pb, '.m-voice-room #vc-camera');
    const camOn = await waitFor(() => pb.$('.m-voice-room #vc-flip-camera'), 10000);
    check(`${mode}: phone camera on (flip button shown)`, !!camOn);
    if (camOn) {
      f = await H.waitFlowing([pa, pc], [1, 1], 15000, 'videoFlowing');
      check(`${mode}: phone camera reaches both desktops`, f.ok, H.fmtV(f.last));
      const label0 = await pb.evaluate(() => window.__pcs.flatMap((p) => p.getSenders()).find((s) => s.track?.kind === 'video' && s.track.readyState === 'live')?.track.label);
      await tapEl(pb, '.m-voice-room #vc-flip-camera');
      await sleep(3000);
      const label1 = await pb.evaluate(() => window.__pcs.flatMap((p) => p.getSenders()).find((s) => s.track?.kind === 'video' && s.track.readyState === 'live')?.track.label);
      const cams = Number((adb('shell', 'dumpsys', 'media.camera').match(/Number of camera devices: (\d+)/) || [])[1] || 0);
      if (cams > 1) check(`${mode}: flip switched the camera`, !!label1 && label1 !== label0, `${label0} -> ${label1}`);
      else check(`${mode}: flip on a one-camera device reopens that camera`, !!label1, `${label0} -> ${label1}`);
      f = await H.waitFlowing([pa, pc], [1, 1], 15000, 'videoFlowing');
      check(`${mode}: video still reaches both after the flip`, f.ok, H.fmtV(f.last));
      await pb.evaluate(() => { const b = document.querySelector('.m-voice-room #vc-flip-camera'); b.click(); b.click(); });
      await sleep(4000);
      // mesh: one sender per peer, all sharing the same track
      const live = await pb.evaluate(() => new Set(window.__pcs.filter((p) => p.connectionState !== 'closed').flatMap((p) => p.getSenders()).filter((s) => s.track?.kind === 'video' && s.track.readyState === 'live').map((s) => s.track.id)).size);
      check(`${mode}: double-tapped flip: one live camera track`, live === 1, String(live));
      await tapEl(pb, '.m-voice-room #vc-camera');
      f = await H.waitFlowing([pa, pc], [0, 0], 10000, 'videoFlowing');
      check(`${mode}: camera off reaches the desktops`, f.ok, H.fmtV(f.last));
    }
    await stillInCall(`${mode} after camera`);

    section(`${mode} e2. hardware back, screen off, network blip`);
    adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
    await sleep(1500);
    check(`${mode}: back key leaves the call screen, call bar shows`, !!(await callBarText(pb)), String(await callBarText(pb)));
    await stillInCall(`${mode} after back key`);
    adb('shell', 'input', 'keyevent', 'KEYCODE_SLEEP');
    await sleep(8000);
    f = await H.waitFlowing([pa, pc], [2, 2], 12000);
    check(`${mode}: screen off: desktops still hear the phone`, f.ok, H.fmt(f.last));
    adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
    adb('shell', 'wm', 'dismiss-keyguard');
    await sleep(2500);
    await stillInCall(`${mode} screen on again`);
    const toasts0 = (await H.toasts(pb)).length;
    adb('shell', 'cmd', 'connectivity', 'airplane-mode', 'enable');
    await sleep(6000);
    adb('shell', 'cmd', 'connectivity', 'airplane-mode', 'disable');
    const back = await H.waitFlowing(all, [2, 2, 2], 45000);
    check(`${mode}: after a 6 s network loss the phone's audio comes back`, back.ok, `${H.fmt(back.last)} in ${back.ms} ms`);
    H.note(`${mode}: toasts during the blip`, JSON.stringify((await H.toasts(pb)).slice(toasts0)), 'joins', await H.sentCount(pb, 'voice_join'), 'pcs', JSON.stringify(await H.livePcIds(pb)));
    const roster = (await H.lastState(pa, room))?.participants.map((u) => u.id) || [];
    check(`${mode}: roster unique after the blip`, roster.length === 3 && new Set(roster).size === 3, JSON.stringify(roster));
    check(`${mode}: phone still in the call (call bar)`, !!(await callBarText(pb)));
    // A long outage: media fails (ICE consent) and the WebSocket goes too (adb reverse removed).
    const t1 = (await H.toasts(pb)).length, j1 = await H.sentCount(pb, 'voice_join');
    adb('shell', 'cmd', 'connectivity', 'airplane-mode', 'enable');
    adb('reverse', '--remove', `tcp:${PORT}`);
    await pb.evaluate(() => window.__sockets.forEach((s) => s.readyState === 1 && s.close())).catch(() => {});
    await sleep(40000);
    const mid = (await H.lastState(pa, room))?.participants.map((u) => u.id) || [];
    H.note(`${mode}: roster at the desktops during the 40 s outage`, JSON.stringify(mid));
    adb('shell', 'cmd', 'connectivity', 'airplane-mode', 'disable');
    adb('reverse', `tcp:${PORT}`, `tcp:${PORT}`);
    const back2 = await H.waitFlowing(all, [2, 2, 2], 60000);
    check(`${mode}: after a 40 s outage (media + WebSocket) the phone is back in the call`, back2.ok, `${H.fmt(back2.last)} in ${back2.ms} ms`);
    H.note(`${mode}: toasts`, JSON.stringify((await H.toasts(pb)).slice(t1)), 'new joins', (await H.sentCount(pb, 'voice_join')) - j1, 'pcs', JSON.stringify(await H.livePcIds(pb)));
    const r2 = (await H.lastState(pa, room))?.participants.map((u) => u.id) || [];
    check(`${mode}: roster unique after the outage`, r2.length === 3 && new Set(r2).size === 3, JSON.stringify(r2));
    if (mode === 'sfu') { const st = await alice.sfuStatus(); check('sfu: no leftover peer on the server after the outage', st.transports === 6, JSON.stringify(st)); }
    check(`${mode}: phone call bar after the outage`, !!(await callBarText(pb)), String(await callBarText(pb)));
    await tapEl(pb, '#m-callbar-open');
    await pb.waitForSelector('.m-voice-room #vc-leave', { timeout: 8000 });

    section(`${mode} f. leave / rejoin`);
    await tapEl(pb, '.m-voice-room #vc-leave');
    await sleep(1500);
    f = await H.waitFlowing(all, [1, 0, 1], 10000);
    check(`${mode}: phone out of the call`, f.ok, H.fmt(f.last));
    check(`${mode}: phone peer connections closed`, (await H.livePcIds(pb)).length === 0);
    const svc2 = adb('shell', 'dumpsys', 'activity', 'services', PKG);
    check(`${mode}: call foreground service stopped`, !/CallService/.test(svc2));
    if (mode === 'sfu') { const st = await alice.sfuStatus(); check('sfu: server down to 2 peers', st.transports === 4, JSON.stringify(st)); }
    await pb.waitForSelector('.m-voice-room #vc-join', { timeout: 8000 });
    await tapEl(pb, '.m-voice-room #vc-join');
    await pb.waitForSelector('.m-voice-room #vc-leave', { timeout: 20000 });
    f = await H.waitFlowing(all, [2, 2, 2], 20000);
    check(`${mode}: rejoin works`, f.ok, H.fmt(f.last));

    section(`${mode} g. app killed mid-call`);
    if (mode === 'mesh') {
      adb('shell', 'am', 'force-stop', PKG);
      f = await H.waitFlowing([pa, pc], [1, 1], 20000);
      check(`${mode}: after the app is killed the desktops keep talking`, f.ok, H.fmt(f.last));
      const r = await waitFor(async () => !(await H.lastState(pa, room))?.participants.some((u) => u.id === bob.user.id), 20000);
      check(`${mode}: killed phone leaves the roster`, !!r);
    } else {
      await tapEl(pb, '.m-voice-room #vc-leave');
      await sleep(1000);
    }
    H.checkNoPageErrors([pa, pc, pb].filter((p) => !p.isClosed()), `${mode}: no page errors`);
    await H.leaveVoice(pa); await H.leaveVoice(pc);
    await mback(pb).catch(() => {});
  }
  await phoneBrowser.close().catch(() => {});
  await device?.close().catch(() => {});
  await H.stopServer(srv);
  check('server log has no exceptions', srv.problems.length === 0, srv.problems.slice(0, 3).join(' | '));
});
