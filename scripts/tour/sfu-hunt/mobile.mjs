// Scenario B2: the mobile web layout (/m/) in a phone-emulated Chrome, against two desktop peers.
// Runs the same flows in SFU and in mesh mode: join, back to the list (call bar), chat while in the
// call, call-bar mute/open/leave, opening a second voice room during a call, camera on + flip (also a
// double-tapped flip), rotation, DM call, leave/rejoin. Usage: node scripts/tour/sfu-hunt/mobile.mjs
import * as H from './lib.mjs';
const { check, section, sleep, waitFor } = H;

// Records every camera track the page opens, so leaked (still live) tracks can be counted.
const TRACKS = `(() => {
  window.__camTracks = [];
  const md = navigator.mediaDevices;
  const gum = md.getUserMedia.bind(md);
  md.getUserMedia = async (c) => { const s = await gum(c); for (const t of s.getVideoTracks()) window.__camTracks.push(t); return s; };
})();`;

async function openPhone(name, { width = 390, height = 844 } = {}) {
  const browser = await H.chromium.launch({ executablePath: H.CHROME, headless: true, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  H.browsers.push(browser);
  const ctx = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, permissions: ['microphone', 'camera'], locale: 'en-US',
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36' });
  await ctx.addInitScript(H.INIT);
  await ctx.addInitScript(TRACKS);
  const page = await ctx.newPage();
  page.__name = name; page.__errors = []; page.__benign = [];
  page.on('pageerror', (e) => { page.__errors.push(`pageerror: ${e.message}`); console.log(`PAGEERR[${name}]`, e.message); });
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|status of 40[134]|WebSocket connection/i.test(m.text())) { page.__errors.push(`console.error: ${m.text()}`); console.log(`CONSOLEERR[${name}]`, m.text().slice(0, 300)); } });
  return page;
}

const mnav = (page, name, params) => page.evaluate(([n, p]) => import('/m/router.js').then(({ nav }) => nav.push(n, p)), [name, params]);
const mback = (page) => page.evaluate(() => import('/m/router.js').then(({ nav }) => nav.back()));
const callBarText = (page) => page.evaluate(() => { const b = document.getElementById('m-callbar'); return b && !b.hidden ? b.innerText.trim() : null; });
const liveCams = (page) => page.evaluate(() => window.__camTracks.filter((t) => t.readyState === 'live').length);
const producers = async (api) => (await api.sfuStatus()).producers;

