// Scenario 3: camera and screen share in SFU mode: start/stop, two sharers, late viewer, sharer
// leaves, bitrate caps (voice.sfu.maxKbpsPerUser), audio device graph change (replaceTrack).
import * as H from './lib.mjs';
const { check, section, sleep, waitFor } = H;

H.run('video', async () => {
  const srv = await H.startServer({ port: 8072, sfuPort: 46020 });
  const { apis, server, ch } = await H.world(srv, { users: ['alice', 'bob', 'carol', 'dave'], voice: ['Lounge'] });
  const { alice, bob, carol, dave } = apis;
  const L = ch.Lounge.id;
  const ids = { alice: alice.user.id, bob: bob.user.id, carol: carol.user.id, dave: dave.user.id };
  const pa = await H.openPage('alice'), pb = await H.openPage('bob'), pc = await H.openPage('carol');
  const three = [pa, pb, pc];
  await Promise.all([[pa, alice], [pb, bob], [pc, carol]].map(([p, a]) => H.loginPage(p, srv, a)));
  for (const p of three) await H.joinVoice(p, server.id, L);
  let f = await H.waitFlowing(three, [2, 2, 2], 15000);
  check('baseline: 3-way audio', f.ok, H.fmt(f.last));

  // video tiles with a playing <video> (videoWidth > 0) per user id and media
  const videoTiles = (p) => p.evaluate(() => [...document.querySelectorAll('#voice-panel video[data-stream-key]')]
    .map((v) => ({ key: v.dataset.streamKey, playing: v.videoWidth > 0 && v.srcObject?.getVideoTracks().some((t) => t.readyState === 'live') })));
  const playingKeys = async (p) => (await videoTiles(p)).filter((v) => v.playing).map((v) => v.key).sort();

  section('3a. camera on/off');
  await pa.click('#vc-camera');
  const camSeen = await waitFor(async () => {
    const [b, c] = await Promise.all([playingKeys(pb), playingKeys(pc)]);
    return b.includes(`${ids.alice}:camera`) && c.includes(`${ids.alice}:camera`) && [b, c];
  }, 15000);
  check('bob and carol see alice\'s camera tile playing', !!camSeen, JSON.stringify(camSeen));
  f = await H.measure(three);
  check('video RTP flows to bob and carol', f[1].videoFlowing === 1 && f[2].videoFlowing === 1, H.fmtV(f));
  check('camera bitrate within the default cap (1500 kbps)', f[0].videoKbpsOut <= 1500 * 1.15, `${f[0].videoKbpsOut} kbps out`);
  check('alice sees her own camera preview', (await playingKeys(pa)).includes(`${ids.alice}:camera`));
  await pa.click('#vc-camera');
  const camGone = await waitFor(async () => !(await playingKeys(pb)).includes(`${ids.alice}:camera`) && !(await pb.$(`.voice-tile.has-video[data-uid="${ids.alice}"]`)), 5000);
  check('camera off: alice\'s video tile disappears for bob', !!camGone);
  f = await H.measure(three);
  check('audio unaffected by the camera toggle', f.every((x) => x.flowing === 2), H.fmt(f));
  let st = await alice.sfuStatus();
  check('server: 3 producers left (audio only)', st.producers === 3, JSON.stringify({ p: st.producers, c: st.consumers }));

  section('3b. two screen sharers, late viewer, sharer leaves');
  await pb.click('#vc-screenshare');
  const bShare = await waitFor(async () => (await playingKeys(pa)).includes(`${ids.bob}:screen`), 15000);
  check('bob\'s screen share plays for alice', !!bShare, JSON.stringify(await videoTiles(pa)));
  if (!bShare) H.note('bob toasts', JSON.stringify(await H.toasts(pb)));
  await pc.click('#vc-screenshare');
  await pa.click('#vc-camera');
  const both = await waitFor(async () => {
    const k = await playingKeys(pa);
    return k.includes(`${ids.bob}:screen`) && k.includes(`${ids.carol}:screen`) && k;
  }, 15000);
  check('two screen shares at once play for alice', !!both, JSON.stringify(await playingKeys(pa)));
  f = await H.measure([pb]);
  check('screen bitrate within the default cap (3500 kbps)', f[0].videoKbpsOut <= 3500 * 1.15, `${f[0].videoKbpsOut} kbps`);
  const pd = await H.openPage('dave');
  await H.loginPage(pd, srv, dave);
  await H.joinVoice(pd, server.id, L);
  const late = await waitFor(async () => {
    const k = await playingKeys(pd);
    return [`${ids.alice}:camera`, `${ids.bob}:screen`, `${ids.carol}:screen`].every((x) => k.includes(x)) && k;
  }, 15000);
  check('late joiner dave gets every existing camera/screen', !!late, JSON.stringify(await playingKeys(pd)));
  f = await H.waitFlowing([pd], [3], 10000);
  check('dave hears all three', f.ok, H.fmt(f.last));
  await H.leaveVoice(pb);
  const bobGone = await waitFor(async () => {
    const [a, c, d] = await Promise.all([pa, pc, pd].map(playingKeys));
    return [a, c, d].every((k) => !k.includes(`${ids.bob}:screen`)) && [a, c, d];
  }, 5000);
  check('bob leaves while sharing: his screen tile disappears everywhere', !!bobGone, JSON.stringify(await playingKeys(pa)));
  const bobTiles = await pa.$$(`.voice-tile[data-uid="${ids.bob}"]`);
  check('no tile of bob left on alice', bobTiles.length === 0, String(bobTiles.length));
  await pc.click('#vc-screenshare');
  const cStop = await waitFor(async () => !(await playingKeys(pa)).includes(`${ids.carol}:screen`), 5000);
  check('carol stops sharing: tile goes away', !!cStop);
  // the browser's own "stop sharing" (track ended) path
  await pc.click('#vc-screenshare');
  await waitFor(async () => (await playingKeys(pa)).includes(`${ids.carol}:screen`), 10000);
  await pc.evaluate(() => { for (const v of document.querySelectorAll('video')) for (const t of v.srcObject?.getVideoTracks() || []) if (t.label && /screen|window|tab|desktop/i.test(t.label + t.getSettings().displaySurface)) { t.stop(); t.dispatchEvent(new Event('ended')); } });
  const ended = await waitFor(async () => !(await playingKeys(pa)).includes(`${ids.carol}:screen`) && !(await pc.$('#vc-screenshare.active')), 5000);
  check('native "stop sharing" (track ended) stops the share for everyone', !!ended);
  st = await alice.sfuStatus();
  check('server producers: 3 audio + alice camera', st.producers === 4, JSON.stringify({ p: st.producers, c: st.consumers }));
  H.checkNoPageErrors([pa, pb, pc, pd]);

  section('3c. input graph change mid-call (replaceTrack)');
  const prodsBefore = await sentCount(pa, 'produce');
  await pa.evaluate(() => import('/js/voicePrefs.js').then(({ voicePrefs }) => voicePrefs.set({ inputVolume: 0.6 })));
  await sleep(1500);
  f = await H.waitFlowing([pa, pc, pd], [2, 2, 2], 10000);
  check('after an input volume change (new send track) audio still flows', f.ok, H.fmt(f.last));
  check('no new audio producer (track replaced in place)', (await sentCount(pa, 'produce')) === prodsBefore, `${prodsBefore} -> ${await sentCount(pa, 'produce')}`);
  await pa.evaluate(() => import('/js/voicePrefs.js').then(({ voicePrefs }) => voicePrefs.set({ inputVolume: 1 })));
  for (const p of [pa, pc, pd]) await H.leaveVoice(p);

  section('3d. per-user cap voice.sfu.maxKbpsPerUser = 300');
  const patched = await alice.patch('/api/admin/calls', { voice: { sfu: { maxKbpsPerUser: 300 } } });
  check('admin PATCH accepts maxKbpsPerUser 300', patched.voice.sfu.maxKbpsPerUser === 300, JSON.stringify(patched.voice.sfu));
  await H.joinVoice(pa, server.id, L);
  await H.joinVoice(pc, server.id, L);
  const caps = await pa.evaluate(() => { const r = Object.values(window.__responses).filter((x) => x.data?.limits).at(-1); return r?.data.limits; });
  check('caps limits reflect the cap', caps && caps.audio === 64 && caps.camera === 300 && caps.screen === 300, JSON.stringify(caps));
  await pa.click('#vc-camera');
  await pa.click('#vc-screenshare');
  await waitFor(async () => (await playingKeys(pc)).length >= 2, 15000);
  await sleep(4000);
  f = await H.measure([pa, pc], 3000);
  const enc = await pa.evaluate(() => window.__sent.filter((m) => m.type === 'sfu_request' && m.op === 'produce').slice(-3).map((m) => [m.data.media, m.data.rtpParameters.encodings?.[0]?.maxBitrate]));
  check('produce encodings carry maxBitrate 300000 for camera/screen, <= 64000 audio', enc.every(([m, b]) => (m === 'audio' ? b <= 64000 : b === 300000)), JSON.stringify(enc));
  check('alice\'s video upload respects the cap (2 x 300 kbps)', f[0].videoKbpsOut <= 600 * 1.2, `${f[0].videoKbpsOut} kbps out`);
  check('carol still receives both videos', f[1].videoFlowing === 2, H.fmtV([f[1]]));
  for (const p of [pa, pc]) await H.leaveVoice(p);
  const z = await waitFor(async () => { const s = await alice.sfuStatus(); return s.rooms === 0 && s.transports === 0 && s; }, 5000);
  check('SFU empty after', !!z);
  H.checkNoPageErrors([pa, pb, pc, pd]);
  await H.stopServer(srv);
  check('server log has no exceptions', srv.problems.length === 0, srv.problems.slice(0, 3).join(' | '));
});

function sentCount(p, op) {
  return p.evaluate((o) => window.__sent.filter((m) => m.type === 'sfu_request' && m.op === o && m.data?.media === 'audio').length, op);
}
