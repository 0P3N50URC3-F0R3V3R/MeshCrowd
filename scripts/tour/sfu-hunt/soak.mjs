// Scenario 11: a 3-minute 3-way SFU call followed by 30 join/leave cycles (plus 10 navigate-away
// cycles): server process and worker memory, admin status counters, and client-side leaks (live
// AudioContexts, intervals, <audio> elements, bus listeners) before and after.
import * as H from './lib.mjs';
const { check, section, sleep, waitFor } = H;
const MINUTES = Number(process.env.SOAK_MINUTES || 3);
const CYCLES = Number(process.env.SOAK_CYCLES || 30);

const COUNTERS = `(() => {
  window.__ctx = new Set(); window.__iv = new Set();
  const AC = window.AudioContext;
  window.AudioContext = function (...a) { const c = new AC(...a); window.__ctx.add(c); return c; };
  window.AudioContext.prototype = AC.prototype;
  const si = window.setInterval, ci = window.clearInterval;
  window.setInterval = function (...a) { const id = si.apply(this, a); window.__iv.add(id); return id; };
  window.clearInterval = function (id) { window.__iv.delete(id); return ci.call(this, id); };
})();`;

H.run('soak', async () => {
  const srv = await H.startServer({ port: 8070, sfuPort: 46000 });
  const { apis, server, ch, general } = await H.world(srv, { users: ['alice', 'bob', 'carol'], voice: ['Lounge'] });
  const { alice, bob, carol } = apis;
  const L = ch.Lounge.id;
  const pa = await H.openPage('alice'), pb = await H.openPage('bob'), pc = await H.openPage('carol');
  for (const p of [pa, pb, pc]) await p.context().addInitScript(COUNTERS);
  const all = [pa, pb, pc];
  await Promise.all([[pa, alice], [pb, bob], [pc, carol]].map(([p, a]) => H.loginPage(p, srv, a)));
  const clientStats = (p) => p.evaluate(async () => {
    const { bus } = await import('/js/bus.js');
    let listeners = 0;
    // state:pins / state:threads listeners of the chat header remove themselves on the next event
    // after their button left the DOM, so they are not counted.
    for (const [k, s] of bus.listeners) if (k !== 'state:pins' && k !== 'state:threads') listeners += s.size;
    return {
      ctx: [...window.__ctx].filter((c) => c.state !== 'closed').length,
      intervals: window.__iv.size,
      audio: document.querySelectorAll('body > audio').length,
      listeners,
      voiceListeners: bus.listeners.get('ws:voice_state')?.size || 0,
      heapMb: Math.round((performance.memory?.usedJSHeapSize || 0) / 1048576),
    };
  });
  const counts = async () => { const s = await alice.sfuStatus(); return { rooms: s.rooms, t: s.transports, p: s.producers, c: s.consumers }; };
  const mem = () => {
    const w = H.childWorkerPids(srv.proc.pid);
    return { node: H.processMemoryMb(srv.proc.pid), worker: w.length ? H.processMemoryMb(w[0]) : null };
  };

  section(`11a. ${MINUTES}-minute 3-way call`);
  const bobIdle = await clientStats(pb);
  for (const p of all) await H.joinVoice(p, server.id, L);
  let f = await H.waitFlowing(all, [2, 2, 2], 15000);
  check('call up', f.ok, H.fmt(f.last));
  await sleep(10000);
  const mem0 = mem();
  const bob0 = await clientStats(pb);
  H.note('start: server', JSON.stringify(mem0), 'bob idle', JSON.stringify(bobIdle), 'bob in call', JSON.stringify(bob0));
  const end = Date.now() + MINUTES * 60_000;
  let samples = 0, bad = 0;
  while (Date.now() < end) {
    await sleep(25000);
    const m = await H.measure(all);
    samples++;
    const lossy = m.flatMap((x) => x.audio).filter((s) => s.p1 > 0 && s.lost / s.p1 > 0.02);
    if (!m.every((x) => x.flowing === 2) || lossy.length) bad++;
    console.log(`  t+${Math.round((Date.now() - (end - MINUTES * 60_000)) / 1000)}s ${H.fmt(m)} mem ${JSON.stringify(mem())}`);
  }
  check(`audio flowed 3-way at every sample with <2% loss (${samples} samples)`, bad === 0, `${bad} bad`);
  const mem1 = mem();
  check('server memory did not grow by more than 30 MB during the call', mem1.node - mem0.node < 30, `${mem0.node} -> ${mem1.node} MB`);
  check('worker memory stable (< 20 MB growth)', mem1.worker - mem0.worker < 20, `${mem0.worker} -> ${mem1.worker} MB`);

  section(`11b. ${CYCLES} join/leave cycles (bob) + 10 navigate-away cycles (carol)`);
  const before = await counts();
  for (let i = 0; i < CYCLES; i++) {
    await H.leaveVoice(pb);
    await H.joinVoice(pb, server.id, L);
    if (i % 3 === 0) { await H.openChannel(pc, server.id, general.id); await sleep(200); await H.openVoice(pc, server.id, L); }
  }
  f = await H.waitFlowing(all, [2, 2, 2], 15000);
  check('after the churn: 3-way audio', f.ok, H.fmt(f.last));
  const settled = await waitFor(async () => { const c = await counts(); return JSON.stringify(c) === JSON.stringify(before) && c; }, 10000, 300);
  check('admin status counters back to the pre-churn values', !!settled, `${JSON.stringify(before)} vs ${JSON.stringify(await counts())}`);
  const r = (await H.lastState(pa, L))?.participants.map((u) => u.id) || [];
  check('roster: 3 unique participants', r.length === 3 && new Set(r).size === 3, JSON.stringify(r));
  await sleep(5000);
  const bob1 = await clientStats(pb);
  const carol1 = await clientStats(pc);
  H.note('bob after churn', JSON.stringify(bob1), 'carol after', JSON.stringify(carol1));
  check('bob: no leaked AudioContexts', bob1.ctx <= bob0.ctx, `${bob0.ctx} -> ${bob1.ctx}`);
  check('bob: no leaked intervals', bob1.intervals <= bob0.intervals, `${bob0.intervals} -> ${bob1.intervals}`);
  check('bob: no leaked <audio> elements', bob1.audio === 2, String(bob1.audio));
  check('bob: bus listeners did not grow', bob1.listeners <= bob0.listeners, `${bob0.listeners} -> ${bob1.listeners}`);
  check('carol: one voice_state listener set (no stacked mounts)', carol1.voiceListeners <= bob0.voiceListeners, `${carol1.voiceListeners}`);
  const mem2 = mem();
  H.note('server memory after churn', JSON.stringify(mem2));
  check('server memory after churn within 40 MB of the start', mem2.node - mem0.node < 40, `${mem0.node} -> ${mem2.node} MB`);
  for (const p of all) await H.leaveVoice(p);
  await sleep(3000);
  const bobLeft = await clientStats(pb);
  H.note('bob after leaving', JSON.stringify(bobLeft));
  check('bob after leaving: no AudioContext, no <audio>, intervals back to idle', bobLeft.ctx === 0 && bobLeft.audio === 0 && bobLeft.intervals <= bobIdle.intervals + 1, `${JSON.stringify(bobIdle)} -> ${JSON.stringify(bobLeft)}`);
  const z = await waitFor(async () => { const c = await counts(); return c.rooms === 0 && c.t === 0 && c; }, 5000);
  check('SFU empty at the end', !!z);
  H.checkNoPageErrors(all);
  await H.stopServer(srv);
  check('server log has no exceptions', srv.problems.length === 0, srv.problems.slice(0, 3).join(' | '));
});