async function flows(mode, port, sfuPort) {
  section(`=== ${mode.toUpperCase()} mode`);
  const srv = await H.startServer({ port, sfuPort, mode });
  const { apis, server, ch, general } = await H.world(srv, { users: ['alice', 'bob', 'carol'], voice: ['Lounge', 'Lounge Two'] });
  const { alice, bob, carol } = apis;
  const L = ch.Lounge.id, L2 = ch['Lounge Two'].id;
  const dm = (await bob.post('/api/dms', { userId: alice.user.id })).dmId;
  await bob.post(`/api/dms/${dm}/messages`, { content: 'hi' }).catch((e) => H.note('dm message', e.message));
  const pa = await H.openPage('alice'), pc = await H.openPage('carol');
  const pb = await openPhone('bob-phone');
  const all = [pa, pb, pc];
  await H.loginPage(pa, srv, alice); await H.loginPage(pc, srv, carol);
  await pb.context().addCookies([{ name: 'dismesh_session', value: bob.session(), domain: 'localhost', path: '/', httpOnly: true }]);
  await pb.goto(`${srv.base}/m/`);
  await pb.waitForSelector('#m-host', { timeout: 20000 });
  await waitFor(() => pb.evaluate(() => window.__sockets.some((s) => s.readyState === 1)), 10000);
  await sleep(800);
  await H.joinVoice(pa, server.id, L); await H.joinVoice(pc, server.id, L);

  section(`${mode} a. phone joins from the voice screen`);
  await mnav(pb, 'voice', { kind: 'channel', serverId: server.id, channelId: L });
  await pb.waitForSelector('.m-voice-room #vc-join', { timeout: 10000 });
  await pb.click('.m-voice-room #vc-join');
  await pb.waitForSelector('.m-voice-room #vc-leave', { timeout: 15000 });
  let f = await H.waitFlowing(all, [2, 2, 2], 20000);
  check(`${mode}: 3-way audio with the phone`, f.ok, H.fmt(f.last));
  const pcs0 = await H.livePcIds(pb);
  const joins0 = await H.sentCount(pb, 'voice_join');
  check(`${mode}: phone has ${mode === 'sfu' ? 2 : 2} peer connections`, pcs0.length === 2, JSON.stringify(pcs0));
  check(`${mode}: no call bar while the voice screen is open`, (await callBarText(pb)) === null);
  const lay = await pb.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: innerWidth, ctrls: [...document.querySelectorAll('.m-voice-room .voice-controls > *')].map((e) => { const r = e.getBoundingClientRect(); return [e.id, Math.round(r.left), Math.round(r.right)]; }) }));
  check(`${mode}: voice controls fit the 390px screen`, lay.sw <= lay.w && lay.ctrls.every(([, l, r]) => l >= 0 && r <= lay.w), JSON.stringify(lay));

  async function stillInCall(label, pcsExpected = pcs0) {
    const m = await H.measure(all);
    check(`${label}: audio flows 3-way`, m.every((x) => x.flowing === 2), H.fmt(m));
    check(`${label}: same peer connections, no rejoin`, JSON.stringify(await H.livePcIds(pb)) === JSON.stringify(pcsExpected) && (await H.sentCount(pb, 'voice_join')) === joins0,
      `${JSON.stringify(await H.livePcIds(pb))} joins ${await H.sentCount(pb, 'voice_join')}`);
  }

  section(`${mode} b. back to the list: call bar`);
  await mback(pb);
  await sleep(800);
  const cb = await callBarText(pb);
  check(`${mode}: call bar shows the room after going back`, !!cb && cb.includes('Lounge'), String(cb));
  await stillInCall(`${mode} list view`);
  const barBox = await pb.evaluate(() => { const r = document.getElementById('m-callbar').getBoundingClientRect(); return [r.left, r.right, r.height]; });
  check(`${mode}: call bar inside the screen`, barBox[0] >= 0 && barBox[1] <= 390 && barBox[2] > 20, JSON.stringify(barBox));

  section(`${mode} c. chat during the call`);
  await mnav(pb, 'chat', { kind: 'channel', serverId: server.id, channelId: general.id });
  await sleep(1200);
  const box = await waitFor(() => pb.$('.m-composer textarea, .m-composer [contenteditable], textarea'), 5000);
  if (box) {
    await box.click(); await pb.keyboard.type('hi from the phone call');
    const send = await pb.$('.m-composer [id*=send], #m-send, button[aria-label="Send"]');
    if (send) await send.click(); else await pb.keyboard.press('Enter');
  }
  const posted = await waitFor(async () => (await alice.get(`/api/servers/${server.id}/channels/${general.id}/messages`)).messages?.some((m) => m.content === 'hi from the phone call'), 5000);
  check(`${mode}: message sent from the chat during the call`, !!posted);
  check(`${mode}: call bar visible over the chat`, ((await callBarText(pb)) || '').includes('Lounge'));
  await stillInCall(`${mode} chat`);

  section(`${mode} d. call bar mute / unmute`);
  await pb.click('#m-callbar-mute');
  if (mode === 'sfu') {
    f = await H.waitFlowing(all, [1, 2, 1], 8000);
    check(`${mode}: call-bar mute stops the others receiving the phone`, f.ok, H.fmt(f.last));
  } else {
    // mesh mutes by disabling the sending track (silence keeps flowing as RTP)
    const en = await waitFor(() => pb.evaluate(() => { const s = window.__pcs.filter((p) => p.connectionState !== 'closed').flatMap((p) => p.getSenders()).filter((x) => x.track?.kind === 'audio'); return s.length && s.every((x) => !x.track.enabled) ? s.length : 0; }), 5000);
    check(`${mode}: call-bar mute disables the phone's audio senders`, !!en, String(en));
  }
  await pb.click('#m-callbar-mute');
  f = await H.waitFlowing(all, [2, 2, 2], 8000);
  check(`${mode}: call-bar unmute restores`, f.ok, H.fmt(f.last));

  section(`${mode} e. call bar opens the call screen`);
  await pb.click('#m-callbar-open');
  await pb.waitForSelector('.m-voice-room #vc-leave', { timeout: 5000 });
  const tiles = await pb.$$eval('.m-voice-room .voice-tile', (els) => els.length);
  check(`${mode}: call screen re-attached with 3 tiles`, tiles === 3, String(tiles));
  check(`${mode}: call bar hidden on the call screen`, (await callBarText(pb)) === null);
  await stillInCall(`${mode} re-attached`);

  section(`${mode} f. camera, flip, double-tapped flip`);
  await pb.click('.m-voice-room #vc-camera');
  await pb.waitForSelector('.m-voice-room #vc-flip-camera', { timeout: 8000 });
  f = await H.waitFlowing([pa, pc], [1, 1], 10000, 'videoFlowing');
  check(`${mode}: phone camera reaches both desktops`, f.ok, H.fmtV(f.last));
  await pb.click('.m-voice-room #vc-flip-camera');
  await sleep(1500);
  check(`${mode}: after a flip exactly one live camera track`, (await liveCams(pb)) === 1, String(await liveCams(pb)));
  f = await H.waitFlowing([pa, pc], [1, 1], 10000, 'videoFlowing');
  check(`${mode}: video still reaches both after the flip`, f.ok, H.fmtV(f.last));
  if (mode === 'sfu') check('sfu: flip replaced the track (still 2 producers for the phone, 4 total)', (await producers(alice)) === 4, String(await producers(alice)));
  await pb.evaluate(() => { const b = document.querySelector('.m-voice-room #vc-flip-camera'); b.click(); b.click(); b.click(); });
  await sleep(2500);
  const liveAfterTriple = await liveCams(pb);
  check(`${mode}: triple-tapped flip leaves one live camera track`, liveAfterTriple === 1, String(liveAfterTriple));
  f = await H.waitFlowing([pa, pc], [1, 1], 10000, 'videoFlowing');
  check(`${mode}: video still flows after the triple flip`, f.ok, H.fmtV(f.last));
  await pb.click('.m-voice-room #vc-camera');
  await sleep(1500);
  check(`${mode}: camera off: no live camera track`, (await liveCams(pb)) === 0, String(await liveCams(pb)));
  f = await H.waitFlowing([pa, pc], [0, 0], 8000, 'videoFlowing');
  check(`${mode}: no video at the desktops after camera off`, f.ok, H.fmtV(f.last));

  section(`${mode} g. rotation`);
  await pb.setViewportSize({ width: 844, height: 390 });
  await sleep(800);
  const land = await pb.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: innerWidth, leave: !!document.querySelector('.m-voice-room #vc-leave'), lr: document.querySelector('.m-voice-room #vc-leave')?.getBoundingClientRect().bottom, h: innerHeight }));
  check(`${mode}: landscape: call screen intact, Leave visible`, land.leave && land.sw <= land.w && land.lr <= land.h, JSON.stringify(land));
  await stillInCall(`${mode} landscape`);
  await pb.setViewportSize({ width: 390, height: 844 });
  await sleep(500);

  section(`${mode} h. opening another voice room during the call`);
  await mback(pb);
  await sleep(500);
  await mnav(pb, 'voice', { kind: 'channel', serverId: server.id, channelId: L2 });
  await sleep(1500);
  const other = await pb.evaluate(() => ({ join: !!document.querySelector('.m-voice-room #vc-join'), text: document.querySelector('#m-voice-body')?.innerText.slice(0, 120) }));
  H.note(`${mode}: second room screen`, JSON.stringify(other));
  await stillInCall(`${mode} other room screen open`);
  if (other.join) {
    await pb.click('.m-voice-room #vc-join');
    const moved = await waitFor(async () => (await H.lastState(pa, L2))?.participants.some((u) => u.id === bob.user.id), 10000);
    check(`${mode}: joining the second room moves the phone there`, !!moved);
    const gone = await waitFor(async () => !(await H.lastState(pa, L))?.participants.some((u) => u.id === bob.user.id), 5000);
    check(`${mode}: phone left the first room`, !!gone);
    f = await H.waitFlowing([pa, pc], [1, 1], 10000);
    check(`${mode}: alice/carol still talk in Lounge`, f.ok, H.fmt(f.last));
    await pb.click('.m-voice-room #vc-leave');
    await sleep(800);
    await mback(pb);
    await mnav(pb, 'voice', { kind: 'channel', serverId: server.id, channelId: L });
    await pb.waitForSelector('.m-voice-room #vc-join', { timeout: 8000 });
    await pb.click('.m-voice-room #vc-join');
    await pb.waitForSelector('.m-voice-room #vc-leave', { timeout: 15000 });
  } else {
    await mback(pb);
    await sleep(500);
    check(`${mode}: back from the other room keeps the call bar`, ((await callBarText(pb)) || '').includes('Lounge'), String(await callBarText(pb)));
    await stillInCall(`${mode} after the other room`);
    await pb.click('#m-callbar-open');
    await pb.waitForSelector('.m-voice-room #vc-leave', { timeout: 5000 });
  }
  f = await H.waitFlowing(all, [2, 2, 2], 15000);
  check(`${mode}: back in Lounge, 3-way audio`, f.ok, H.fmt(f.last));

  section(`${mode} i. leave from the call bar, rejoin`);
  await mback(pb);
  await sleep(500);
  await pb.click('#m-callbar-leave');
  check(`${mode}: call bar gone after leave`, !!(await waitFor(async () => (await callBarText(pb)) === null, 4000)));
  f = await H.waitFlowing(all, [1, 0, 1], 10000);
  check(`${mode}: phone out (alice/carol only each other)`, f.ok, H.fmt(f.last));
  check(`${mode}: phone peer connections closed, no leftover audio`, (await H.livePcIds(pb)).length === 0 && (await H.allAudioEls(pb)) === 0, `${JSON.stringify(await H.livePcIds(pb))} audio ${await H.allAudioEls(pb)}`);
  if (mode === 'sfu') { const st = await alice.sfuStatus(); check('sfu: server down to 2 peers', st.transports === 4 && st.producers === 2, JSON.stringify({ t: st.transports, p: st.producers })); }
  await mnav(pb, 'voice', { kind: 'channel', serverId: server.id, channelId: L });
  await pb.waitForSelector('.m-voice-room #vc-join', { timeout: 8000 });
  await pb.click('.m-voice-room #vc-join');
  await pb.waitForSelector('.m-voice-room #vc-leave', { timeout: 15000 });
  f = await H.waitFlowing(all, [2, 2, 2], 15000);
  check(`${mode}: rejoin works`, f.ok, H.fmt(f.last));
  await pb.click('.m-voice-room #vc-leave');
  await sleep(500);
  await mback(pb);

  section(`${mode} j. DM call phone <-> alice`);
  await H.leaveVoice(pa);
  await sleep(800);
  await mnav(pb, 'voice', { kind: 'dm', dmId: dm });
  await pb.waitForSelector('.m-voice-room #vc-join', { timeout: 8000 });
  await pb.click('.m-voice-room #vc-join');
  await pb.waitForSelector('.m-voice-room #vc-leave', { timeout: 15000 });
  await H.joinDm(pa, dm);
  f = await H.waitFlowing([pa, pb], [1, 1], 15000);
  check(`${mode}: DM call audio both ways`, f.ok, H.fmt(f.last));
  await mback(pb);
  await sleep(600);
  check(`${mode}: DM call bar shown after back`, !!(await callBarText(pb)), String(await callBarText(pb)));
  f = await H.waitFlowing([pa, pb], [1, 1], 8000);
  check(`${mode}: DM audio keeps flowing on the list`, f.ok, H.fmt(f.last));
  await H.leaveVoice(pa);
  await sleep(1500);
  const cbAfter = await callBarText(pb);
  H.note(`${mode}: phone call bar after alice left the DM call:`, String(cbAfter));
  await pb.click('#m-callbar-leave').catch(() => {});
  await sleep(1000);
  check(`${mode}: phone DM call ends cleanly`, (await H.livePcIds(pb)).length === 0 && (await callBarText(pb)) === null);
  if (mode === 'sfu') { const st = await alice.sfuStatus(); check('sfu: DM room gone from the SFU', st.rooms <= 1, JSON.stringify(st)); }

  section(`${mode} k. server ends the phone's call (moved to another device, access lost)`);
  await H.joinVoice(pa, server.id, L);
  await mnav(pb, 'voice', { kind: 'channel', serverId: server.id, channelId: L });
  await pb.waitForSelector('.m-voice-room #vc-join', { timeout: 8000 });
  await pb.click('.m-voice-room #vc-join');
  await pb.waitForSelector('.m-voice-room #vc-leave', { timeout: 15000 });
  await mback(pb);
  await sleep(800);
  const pd = await H.openPage('bob-desktop');
  await H.loginPage(pd, srv, bob);
  await H.joinVoice(pd, server.id, L);
  f = await H.waitFlowing([pa, pd], [2, 2], 15000); // carol is still in Lounge
  check(`${mode}: bob's desktop took over the call`, f.ok, H.fmt(f.last));
  const movedToast = await waitFor(async () => (await H.toasts(pb)).some((x) => /another|moved/i.test(x)), 5000);
  check(`${mode}: phone told the call moved`, !!movedToast, JSON.stringify((await H.toasts(pb)).slice(-3)));
  check(`${mode}: phone call bar gone, its connections closed`, !!(await waitFor(async () => (await callBarText(pb)) === null && (await H.livePcIds(pb)).length === 0, 5000)), `${await callBarText(pb)} ${JSON.stringify(await H.livePcIds(pb))}`);
  check(`${mode}: no leftover <audio> on the phone`, (await H.allAudioEls(pb)) === 0, String(await H.allAudioEls(pb)));
  // the phone takes it back from the voice screen
  await mnav(pb, 'voice', { kind: 'channel', serverId: server.id, channelId: L });
  await pb.waitForSelector('.m-voice-room #vc-join', { timeout: 8000 });
  await pb.click('.m-voice-room #vc-join');
  await pb.waitForSelector('.m-voice-room #vc-leave', { timeout: 15000 });
  f = await H.waitFlowing([pa, pb], [2, 2], 15000);
  check(`${mode}: phone takes the call back`, f.ok, H.fmt(f.last));
  check(`${mode}: desktop tab ended its call`, !!(await waitFor(async () => !(await H.inCall(pd)), 5000)));
  await pd.context().browser().close().catch(() => {});
  // access lost while the phone sits on the call screen (visible session)
  const everyone = (await alice.get(`/api/servers/${server.id}`)).roles.find((r) => r.is_default || r.isDefault || r.name === '@everyone');
  await alice.put(`/api/servers/${server.id}/channels/${L}/overrides/${everyone.id}`, { allow: 0, deny: 1 });
  const denied = true;
  if (denied) {
    const gone = await waitFor(async () => !(await H.lastState(pa, L))?.participants.some((u) => u.id === bob.user.id), 8000);
    check(`${mode}: phone removed after losing access`, !!gone);
    await sleep(800);
    const ui = await pb.evaluate(() => ({ leave: !!document.querySelector('.m-voice-room #vc-leave'), pcs: window.__pcs.filter((p) => p.connectionState !== 'closed').length, toasts: window.__toasts.slice(-2) }));
    check(`${mode}: phone call screen shows it is out (no Leave, no connections)`, !ui.leave && ui.pcs === 0, JSON.stringify(ui));
    await mback(pb);
    await sleep(600);
    check(`${mode}: no call bar afterwards`, (await callBarText(pb)) === null, String(await callBarText(pb)));
  } else H.note('could not find the channel override route; skipped access-lost');
  await H.leaveVoice(pa).catch(() => {});

  H.checkNoPageErrors(all, `${mode}: no page errors`);
  for (const p of all) await p.context().browser().close().catch(() => {});
  await H.stopServer(srv);
  check(`${mode}: server log has no exceptions`, srv.problems.length === 0, srv.problems.slice(0, 3).join(' | '));
}

H.run('mobile', async () => {
  await flows('sfu', 8074, 46740);
  await flows('mesh', 8075, 46750);
});
