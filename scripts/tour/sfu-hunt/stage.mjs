// Scenario 2: stage channel in SFU mode: speakers/audience, raise hand, invite, move to audience,
// step down, server-enforced audience silence, moderator force-mute interplay.
import * as H from './lib.mjs';
const { check, section, sleep, waitFor } = H;

H.run('stage', async () => {
  const srv = await H.startServer({ port: 8071, sfuPort: 46010 });
  const { apis, server, ch } = await H.world(srv, { users: ['alice', 'bob', 'carol'], stage: ['Stage'] });
  const { alice, bob, carol } = apis;
  const stageId = ch.Stage.id;
  const ids = { alice: alice.user.id, bob: bob.user.id, carol: carol.user.id };
  const pa = await H.openPage('alice'), pb = await H.openPage('bob'), pc = await H.openPage('carol');
  const all = [pa, pb, pc];
  await Promise.all([[pa, alice], [pb, bob], [pc, carol]].map(([p, a]) => H.loginPage(p, srv, a)));
  const stageState = (p) => p.evaluate((id) => window.__frames.filter((f) => f.type === 'stage_state' && f.channelId === id).at(-1) || null, stageId);
  const produceErrors = (p) => p.evaluate(() => window.__sent.filter((m) => m.type === 'sfu_request' && m.op === 'produce' && m.data?.media === 'audio')
    .map((m) => window.__responses[m.id]).filter(Boolean).map((r) => (r.ok ? 'ok' : r.error)));

  section('2a. join: moderator speaker, two audience members');
  for (const p of all) await H.joinVoice(p, server.id, stageId);
  const st = await waitFor(async () => { const s = await stageState(pa); return s?.speakers?.length === 1 && s; }, 5000);
  check('alice (manage channel) is the only speaker', st && st.speakers[0] === ids.alice, JSON.stringify(st));
  let f = await H.waitFlowing(all, [0, 1, 1], 15000);
  check('audience hears alice; alice hears no audience', f.ok, H.fmt(f.last));
  const bobProduce = await produceErrors(pb);
  check('the server refused bob\'s audio producer while audience (muted)', bobProduce.includes('muted') && !bobProduce.includes('ok'), JSON.stringify(bobProduce));
  check('bob sees a raise-hand button, no mute button', !!(await pb.$('#vc-raise-hand')) && !(await pb.$('#vc-mute')));
  const statusA = await alice.sfuStatus();
  check('SFU has 1 producer (alice) and 2 consumers', statusA.producers === 1 && statusA.consumers === 2, JSON.stringify({ p: statusA.producers, c: statusA.consumers }));

  section('2b. raise hand, invite to speak');
  await pb.click('#vc-raise-hand');
  const raised = await waitFor(async () => (await stageState(pa))?.raisedHands?.includes(ids.bob), 5000);
  check('bob\'s raised hand reaches alice', !!raised);
  await pa.waitForSelector(`[data-invite-speaker="${ids.bob}"]`, { timeout: 5000 });
  const t0 = Date.now();
  await pa.click(`[data-invite-speaker="${ids.bob}"]`);
  f = await H.waitFlowing(all, [1, 1, 2], 10000);
  check('invited bob becomes audible to alice and carol without extra clicks', f.ok, `${H.fmt(f.last)} after ${Date.now() - t0} ms`);
  check('bob now has a mute button', !!(await pb.$('#vc-mute')));

  section('2c. move to audience and back');
  await pa.click(`[data-move-audience="${ids.bob}"]`);
  f = await H.waitFlowing(all, [0, 1, 1], 10000);
  check('moved to audience: bob is silent for everyone (server-paused)', f.ok, H.fmt(f.last));
  check('bob gets the raise-hand button back', !!(await waitFor(() => pb.$('#vc-raise-hand'), 3000)));
  // hand-made resume from the demoted client
  const pid = await pb.evaluate(() => {
    const req = window.__sent.filter((m) => m.type === 'sfu_request' && m.op === 'produce' && m.data?.media === 'audio').reverse().find((m) => window.__responses[m.id]?.ok);
    return req && window.__responses[req.id].data.producerId;
  });
  await H.wsSend(pb, { type: 'sfu_request', id: 'hunt-bypass', channelId: stageId, op: 'resume_producer', data: { producerId: pid } });
  const bypass = await waitFor(() => pb.evaluate(() => window.__responses['hunt-bypass']), 5000);
  check('audience resume_producer bypass is refused (muted)', bypass?.ok === false && bypass.error === 'muted', JSON.stringify(bypass));
  f = await H.measure(all);
  check('...and bob stays silent', f[0].flowing === 0 && f[2].flowing === 1, H.fmt(f));
  await H.wsSend(pa, { type: 'stage_invite_speaker', channelId: stageId, userId: ids.bob });
  f = await H.waitFlowing(all, [1, 1, 2], 10000);
  check('re-invited bob is audible again', f.ok, H.fmt(f.last));

  section('2d. moderator force-mute interplay');
  await H.wsSend(pa, { type: 'voice_force_mute', channelId: stageId, userId: ids.bob });
  f = await H.waitFlowing(all, [0, 1, 1], 10000);
  check('force-muted speaker bob is silent', f.ok, H.fmt(f.last));
  await H.wsSend(pa, { type: 'stage_move_to_audience', channelId: stageId, userId: ids.bob });
  await H.wsSend(pa, { type: 'stage_invite_speaker', channelId: stageId, userId: ids.bob });
  await sleep(1500);
  f = await H.measure(all);
  check('demote + re-invite does not lift the force-mute', f[0].flowing === 0 && f[2].flowing === 1, H.fmt(f));
  await H.wsSend(pa, { type: 'voice_force_unmute', channelId: stageId, userId: ids.bob });
  await pb.waitForSelector('#vc-mute:not([disabled])', { timeout: 5000 });
  const selfMuted = !!(await pb.$('#vc-mute.active-danger'));
  H.note('bob self-muted after force-unmute:', selfMuted, '(known: force-mute sets self-mute)');
  if (selfMuted) await pb.click('#vc-mute');
  f = await H.waitFlowing(all, [1, 1, 2], 10000);
  check('force-unmute (+ bob unmuting himself) brings him back', f.ok, H.fmt(f.last));
  await H.wsSend(pa, { type: 'voice_force_mute', channelId: stageId, userId: ids.bob });
  await H.wsSend(pa, { type: 'stage_move_to_audience', channelId: stageId, userId: ids.bob });
  await H.wsSend(pa, { type: 'voice_force_unmute', channelId: stageId, userId: ids.bob });
  await sleep(1500);
  f = await H.measure(all);
  check('force-unmute while in the audience keeps bob silent', f[0].flowing === 0 && f[2].flowing === 1, H.fmt(f));
  await H.wsSend(pa, { type: 'stage_invite_speaker', channelId: stageId, userId: ids.bob });
  await pb.waitForSelector('#vc-mute', { timeout: 5000 });
  if (await pb.$('#vc-mute.active-danger')) await pb.click('#vc-mute');
  f = await H.waitFlowing(all, [1, 1, 2], 10000);
  check('invited again (and self-unmuted): bob audible', f.ok, H.fmt(f.last));

  section('2e. step down, audience cannot promote itself');
  await pb.click('#vc-step-down');
  f = await H.waitFlowing(all, [0, 1, 1], 10000);
  check('bob steps down: silent again', f.ok, H.fmt(f.last));
  await H.wsSend(pc, { type: 'stage_invite_speaker', channelId: stageId, userId: ids.carol });
  await H.wsSend(pc, { type: 'stage_move_to_audience', channelId: stageId, userId: ids.alice });
  await sleep(1000);
  const st2 = await stageState(pa);
  check('audience carol cannot promote herself or demote alice', st2.speakers.length === 1 && st2.speakers[0] === ids.alice, JSON.stringify(st2));
  f = await H.measure(all);
  check('carol still silent, alice still heard', f[1].flowing === 1 && f[2].flowing === 1 && f[0].flowing === 0, H.fmt(f));

  section('2f. speaker leaves and rejoins');
  await H.leaveVoice(pa);
  f = await H.waitFlowing([pb, pc], [0, 0], 8000);
  check('the only speaker leaves: audience hears nothing', f.ok, H.fmt(f.last));
  await H.joinVoice(pa, server.id, stageId);
  f = await H.waitFlowing(all, [0, 1, 1], 15000);
  check('alice rejoins as speaker automatically and is heard', f.ok, H.fmt(f.last));
  for (const p of all) await H.leaveVoice(p);
  const z = await waitFor(async () => { const s = await alice.sfuStatus(); return s.rooms === 0 && s.transports === 0 && s; }, 5000);
  check('stage over: SFU empty', !!z, JSON.stringify(await alice.sfuStatus()));
  H.checkNoPageErrors(all);
  await H.stopServer(srv);
  check('server log has no exceptions', srv.problems.length === 0, srv.problems.slice(0, 3).join(' | '));
});
