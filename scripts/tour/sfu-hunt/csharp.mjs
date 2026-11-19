// Scenario B3: the C# (WebView2) client joins an SFU call and then a mesh call with two desktop Chrome
// peers, navigates during the call (text channel, DM, home), returns through the call bar, leaves and
// rejoins, and quits with a live call. The exe is copied into a temp dir so its data/ folder (config,
// WebView2 profile) is throwaway; the mcr:// and Run registry values are compared before/after.
// Usage: node scripts/tour/sfu-hunt/csharp.mjs [--exe <path to MeshCrowd.exe>]
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as H from './lib.mjs';
const { check, section, sleep, waitFor } = H;

const PORT = 8077, SFU_PORT = 46770, CDP = 9334;
const exeArg = process.argv.indexOf('--exe');
const SRC_EXE = exeArg > 0 ? process.argv[exeArg + 1] : path.join(H.root, 'ClientC#/dist/MeshCrowd.exe');

const reg = (args) => { try { return execFileSync('reg', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return '(absent)'; } };
const regSnapshot = () => ({
  mcr: reg(['query', 'HKCU\\Software\\Classes\\mcr', '/s']),
  run: reg(['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run']).split('\n').filter((l) => /MeshCrowd|Electron/i.test(l)).join('\n'),
});

H.run('csharp', async () => {
  const regBefore = regSnapshot();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-hunt-csharp-'));
  H.onCleanup(() => {
    const after = regSnapshot();
    console.log('REGISTRY unchanged:', after.mcr === regBefore.mcr && after.run === regBefore.run);
    if (after.mcr !== regBefore.mcr || after.run !== regBefore.run) console.log('BEFORE', JSON.stringify(regBefore), '\nAFTER', JSON.stringify(after));
    if (!H.KEEP) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  });
  const exe = path.join(dir, 'MeshCrowd.exe');
  fs.copyFileSync(SRC_EXE, exe);
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, 'data/dismesh-client-config.json'), JSON.stringify({
    serverUrl: `http://localhost:${PORT}/`, trustedFingerprints: {}, closeToTray: false, startMinimized: false, startWithWindows: false, handleInviteLinks: false,
  }, null, 2));

  const srv = await H.startServer({ port: PORT, sfuPort: SFU_PORT });
  const { apis, server, ch, general } = await H.world(srv, { users: ['alice', 'bob', 'carol'], voice: ['Lounge', 'MeshRoom'] });
  const { alice, bob, carol } = apis;
  const dm = (await bob.post('/api/dms', { userId: alice.user.id })).dmId;

  const proc = spawn(exe, ['--dev'], { cwd: dir, env: { ...process.env, MESHCROWD_CDP_PORT: String(CDP), MESHCROWD_BROWSER_ARGS: '--use-fake-ui-for-media-stream --use-fake-device-for-media-stream --autoplay-policy=no-user-gesture-required' }, stdio: 'ignore' });
  const kill = () => { if (proc.exitCode === null) { try { execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } } };
  H.onCleanup(kill);
  const up = await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${CDP}/json/version`)).ok; } catch { return false; } }, 30000);
  if (!up) throw new Error('C# client CDP port did not come up');
  const cb = await H.chromium.connectOverCDP(`http://127.0.0.1:${CDP}`);
  const pb = await waitFor(() => cb.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith(`http://localhost:${PORT}`)) || null, 30000);
  if (!pb) throw new Error('C# client page not found');
  pb.__name = 'csharp'; pb.__errors = []; pb.__benign = [];
  pb.on('pageerror', (e) => { pb.__errors.push(`pageerror: ${e.message}`); console.log('PAGEERR[csharp]', e.message); });
  pb.on('console', (m) => { if (m.type() === 'error' && !/favicon|status of 40[134]|WebSocket connection/i.test(m.text())) { pb.__errors.push(`console.error: ${m.text()}`); console.log('CONSOLEERR[csharp]', m.text().slice(0, 300)); } });
  await pb.evaluate(async ([u, pw]) => {
    const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: pw }) });
    if (!r.ok) throw new Error(`login ${r.status}`);
  }, ['bob', H.PASSWORD]);
  const cdp = await pb.context().newCDPSession(pb);
  await cdp.send('Page.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: H.INIT });
  await pb.reload();
  await pb.waitForSelector('[data-server]', { timeout: 30000 });
  await waitFor(() => pb.evaluate(() => window.__sockets?.some((s) => s.readyState === 1)), 15000);
  H.note('C# UA', await pb.evaluate(() => navigator.userAgent), '| shell', await pb.evaluate(() => JSON.stringify(Object.keys(window.dismeshClient || {})).slice(0, 120)));

  const pa = await H.openPage('alice'), pc = await H.openPage('carol');
  await H.loginPage(pa, srv, alice); await H.loginPage(pc, srv, carol);
  const callBar = () => pb.evaluate(() => (document.querySelector('#cb-leave') ? document.querySelector('.call-bar-name')?.textContent : null));

  for (const mode of ['sfu', 'mesh']) {
    section(`=== ${mode.toUpperCase()}`);
    const room = mode === 'sfu' ? ch.Lounge.id : ch.MeshRoom.id;
    const name = mode === 'sfu' ? 'Lounge' : 'MeshRoom';
    if (mode === 'mesh') await alice.patch('/api/admin/calls', { voice: { mode: 'mesh' } });
    await H.joinVoice(pa, server.id, room); await H.joinVoice(pc, server.id, room);
    const all = [pa, pb, pc];
    await H.joinVoice(pb, server.id, room);
    let f = await H.waitFlowing(all, [2, 2, 2], 20000);
    check(`${mode}: C# client in a 3-way call`, f.ok, H.fmt(f.last));
    check(`${mode}: room mode`, (await H.lastState(pa, room))?.mode === mode);
    check(`${mode}: mic permission granted in WebView2`, (await pb.evaluate(() => navigator.permissions.query({ name: 'microphone' }).then((p) => p.state))) === 'granted');
    const pcs0 = await H.livePcIds(pb), joins0 = await H.sentCount(pb, 'voice_join');
    const still = async (label) => {
      const m = await H.waitFlowing(all, [2, 2, 2], 10000);
      check(`${label}: audio flows`, m.ok, H.fmt(m.last));
      check(`${label}: same peer connections, no rejoin`, JSON.stringify(await H.livePcIds(pb)) === JSON.stringify(pcs0) && (await H.sentCount(pb, 'voice_join')) === joins0);
      check(`${label}: call bar shows ${name}`, (await callBar()) === name, String(await callBar()));
    };

    section(`${mode} navigate during the call`);
    await H.openChannel(pb, server.id, general.id);
    await sleep(1200);
    await still(`${mode} text channel`);
    await H.navigate(pb, { type: 'dm', dmId: dm });
    await sleep(1000);
    await still(`${mode} DM view`);
    await H.navigate(pb, { type: 'home' });
    await sleep(800);
    await still(`${mode} home`);
    await pb.click('#cb-return');
    await pb.waitForSelector('#voice-panel #vc-leave', { timeout: 6000 });
    check(`${mode}: call bar returns to the call view with 3 tiles`, (await pb.$$eval('#voice-panel .voice-tile', (e) => e.length)) === 3);
    await pb.click('#vc-camera');
    f = await H.waitFlowing([pa, pc], [1, 1], 12000, 'videoFlowing');
    check(`${mode}: C# camera reaches both`, f.ok, H.fmtV(f.last));
    await pb.click('#vc-camera');
    f = await H.waitFlowing([pa, pc], [0, 0], 10000, 'videoFlowing');
    check(`${mode}: C# camera off`, f.ok, H.fmtV(f.last));

    section(`${mode} leave from the call bar + rejoin`);
    await H.openChannel(pb, server.id, general.id);
    await sleep(800);
    await pb.click('#cb-leave');
    f = await H.waitFlowing(all, [1, 0, 1], 10000);
    check(`${mode}: C# client out`, f.ok && (await H.livePcIds(pb)).length === 0, H.fmt(f.last));
    await H.joinVoice(pb, server.id, room);
    f = await H.waitFlowing(all, [2, 2, 2], 20000);
    check(`${mode}: rejoin works`, f.ok, H.fmt(f.last));
    if (mode === 'sfu') {
      await H.leaveVoice(pb);
      await H.leaveVoice(pa); await H.leaveVoice(pc);
    }
  }

  section('quit with a live (mesh) call');
  kill();
  const gone = await waitFor(async () => !(await H.lastState(pa, ch.MeshRoom.id))?.participants.some((u) => u.id === bob.user.id), 15000);
  check('killing the C# client frees its place in the call', !!gone);
  const f = await H.waitFlowing([pa, pc], [1, 1], 10000);
  check('the others keep talking', f.ok, H.fmt(f.last));
  H.checkNoPageErrors([pa, pc]);
  const csErr = pb.__errors.filter((e) => !/Target (page|closed)|disconnected/i.test(e));
  check('no page errors in the C# client', csErr.length === 0, csErr.slice(0, 5).join(' | '));
  await cb.close().catch(() => {});
  await H.stopServer(srv);
  check('server log has no exceptions', srv.problems.length === 0, srv.problems.slice(0, 3).join(' | '));
});
