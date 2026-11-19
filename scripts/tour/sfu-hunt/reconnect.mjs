// Scenario 5: reconnect behaviour: WS killed mid-call, browser offline, two tabs of one account,
// logout mid-call, page reload mid-call. Server must free old peers, no ghosts.
import * as H from './lib.mjs';
const { check, section, sleep, waitFor } = H;

H.run('reconnect', async () => {
  const srv = await H.startServer({ port: 8074, sfuPort: 46040 });
  const { apis, server, ch } = await H.world(srv, { users: ['alice', 'bob', 'carol'], voice: ['Lounge'] });
  const { alice, bob, carol } = apis;
  const L = ch.Lounge.id;
  const ids = { alice: alice.user.id, bob: bob.user.id, carol: carol.user.id };
  const pa = await H.openPage('alice'), pb = await H.openPage('bob'), pc = await H.openPage('carol');
  const all = [pa, pb, pc];
  await Promise.all([[pa, alice], [pb, bob], [pc, carol]].map(([p, a]) => H.loginPage(p, srv, a)));
  for (const p of all) await H.joinVoice(p, server.id, L);
  let f = await H.waitFlowing(all, [2, 2, 2], 15000);
  check('baseline: 3-way audio', f.ok, H.fmt(f.last));
  const admin = await new H.Api(srv.base).login('alice'); // own session, survives alice's logout
  const counts = async () => { const s = await admin.sfuStatus(); return { rooms: s.rooms, t: s.transports, p: s.producers, c: s.consumers }; };
  const expect3 = { rooms: 1, t: 6, p: 3, c: 6 };
  const rosterIds = async (p) => (await H.lastState(p, L))?.participants.map((u) => u.id) || [];
  const settled = async (want, ms = 10000) => waitFor(async () => { const c = await counts(); return JSON.stringify(c) === JSON.stringify(want) && c; }, ms, 300);

  section('5a. alice\'s WebSocket is killed mid-call');
  {
    const joins0 = await H.sentCount(pa, 'voice_join');
    const t0 = Date.now();
    await pa.evaluate(() => window.__sockets.filter((s) => s.readyState === 1).forEach((s) => s.close()));
    f = await H.waitFlowing(all, [2, 2, 2], 20000);
    check('audio flows 3-way again after the WS reconnect', f.ok, `${H.fmt(f.last)} after ${Date.now() - t0} ms`);
    check('alice rejoined exactly once', (await H.sentCount(pa, 'voice_join')) === joins0 + 1, `${joins0} -> ${await H.sentCount(pa, 'voice_join')}`);
    const r = await rosterIds(pb);
    check('roster has 3 unique participants', r.length === 3 && new Set(r).size === 3, JSON.stringify(r));
    check('server counts back to 3 peers (no ghost transports)', !!(await settled(expect3)), JSON.stringify(await counts()));
    check('alice still shows the Leave button', await H.inCall(pa));
    check('alice has 2 remote audio elements (no duplicates)', (await H.allAudioEls(pa)) === 2, String(await H.allAudioEls(pa)));
  }

  section('5b. bob\'s browser goes offline for 4 s');
  {
    await pb.context().setOffline(true);
    await sleep(4000);
    await pb.context().setOffline(false);
    f = await H.waitFlowing(all, [2, 2, 2], 25000);
    check('after offline/online, 3-way audio again', f.ok, H.fmt(f.last));
    check('server counts back to 3 peers', !!(await settled(expect3)), JSON.stringify(await counts()));
    check('bob has 2 remote audio elements', (await H.allAudioEls(pb)) === 2, String(await H.allAudioEls(pb)));
  }

  section('5c. two tabs of carol: A in the call, B joins the same room');
  {
    const pc2 = await pc.context().newPage();
    pc2.__name = 'carol-B'; pc2.__errors = [];
    pc2.on('pageerror', (e) => pc2.__errors.push(`pageerror: ${e.message}`));
    pc2.on('console', (m) => { if (m.type() === 'error' && !/favicon|40[134]/.test(m.text())) pc2.__errors.push(`console.error: ${m.text()}`); });
    await pc2.goto(srv.base + '/');
    await pc2.waitForSelector('[data-server]');
    await H.openVoice(pc2, server.id, L);
    check('tab B (not joined) shows the join button', !!(await pc2.$('#vc-join')));
    const aJoins0 = await H.sentCount(pc, 'voice_join');
    // tab A sits on a text channel (call detached from the view) when B takes the call over
    const generalId = (await carol.get(`/api/servers/${server.id}`)).channels.find((c) => c.type === 'public').id;
    await H.openChannel(pc, server.id, generalId);
    const deniedListeners = () => pc.evaluate(() => import('/js/bus.js').then(({ bus }) => bus.listeners.get('ws:voice_join_denied')?.size || 0));
    const dl0 = await deniedListeners();
    await pc2.click('#vc-join');
    await pc2.waitForSelector('#vc-leave');
    f = await H.waitFlowing([pa, pb, pc2], [2, 2, 2], 20000);
    check('tab B joins the same room: audio flows with B', f.ok, H.fmt(f.last));
    check('server: still 3 peers (tab A\'s peer replaced)', !!(await settled(expect3)), JSON.stringify(await counts()));
    // watch for a tug of war between the tabs (A's dead transports retrying)
    await sleep(35000);
    const aJoins1 = await H.sentCount(pc, 'voice_join');
    const bJoins = await H.sentCount(pc2, 'voice_join');
    H.note(`after 35 s: tab A voice_join ${aJoins0}->${aJoins1}, tab B ${bJoins}; A shows leave=${await H.inCall(pc)}, A toasts ${JSON.stringify(await H.toasts(pc))}`);
    f = await H.measure([pa, pb, pc2]);
    check('tab A was told its call moved (toast)', (await H.toasts(pc)).includes(H.en.voice.callMovedToast), JSON.stringify(await H.toasts(pc)));
    check('35 s later B still has the call (no tug of war with tab A)', f.every((x) => x.flowing === 2) && (await counts()).t === 6, `${H.fmt(f)} ${JSON.stringify(await counts())}`);
    check('tab A does not take the call back by itself', aJoins1 === aJoins0, `${aJoins0} -> ${aJoins1}`);
    check('tab A no longer pretends to be in the call', !(await H.inCall(pc)) && !(await pc.$('#cb-leave')), `A leave button=${await H.inCall(pc)}`);
    const dl1 = await deniedListeners();
    check("tab A's detached call mount was destroyed (its bus listeners removed)", dl1 === dl0 - 1, `${dl0} -> ${dl1}`);
    await pc.close();
    await sleep(1500);
    f = await H.measure([pa, pb, pc2]);
    check('closing tab A leaves B\'s call alone', f.every((x) => x.flowing === 2) && (await rosterIds(pa)).includes(ids.carol), H.fmt(f));
    await pc2.close();
    check('closing tab B ends carol\'s call: 2 peers left', !!(await settled({ rooms: 1, t: 4, p: 2, c: 2 })), JSON.stringify(await counts()));
    check('carol gone from the roster', !!(await waitFor(async () => !(await rosterIds(pa)).includes(ids.carol), 5000)));
    H.checkNoPageErrors([pc2], 'tab B: no page errors');
  }

  section('5d. page reload mid-call (bob)');
  {
    await pb.reload();
    await pb.waitForSelector('[data-server]');
    check('reload: the server frees bob\'s peer (1 peer left)', !!(await settled({ rooms: 1, t: 2, p: 1, c: 0 })), JSON.stringify(await counts()));
    check('bob is gone from alice\'s roster', !!(await waitFor(async () => !(await rosterIds(pa)).includes(ids.bob), 5000)));
    check('alice has no remote audio left', (await H.allAudioEls(pa)) === 0, String(await H.allAudioEls(pa)));
    await H.joinVoice(pb, server.id, L);
    f = await H.waitFlowing([pa, pb], [1, 1], 15000);
    check('bob rejoins after reload: audio both ways', f.ok, H.fmt(f.last));
  }

  section('5e. logout mid-call (alice)');
  {
    await pa.evaluate(async () => { const { api } = await import('/js/api.js'); await api.logout(); location.reload(); });
    await pa.waitForSelector('.auth-screen', { timeout: 15000 });
    check('logout: alice\'s peer freed (bob alone)', !!(await settled({ rooms: 1, t: 2, p: 1, c: 0 })), JSON.stringify(await counts()));
    check('bob\'s roster has only bob', !!(await waitFor(async () => JSON.stringify(await rosterIds(pb)) === JSON.stringify([ids.bob]), 5000)));
    await alice.login('alice');
    await H.loginPage(pa, srv, alice);
    await H.joinVoice(pa, server.id, L);
    f = await H.waitFlowing([pa, pb], [1, 1], 15000);
    check('alice logs back in and rejoins: audio both ways', f.ok, H.fmt(f.last));
  }
  for (const p of [pa, pb]) await H.leaveVoice(p);
  check('SFU empty at the end', !!(await settled({ rooms: 0, t: 0, p: 0, c: 0 })), JSON.stringify(await counts()));
  H.checkNoPageErrors([pa, pb]);
  await H.stopServer(srv);
  check('server log has no exceptions', srv.problems.length === 0, srv.problems.slice(0, 3).join(' | '));
});
