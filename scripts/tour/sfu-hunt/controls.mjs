// Scenario 4: mute, deafen, push-to-talk, per-user volume, output device, soundboard, whiteboard
// and remote speaking indicators while in an SFU call.
import * as H from './lib.mjs';
const { check, section, sleep, waitFor } = H;

function wav(seconds = 0.4, rate = 8000) {
  const n = Math.floor(seconds * rate);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 440) * 8000), 44 + i * 2);
  return b;
}

H.run('controls', async () => {
  const srv = await H.startServer({ port: 8073, sfuPort: 46030 });
  const { apis, server, ch } = await H.world(srv, { users: ['alice', 'bob', 'carol'], voice: ['Lounge'] });
  const { alice, bob, carol } = apis;
  const L = ch.Lounge.id;
  const ids = { alice: alice.user.id, bob: bob.user.id, carol: carol.user.id };
  const fd = new FormData();
  fd.append('name', 'beep');
  fd.append('audio', new Blob([wav()], { type: 'audio/wav' }), 'beep.wav');
  const up = await fetch(`${srv.base}/api/servers/${server.id}/sounds`, { method: 'POST', headers: { cookie: alice.cookie }, body: fd });
  const sound = up.ok ? (await up.json()).sound : null;
  check('soundboard clip uploaded', !!sound, up.ok ? '' : `${up.status} ${await up.text()}`);

  const pa = await H.openPage('alice'), pb = await H.openPage('bob'), pc = await H.openPage('carol');
  const all = [pa, pb, pc];
  await Promise.all([[pa, alice], [pb, bob], [pc, carol]].map(([p, a]) => H.loginPage(p, srv, a)));
  for (const p of all) await H.joinVoice(p, server.id, L);
  let f = await H.waitFlowing(all, [2, 2, 2], 15000);
  check('baseline: 3-way audio', f.ok, H.fmt(f.last));
  const speaking = (p, uid) => p.evaluate((u) => document.querySelector(`#voice-panel .voice-tile[data-uid="${u}"]`)?.classList.contains('speaking') ?? null, uid);
  // The fake device's beep reaches the remote meter at about the speaking threshold, so the ring
  // flickers; the level strip under the tile is the reliable signal: peak width over 2 s.
  const level = (p, uid) => p.evaluate(async (u) => { let m = 0; for (let i = 0; i < 16; i++) { await new Promise((r) => setTimeout(r, 125)); m = Math.max(m, parseFloat(document.querySelector(`#voice-panel [data-level-uid="${u}"]`)?.style.width) || 0); } return m; }, uid);
  const speakingSeen = (p, uid, want, ms = 6000) => waitFor(async () => { const l = await level(p, uid); return want ? l > 4 : l < 1; }, ms, 0);
  check('speaking indicator: bob sees alice speaking (fake beep)', !!(await speakingSeen(pb, ids.alice, true)));

  section('4a. mute');
  await pa.click('#vc-mute');
  f = await H.waitFlowing(all, [2, 1, 1], 8000);
  check('alice muted: bob and carol stop receiving her (producer paused)', f.ok, H.fmt(f.last));
  check('pause_producer sent', (await pa.evaluate(() => window.__sent.some((m) => m.op === 'pause_producer'))));
  check('bob\'s speaking indicator for alice goes off', !!(await speakingSeen(pb, ids.alice, false)));
  await pa.click('#vc-mute');
  f = await H.waitFlowing(all, [2, 2, 2], 8000);
  check('unmute: alice heard again', f.ok, H.fmt(f.last));

  section('4b. deafen');
  await pa.click('#vc-deafen');
  await sleep(500);
  const vols = await pa.evaluate(() => [...document.querySelectorAll('body > audio')].map((a) => a.volume));
  check('deafened: every remote audio element at volume 0', vols.length === 2 && vols.every((v) => v === 0), JSON.stringify(vols));
  f = await H.waitFlowing(all, [2, 1, 1], 8000);
  check('deafen also stops alice sending', f.ok, H.fmt(f.last));
  const userbar = await pa.evaluate(() => import('/js/state.js').then(({ state }) => state.voice));
  check('global voice state shows muted+deafened', userbar.muted && userbar.deafened, JSON.stringify(userbar));
  await pa.click('#vc-deafen');
  await sleep(500);
  const vols2 = await pa.evaluate(() => [...document.querySelectorAll('body > audio')].map((a) => a.volume));
  f = await H.waitFlowing(all, [2, 2, 2], 8000);
  check('undeafen restores volume and sending', vols2.every((v) => v === 1) && f.ok, `${JSON.stringify(vols2)} ${H.fmt(f.last)}`);

  section('4c. push-to-talk');
  await pa.evaluate(() => import('/js/voicePrefs.js').then(({ voicePrefs }) => voicePrefs.set({ pttEnabled: true, pttKey: 'KeyV' })));
  await sleep(800);
  check('PTT on: mute button disabled and hint shown', !!(await pa.$('#vc-mute[disabled]')) && !!(await pa.$('.vc-ptt-hint')));
  // A disabled track sends Opus DTX (a few packets a second), an enabled one ~50/s: alice's
  // outbound packet rate is the reliable PTT signal (the fake tone's level is not, see report).
  const rate = async () => (await H.measure([pa]))[0].sent;
  const idle = await rate();
  check('PTT idle: alice sends almost nothing (DTX)', idle < 40, `${idle} packets/2s`);
  await pa.keyboard.down('v');
  const held = await rate();
  check('PTT held: alice sends a full stream', held > 80, `${held} packets/2s`);
  await pa.keyboard.up('v');
  const released = await rate();
  check('PTT released: back to DTX', released < 40, `${released} packets/2s`);
  await pa.evaluate(() => import('/js/voicePrefs.js').then(({ voicePrefs }) => voicePrefs.set({ pttEnabled: false })));
  await sleep(1500);
  const off = await rate();
  check('PTT off: full stream again', off > 80, `${off} packets/2s`);

  section('4d. per-user volume and output device');
  await pb.evaluate((u) => { const s = document.querySelector(`.vc-volume[data-uid="${u}"]`); s.value = '0'; s.dispatchEvent(new Event('input')); }, ids.alice);
  const v0 = await pb.evaluate(() => [...document.querySelectorAll('body > audio')].map((a) => a.volume).sort());
  check('bob sets alice to 0: one remote element at 0, the other at 1', JSON.stringify(v0) === '[0,1]', JSON.stringify(v0));
  await pb.click('#vc-mute'); await pb.click('#vc-mute');
  const v1 = await pb.evaluate(() => [...document.querySelectorAll('body > audio')].map((a) => a.volume).sort());
  check('the slider value survives a re-render', JSON.stringify(v1) === '[0,1]', JSON.stringify(v1));
  const outs = await pb.evaluate(async () => (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput').map((d) => d.deviceId));
  const target = outs.find((d) => d !== 'default') || outs[0];
  await pb.evaluate((id) => import('/js/voicePrefs.js').then(({ voicePrefs }) => voicePrefs.set({ outputDeviceId: id })), target);
  const sinks = await waitFor(async () => { const s = await pb.evaluate(() => [...document.querySelectorAll('body > audio')].map((a) => a.sinkId)); return s.every((x) => x === target) && s; }, 4000);
  check('output device switch applies setSinkId to every remote audio element', !!sinks, `${target} ${JSON.stringify(sinks)}`);
  f = await H.waitFlowing(all, [2, 2, 2], 8000);
  check('audio keeps flowing after the device switch', f.ok, H.fmt(f.last));

  section('4e. soundboard and whiteboard');
  if (sound) {
    await H.wsSend(pa, { type: 'voice_soundboard_play', channelId: L, soundId: sound.id });
    const got = await waitFor(async () => (await Promise.all(all.map((p) => p.evaluate(() => window.__frames.some((x) => x.type === 'voice_soundboard_play'))))).every(Boolean), 4000);
    check('soundboard play reaches every participant (sender included)', !!got);
    await pa.click('#vc-soundboard');
    const item = await waitFor(() => pa.$(`[data-sound-id="${sound.id}"]`), 3000);
    check('soundboard picker opens and lists the clip', !!item);
    const before = await pb.evaluate(() => window.__frames.filter((x) => x.type === 'voice_soundboard_play').length);
    if (item) await item.click();
    check('clicking the clip plays it for bob', !!(await waitFor(async () => (await pb.evaluate(() => window.__frames.filter((x) => x.type === 'voice_soundboard_play').length)) > before, 4000)));
    await pa.keyboard.press('Escape');
  }
  await pa.click('#vc-whiteboard');
  const canvas = await waitFor(() => pa.$('#voice-panel canvas'), 3000);
  check('whiteboard opens', !!canvas);
  if (canvas) {
    const box = await canvas.boundingBox();
    await pa.mouse.move(box.x + 20, box.y + 20);
    await pa.mouse.down();
    for (let i = 1; i < 10; i++) await pa.mouse.move(box.x + 20 + i * 10, box.y + 20 + i * 5);
    await pa.mouse.up();
    const stroke = await waitFor(() => pb.evaluate(() => window.__frames.some((x) => x.type === 'wb_stroke')), 4000);
    check('a stroke drawn by alice reaches bob', !!stroke);
  }
  f = await H.measure(all);
  check('audio still flows after soundboard/whiteboard', f.every((x) => x.flowing === 2), H.fmt(f));
  for (const p of all) await H.leaveVoice(p);
  H.checkNoPageErrors(all);
  await H.stopServer(srv);
  check('server log has no exceptions', srv.problems.length === 0, srv.problems.slice(0, 3).join(' | '));
});
