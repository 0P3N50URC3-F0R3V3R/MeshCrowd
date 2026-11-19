// Scenario 9: navigating while in an SFU call: text channel, forum thread, DM, settings, member list,
// sending a message, the call bar, leaving from the call bar, back navigation leaving the app, and
// going invisible from the user bar. Audio must keep flowing and transports stay the same.
import * as H from './lib.mjs';
const { check, section, sleep, waitFor } = H;

H.run('nav', async () => {
  const srv = await H.startServer({ port: 8078, sfuPort: 46080 });
  const { apis, server, ch, general } = await H.world(srv, { users: ['alice', 'bob', 'carol'], voice: ['Lounge'] });
  const { alice, bob, carol } = apis;
  const L = ch.Lounge.id;
  const forum = (await alice.post(`/api/servers/${server.id}/channels`, { name: 'ideas', type: 'forum' })).channel;
  const thread = await alice.post(`/api/servers/${server.id}/channels/${forum.id}/threads`, { title: 'Post', content: 'hello forum' });
  const threadId = thread.thread?.id ?? thread.id;
  const dmAB = (await alice.post('/api/dms', { userId: bob.user.id })).dmId;
  const pa = await H.openPage('alice'), pb = await H.openPage('bob'), pc = await H.openPage('carol');
  const all = [pa, pb, pc];
  await Promise.all([[pa, alice], [pb, bob], [pc, carol]].map(([p, a]) => H.loginPage(p, srv, a)));
  for (const p of all) await H.joinVoice(p, server.id, L);
  let f = await H.waitFlowing(all, [2, 2, 2], 15000);
  check('baseline: 3-way audio', f.ok, H.fmt(f.last));
  const pcs0 = await H.livePcIds(pa);
  const joins0 = await H.sentCount(pa, 'voice_join');
  const callBar = () => pa.evaluate(() => { const c = document.querySelector('#cb-leave')?.closest('[hidden]') ? null : document.querySelector('.call-bar-name')?.textContent; return c || null; });

  async function stillInCall(label) {
    const m = await H.measure(all);
    check(`${label}: audio flows 3-way`, m.every((x) => x.flowing === 2), H.fmt(m));
    check(`${label}: same transports, no rejoin`, JSON.stringify(await H.livePcIds(pa)) === JSON.stringify(pcs0) && (await H.sentCount(pa, 'voice_join')) === joins0);
    check(`${label}: call bar shows Lounge`, (await callBar()) === 'Lounge', String(await callBar()));
  }

  section('9a. text channel + sending a message');
  await H.openChannel(pa, server.id, general.id);
  await pa.waitForSelector('#voice-panel', { state: 'detached' }).catch(() => {});
  const composer = await waitFor(() => pa.$('[contenteditable="true"], textarea'), 5000);
  if (composer) { await composer.click(); await pa.keyboard.type('hi from the call'); await pa.keyboard.press('Enter'); }
  const posted = await waitFor(async () => (await alice.get(`/api/servers/${server.id}/channels/${general.id}/messages`)).messages?.some((m) => m.content === 'hi from the call'), 5000);
  check('a message can be sent from the text channel while in the call', !!posted);
  await stillInCall('text channel');

  section('9b. forum thread');
  await H.navigate(pa, { type: 'server', serverId: server.id, channelId: forum.id, threadId });
  await sleep(1200);
  check('forum thread view shows the post', (await pa.evaluate(() => document.body.innerText)).includes('hello forum'));
  await stillInCall('forum thread');

  section('9c. DM view, settings, member list');
  await H.navigate(pa, { type: 'dm', dmId: dmAB });
  await sleep(800);
  check('DM view open, its own call panel not joined', !(await pa.$('#dm-voice-panel #vc-leave')));
  await stillInCall('DM view');
  await pa.click('#ub-settings');
  await sleep(800);
  await pa.keyboard.press('Escape');
  await sleep(400);
  await stillInCall('settings opened and closed');
  await H.navigate(pa, { type: 'home' });
  await sleep(600);
  await H.navigate(pa, { type: 'friends' });
  await sleep(600);
  await stillInCall('home/friends');

  section('9d. back to the call via the call bar');
  await pa.click('#cb-return');
  await pa.waitForSelector('#voice-panel #vc-leave', { timeout: 5000 });
  const tiles = await pa.$$eval('#voice-panel .voice-tile', (els) => els.length);
  check('call bar returns to the voice view with 3 tiles and Leave', tiles === 3, String(tiles));
  await stillInCall('back in the voice view');
  // whiteboard toggled after re-attach still works
  await pa.click('#vc-whiteboard');
  check('whiteboard opens after re-attach', !!(await waitFor(() => pa.$('#voice-panel canvas'), 3000)));
  await pa.click('#vc-mute');
  f = await H.waitFlowing(all, [2, 1, 1], 8000);
  check('mute after re-attach works (others stop receiving alice)', f.ok, H.fmt(f.last));
  await H.openChannel(pa, server.id, general.id);
  await pa.click('#ub-mute');
  f = await H.waitFlowing(all, [2, 2, 2], 8000);
  check('unmute from the user bar while on a text channel reaches the call', f.ok, H.fmt(f.last));

  section('9e. leaving from the call bar on another view');
  await pa.click('#cb-leave');
  check('call bar disappears', !!(await waitFor(async () => (await callBar()) === null, 3000)));
  f = await H.waitFlowing(all, [0, 1, 1], 8000);
  check('alice is out: she receives nothing, bob and carol only each other', f.ok, H.fmt(f.last));
  check('alice\'s transports closed and no leftover audio', (await H.livePcIds(pa)).length === 0 && (await H.allAudioEls(pa)) === 0);
  const st = await alice.sfuStatus();
  check('server: 2 peers left', st.transports === 4 && st.producers === 2, JSON.stringify({ t: st.transports, p: st.producers }));
  await H.openVoice(pa, server.id, L);
  check('voice view shows Join again', !!(await pa.$('#vc-join')));
  await pa.click('#vc-join');
  await pa.waitForSelector('#vc-leave');
  f = await H.waitFlowing(all, [2, 2, 2], 15000);
  check('rejoin after leaving from the call bar works', f.ok, H.fmt(f.last));

  section('9f. browser back leaves the app');
  await pa.goto('about:blank');
  await pa.goBack();
  await sleep(500);
  const st2 = await waitFor(async () => { const s = await alice.sfuStatus(); return s.transports === 4 && s; }, 8000);
  check('navigating the tab away frees alice\'s peer on the server', !!st2, JSON.stringify(await alice.sfuStatus()));

  section('9g. going invisible from the user bar ends the call');
  await pb.click('#ub-avatar');
  const inv = await waitFor(async () => { const l = pb.getByText('Invisible', { exact: true }); return (await l.count()) ? l.first() : null; }, 3000);
  if (inv) {
    await inv.click();
    const left = await waitFor(async () => !(await H.inCall(pb)) || (await callBarOf(pb)) === null, 5000);
    check('bob going invisible leaves the call', !!left);
    const r = (await H.lastState(pc, L))?.participants.map((u) => u.id) || [];
    check('bob gone from carol\'s roster', !r.includes(bob.user.id), JSON.stringify(r));
  } else H.note('status picker not found from #ub-avatar; skipped 9g');
  H.checkNoPageErrors(all);
  await H.stopServer(srv);
  check('server log has no exceptions', srv.problems.length === 0, srv.problems.slice(0, 3).join(' | '));
});

function callBarOf(p) {
  return p.evaluate(() => (document.querySelector('#cb-leave') ? document.querySelector('.call-bar-name')?.textContent : null));
}
