// Extra edge cases: rapid mute toggling, rapid camera toggling, double-clicked join, leaving while
// the SFU engine is still starting, switching rooms mid-start, quality badge, and a moderator
// force-mute racing the target's own mute toggles.
import * as H from './lib.mjs';
const { check, section, sleep, waitFor } = H;

H.run('edge', async () => {
  const srv = await H.startServer({ port: 8072, sfuPort: 46020 });
  const { apis, server, ch } = await H.world(srv, { users: ['alice', 'bob', 'carol'], voice: ['Lounge', 'Two'] });
  const { alice, bob, carol } = apis;
  const L = ch.Lounge.id, T = ch.Two.id;
  const pa = await H.openPage('alice'), pb = await H.openPage('bob'), pc = await H.openPage('carol');
  const all = [pa, pb, pc];
  await Promise.all([[pa, alice], [pb, bob], [pc, carol]].map(([p, a]) => H.loginPage(p, srv, a)));
  const counts = async () => { const s = await alice.sfuStatus(); return { rooms: s.rooms, t: s.transports, p: s.producers, c: s.consumers }; };
  const settled = (want, ms = 8000) => waitFor(async () => { const c = await counts(); return JSON.stringify(c) === JSON.stringify(want) && c; }, ms, 300);
  for (const p of all) await H.joinVoice(p, server.id, L);
  let f = await H.waitFlowing(all, [2, 2, 2], 15000);
  check('baseline', f.ok, H.fmt(f.last));

  section('quality badge');
  const title = await waitFor(() => pb.evaluate((u) => document.querySelector(`.voice-tile[data-uid="${u}"] .vc-quality`)?.title || null, alice.user.id), 6000);
  check('remote quality dot says SFU path', !!title && title.includes(H.en.voice.pathSfu), title);

  section('rapid mute toggling');
  for (let i = 0; i < 21; i++) await pa.click('#vc-mute');
  const mutedUi = !!(await pa.$('#vc-mute.active-danger'));
  f = await H.waitFlowing(all, [2, 1, 1], 8000);
  check('21 toggles end muted: UI muted and others receive nothing from alice', mutedUi && f.ok, `${mutedUi} ${H.fmt(f.last)}`);
  for (let i = 0; i < 9; i++) await pa.click('#vc-mute');
  f = await H.waitFlowing(all, [2, 2, 2], 8000);
  check('9 more toggles end unmuted: alice audible', !(await pa.$('#vc-mute.active-danger')) && f.ok, H.fmt(f.last));

  section('moderator force-mute racing the target\'s own toggles');
  const toggles = (async () => { for (let i = 0; i < 6; i++) { await pb.click('#vc-mute', { timeout: 300 }).catch(() => {}); await sleep(30); } })();
  await H.wsSend(pa, { type: 'voice_force_mute', channelId: L, userId: bob.user.id });
  await toggles;
  f = await H.waitFlowing(all, [1, 2, 1], 8000);
  check('force-muted bob stays silent whatever he clicks', f.ok, H.fmt(f.last));
  await H.wsSend(pa, { type: 'voice_force_unmute', channelId: L, userId: bob.user.id });
  await pb.waitForSelector('#vc-mute:not([disabled])');
  if (await pb.$('#vc-mute.active-danger')) await pb.click('#vc-mute');
  f = await H.waitFlowing(all, [2, 2, 2], 8000);
  check('after force-unmute bob can talk again', f.ok, H.fmt(f.last));

  section('rapid camera toggling');
  // every camera track the page ever opened, to spot one left running
  await pa.evaluate(() => {
    window.__cams = [];
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (c) => { const s = await gum(c); window.__cams.push(...s.getVideoTracks()); return s; };
  });
  for (let i = 0; i < 8; i++) await pa.click('#vc-camera');
  await sleep(3000);
  const camState = async () => ({
    ui: !!(await pa.$('#vc-camera.active')),
    live: await pa.evaluate(() => window.__cams.filter((t) => t.readyState === 'live').length),
    server: (await counts()).p - 3,
  });
  let cs = await camState();
  check('after 8 rapid camera clicks: live camera tracks, server camera producer and the button agree', cs.live === (cs.ui ? 1 : 0) && cs.server === (cs.ui ? 1 : 0), JSON.stringify(cs));
  if (cs.ui) await pa.click('#vc-camera');
  await sleep(1500);
  cs = await camState();
  check('turning it off leaves no live camera track and no producer', cs.live === 0 && cs.server === 0 && !cs.ui, JSON.stringify(cs));
  await pa.click('#vc-camera');
  const cam = await waitFor(() => pb.evaluate((u) => [...document.querySelectorAll('#voice-panel video[data-stream-key]')].some((v) => v.dataset.streamKey === `${u}:camera` && v.videoWidth > 0), alice.user.id), 10000);
  check('one more click: camera visible for bob', !!cam);
  await pa.click('#vc-camera');
  await sleep(1500);
  check('and off again: no producer', (await counts()).p === 3, JSON.stringify(await counts()));
  await pa.dblclick('#vc-screenshare');
  await sleep(3000);
  const ss = { ui: !!(await pa.$('#vc-screenshare.active')), server: (await counts()).p - 3 };
  check('double-clicked screen share: button and server agree', ss.server === (ss.ui ? 1 : 0), JSON.stringify(ss));
  if (ss.ui) await pa.click('#vc-screenshare');
  await sleep(1500);
  check('screen share off: no producer', (await counts()).p === 3, JSON.stringify(await counts()));

  section('double-clicked join, leave during engine start');
  await H.leaveVoice(pc);
  await settled({ rooms: 1, t: 4, p: 2, c: 2 });
  await pc.dblclick('#vc-join');
  await pc.waitForSelector('#vc-leave');
  f = await H.waitFlowing(all, [2, 2, 2], 15000);
  check('double-click join: one join, normal call', f.ok && (await H.livePcIds(pc)).length === 2, H.fmt(f.last));
  check('server counts normal after the double click', !!(await settled({ rooms: 1, t: 6, p: 3, c: 6 })), JSON.stringify(await counts()));
  await H.leaveVoice(pc);
  await settled({ rooms: 1, t: 4, p: 2, c: 2 });
  await pc.click('#vc-join');
  await pc.waitForSelector('#vc-leave');
  await pc.click('#vc-leave');
  await sleep(2500);
  check('leave right after join (engine starting): no leftover server peer', !!(await settled({ rooms: 1, t: 4, p: 2, c: 2 })), JSON.stringify(await counts()));
  check('carol has no live transports or audio', (await H.livePcIds(pc)).length === 0 && (await H.allAudioEls(pc)) === 0);

  section('switch rooms while the engine is starting');
  await pc.click('#vc-join');
  await pc.waitForSelector('#vc-leave');
  await H.joinVoice(pc, server.id, T);
  await sleep(2500);
  const c2 = await counts();
  check('carol ends up alone in Two; Lounge has 2 peers', c2.rooms === 2 && c2.t === 6, JSON.stringify(c2));
  const lr = (await H.lastState(pa, L))?.participants.map((u) => u.id) || [];
  check('carol not in the Lounge roster', !lr.includes(carol.user.id), JSON.stringify(lr));
  await H.leaveVoice(pc);
  check('after leaving Two only Lounge remains', !!(await settled({ rooms: 1, t: 4, p: 2, c: 2 })), JSON.stringify(await counts()));
  H.checkNoPageErrors(all);
  await H.stopServer(srv);
  check('server log has no exceptions', srv.problems.length === 0, srv.problems.slice(0, 3).join(' | '));
});
