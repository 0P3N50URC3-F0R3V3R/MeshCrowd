// Scenario 6: server-side events with live calls: voice.mode flips, a full server restart on the same
// data dir, a worker crash in a stage room with a screen share, and the SFU auto-restart when the
// announced public IP changes (turn.externalIp via the admin API), its debounce and the manual
// announcedHost opt-out.
import * as H from './lib.mjs';
const { check, section, sleep, waitFor } = H;

H.run('server-events', async () => {
  const opts = { port: 8075, sfuPort: 46050, announcedHost: '', extra: { turn: { autoIp: false, externalIp: '127.0.0.1' } } };
  let srv = await H.startServer(opts);
  const { apis, server, ch } = await H.world(srv, { users: ['alice', 'bob', 'carol'], voice: ['Lounge', 'Two'], stage: ['Stage'] });
  const { alice, bob, carol } = apis;
  const L = ch.Lounge.id, T = ch.Two.id, S = ch.Stage.id;
  const ids = { alice: alice.user.id, bob: bob.user.id, carol: carol.user.id };
  const pa = await H.openPage('alice'), pb = await H.openPage('bob'), pc = await H.openPage('carol');
  const all = [pa, pb, pc];
  await Promise.all([[pa, alice], [pb, bob], [pc, carol]].map(([p, a]) => H.loginPage(p, srv, a)));
  const counts = async () => { const s = await alice.sfuStatus(); return { rooms: s.rooms, t: s.transports, p: s.producers, c: s.consumers }; };
  const mode = (p, id) => H.lastState(p, id).then((s) => s?.mode);
  let f;

  section('6a. voice.mode flips with live rooms');
  await H.joinVoice(pa, server.id, L);
  await H.joinVoice(pb, server.id, L);
  f = await H.waitFlowing([pa, pb], [1, 1], 15000);
  check('Lounge (sfu) audio flows', f.ok && (await mode(pa, L)) === 'sfu', H.fmt(f.last));
  await alice.patch('/api/admin/calls', { voice: { mode: 'mesh' } });
  f = await H.measure([pa, pb]);
  check('flip to mesh: the live SFU room keeps flowing', f.every((x) => x.flowing === 1), H.fmt(f));
  await H.joinVoice(pc, server.id, L);
  f = await H.waitFlowing(all, [2, 2, 2], 15000);
  check('a new joiner of the live room still gets SFU (mode fixed per room)', f.ok && (await mode(pc, L)) === 'sfu' && (await H.livePcIds(pc)).length === 2, H.fmt(f.last));
  await H.joinVoice(pc, server.id, T);
  check('a new room created now is mesh', (await waitFor(async () => (await mode(pc, T)) === 'mesh', 5000)) === true);
  await alice.patch('/api/admin/calls', { voice: { mode: 'sfu' } });
  await H.joinVoice(pb, server.id, T);
  f = await H.waitFlowing([pb, pc], [1, 1], 15000);
  check('flip back to sfu: the live mesh room stays mesh and works', f.ok && (await mode(pb, T)) === 'mesh' && (await H.livePcIds(pb)).length === 1, H.fmt(f.last));
  await H.leaveVoice(pb); await H.leaveVoice(pc);
  await H.joinVoice(pb, server.id, L); await H.joinVoice(pc, server.id, L);
  f = await H.waitFlowing(all, [2, 2, 2], 15000);
  check('everyone back in Lounge (sfu): 3-way audio', f.ok, H.fmt(f.last));
  H.checkNoPageErrors(all);

  section('6b. server restart (same data dir) with a live call');
  {
    await H.stopServer(srv, { keepData: true });
    await sleep(2000);
    const tDown = Date.now();
    srv = await H.startServer({ ...opts, data: srv.data });
    f = await H.waitFlowing(all, [2, 2, 2], 40000);
    check('after the restart every client rejoined and audio flows 3-way', f.ok, `${H.fmt(f.last)} ${Date.now() - tDown} ms after the new server came up`);
    const modes = await Promise.all(all.map((p) => mode(p, L)));
    check('the room comes back in SFU mode (voice.mode is sfu)', modes.every((m) => m === 'sfu'), JSON.stringify(modes));
    const st = await waitFor(async () => { const c = await counts(); return c.rooms === 1 && c.t === 6 && c; }, 10000);
    check('the new server has one room with 3 peers', !!st, JSON.stringify(await counts()));
    const r = (await H.lastState(pa, L))?.participants.map((u) => u.id) || [];
    check('roster has 3 unique participants', r.length === 3 && new Set(r).size === 3, JSON.stringify(r));
    check('all three still show Leave', (await Promise.all(all.map(H.inCall))).every(Boolean));
    H.note('toasts after restart', JSON.stringify(await Promise.all(all.map(H.toasts))));
    H.checkNoPageErrors(all, 'no page errors across the restart');
  }

  section('6c. worker crash in a stage room with a screen share');
  {
    for (const p of all) await H.joinVoice(p, server.id, S);
    await pa.click('#vc-screenshare');
    await pa.click(`[data-invite-speaker]`).catch(() => {});
    const shareSeen = () => pb.evaluate((u) => [...document.querySelectorAll('#voice-panel video[data-stream-key]')].some((v) => v.dataset.streamKey === `${u}:screen` && v.videoWidth > 0), ids.alice);
    check('bob (audience) sees alice\'s screen', !!(await waitFor(shareSeen, 15000)));
    f = await H.waitFlowing(all, [0, 1, 1], 10000);
    check('stage audio: audience hears alice', f.ok, H.fmt(f.last));
    const workers = H.childWorkerPids(srv.proc.pid);
    for (const pid of workers) process.kill(pid);
    const t0 = Date.now();
    f = await H.waitFlowing(all, [0, 1, 1], 20000);
    check('after the worker crash stage audio is back', f.ok, `${H.fmt(f.last)} ${Date.now() - t0} ms`);
    check('the screen share is back for bob', !!(await waitFor(shareSeen, 15000)));
    const ss = await pa.evaluate((id) => window.__frames.filter((x) => x.type === 'stage_state' && x.channelId === id).at(-1), S);
    check('alice is still the only speaker', ss?.speakers?.length === 1 && ss.speakers[0] === ids.alice, JSON.stringify(ss));
    check('alice still shows the screen share as active', !!(await pa.$('#vc-screenshare.active')));
    for (const p of all) await H.leaveVoice(p);
    H.checkNoPageErrors(all);
  }

  section('6d. auto-restart on announced IP change');
  {
    for (const p of all) await H.joinVoice(p, server.id, L);
    f = await H.waitFlowing(all, [2, 2, 2], 15000);
    check('3-way call before the IP change', f.ok, H.fmt(f.last));
    const cand = (p) => p.evaluate(() => window.__pcs.filter((x) => x.connectionState === 'connected').map((x) => x.remoteDescription?.sdp.match(/a=candidate:\S+ \d+ \w+ \d+ (\S+)/)?.[1]).join(','));
    check('running pool announces 127.0.0.1', (await cand(pa)).split(',').every((x) => x === '127.0.0.1'), await cand(pa));
    const workers0 = H.childWorkerPids(srv.proc.pid);
    const t0 = Date.now();
    await alice.patch('/api/admin/calls', { turn: { externalIp: '127.0.0.2' } });
    f = await H.waitFlowing(all, [2, 2, 2], 20000);
    check('after the IP change audio flows again within 20 s', f.ok && Date.now() - t0 <= 20000, `${H.fmt(f.last)} ${Date.now() - t0} ms`);
    const st1 = (await alice.calls()).voice.status;
    check('lastAutoRestart recorded 127.0.0.1 -> 127.0.0.2 ok', st1.lastAutoRestart?.from === '127.0.0.1' && st1.lastAutoRestart?.to === '127.0.0.2' && st1.lastAutoRestart?.ok === true, JSON.stringify(st1.lastAutoRestart));
    const workers1 = H.childWorkerPids(srv.proc.pid);
    check('exactly one restart (new worker pid, one restart log line)', workers1.length === 1 && !workers0.includes(workers1[0]) && (H.serverLog(srv).match(/restarting the SFU/g) || []).length === 1, `${workers0} -> ${workers1}`);
    const cands = await pa.evaluate(() => window.__pcs.filter((p) => p.connectionState === 'connected').map((p) => p.remoteDescription?.sdp.match(/a=candidate:.*/g)?.join(' | ')).join(' || '));
    check('client transports use the new address', /127\.0\.0\.2/.test(cands) && !/ 127\.0\.0\.1 /.test(cands), cands.slice(0, 200));
    const r = (await H.lastState(pa, L))?.participants.map((u) => u.id) || [];
    check('roster: 3 unique after the restart', r.length === 3 && new Set(r).size === 3, JSON.stringify(r));

    // a second change inside the 30 s window is deferred, not dropped
    await alice.patch('/api/admin/calls', { turn: { externalIp: '127.0.0.3' } });
    await sleep(3000);
    const st2 = (await alice.calls()).voice.status;
    check('second change within 30 s: no immediate restart', st2.lastAutoRestart?.to === '127.0.0.2' && (H.serverLog(srv).match(/restarting the SFU/g) || []).length === 1, JSON.stringify(st2.lastAutoRestart));
    const deferred = await waitFor(async () => { const s = (await alice.calls()).voice.status; return s.lastAutoRestart?.to === '127.0.0.3' && s.lastAutoRestart.ok && s; }, 40000, 1000);
    check('the trailing restart applies 127.0.0.3 after the window', !!deferred, JSON.stringify(deferred?.lastAutoRestart));
    check('...about 30 s after the first restart', deferred && Date.parse(deferred.lastAutoRestart.at) - Date.parse(st1.lastAutoRestart.at) >= 29000, deferred && `${Date.parse(deferred.lastAutoRestart.at) - Date.parse(st1.lastAutoRestart.at)} ms`);
    f = await H.waitFlowing(all, [2, 2, 2], 20000);
    check('audio flows after the deferred restart', f.ok, H.fmt(f.last));
    check('two restarts in total', (H.serverLog(srv).match(/restarting the SFU/g) || []).length === 2);

    // manual announcedHost: no auto-restart
    await alice.patch('/api/admin/calls', { voice: { sfu: { announcedHost: '127.0.0.1' } } });
    const restartsBefore = (H.serverLog(srv).match(/restarting the SFU/g) || []).length;
    await sleep(31000);
    await alice.patch('/api/admin/calls', { turn: { externalIp: '127.0.0.4' } });
    await sleep(5000);
    const st3 = (await alice.calls()).voice.status;
    check('with a manual announcedHost an IP change does not restart', (H.serverLog(srv).match(/restarting the SFU/g) || []).length === restartsBefore && st3.lastAutoRestart?.to === '127.0.0.3', JSON.stringify(st3.lastAutoRestart));
    f = await H.measure(all);
    check('call unaffected', f.every((x) => x.flowing === 2), H.fmt(f));
    const calls = await alice.calls();
    H.note('admin voice payload', JSON.stringify({ restartRequired: calls.voice.restartRequired, warnings: calls.voice.warnings, announced: calls.voice.announced }).slice(0, 400));
    for (const p of all) await H.leaveVoice(p);
    H.checkNoPageErrors(all);
  }
  await H.stopServer(srv);
  check('server log has no exceptions', srv.problems.length === 0, srv.problems.slice(0, 3).join(' | '));
});
