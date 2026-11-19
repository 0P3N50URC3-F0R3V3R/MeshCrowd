// Scenario 1: DM and group-DM calls in SFU and mesh mode: ringing, join/leave mid-call, a member
// added to the group during the call, a member leaving the conversation during the call.
import * as H from './lib.mjs';
const { check, section, sleep, waitFor } = H;

H.run('dm', async () => {
  const srv = await H.startServer({ port: 8070, sfuPort: 46000 });
  const { apis } = await H.world(srv, { users: ['alice', 'bob', 'carol', 'dave', 'erin'] });
  const { alice, bob, carol, dave, erin } = apis;
  const dm1 = (await alice.post('/api/dms', { userId: bob.user.id })).dmId;
  const group = (await alice.post('/api/dms/group', { userIds: [bob.user.id, carol.user.id], name: 'Trio' })).dmId;

  const pa = await H.openPage('alice'), pb = await H.openPage('bob'), pc = await H.openPage('carol'), pd = await H.openPage('dave');
  const all = [pa, pb, pc, pd];
  await Promise.all([[pa, alice], [pb, bob], [pc, carol], [pd, dave]].map(([p, a]) => H.loginPage(p, srv, a)));
  const rings = (p, dmId) => p.evaluate((id) => window.__frames.filter((f) => f.type === 'voice_ring' && f.dmChannelId === id).length, dmId);

  section('1a. 1:1 DM call in SFU mode');
  await H.joinDm(pa, dm1);
  const ringed = await waitFor(() => rings(pb, dm1).then((n) => n === 1), 5000);
  check('bob is rung once when alice starts the call', !!ringed);
  check('alice herself is not rung', (await rings(pa, dm1)) === 0);
  const st0 = await H.lastState(pb, { dm: dm1 });
  check('bob (not in the call) sees voice_state with alice, mode sfu', st0?.mode === 'sfu' && st0.participants.some((u) => u.id === alice.user.id), JSON.stringify(st0 && { mode: st0.mode, ids: st0.participants.map((u) => u.id) }));
  await H.joinDm(pb, dm1);
  let f = await H.waitFlowing([pa, pb], [1, 1], 15000);
  check('1:1 SFU audio flows both ways', f.ok, H.fmt(f.last));
  check('each side has exactly one send + one recv transport', (await Promise.all([pa, pb].map(H.livePcIds))).every((l) => l.length === 2));
  check('bob joining did not ring again', (await rings(pa, dm1)) === 0 && (await rings(pb, dm1)) === 1);
  await H.leaveVoice(pb);
  f = await H.waitFlowing([pa], [0], 6000);
  check('bob leaves: alice receives nothing any more', f.ok, H.fmt(f.last));
  await H.joinDm(pb, dm1);
  f = await H.waitFlowing([pa, pb], [1, 1], 15000);
  check('bob rejoins: audio flows both ways again', f.ok, H.fmt(f.last));
  check('rejoin into a live call does not ring', (await rings(pa, dm1)) === 0 && (await rings(pb, dm1)) === 1);
  await H.leaveVoice(pa);
  await H.leaveVoice(pb);
  const zero = await waitFor(async () => { const s = await alice.sfuStatus(); return s.rooms === 0 && s.transports === 0 && s; }, 5000);
  check('after both leave the SFU has no rooms/transports', !!zero, JSON.stringify(await alice.sfuStatus()));

  section('1b. group DM call (3 users, then a 4th added mid-call)');
  await H.joinDm(pa, group);
  await waitFor(async () => (await rings(pb, group)) === 1 && (await rings(pc, group)) === 1, 5000);
  check('bob and carol are rung once each', (await rings(pb, group)) === 1 && (await rings(pc, group)) === 1);
  await H.joinDm(pb, group);
  await H.joinDm(pc, group);
  f = await H.waitFlowing([pa, pb, pc], [2, 2, 2], 15000);
  check('3-way group SFU audio flows', f.ok, H.fmt(f.last));
  check('no extra rings for later joiners', (await rings(pb, group)) === 1 && (await rings(pc, group)) === 1 && (await rings(pa, group)) === 0);
  await H.leaveVoice(pc);
  f = await H.waitFlowing([pa, pb], [1, 1], 8000);
  check('carol leaves mid-call: alice and bob still hear each other, not carol', f.ok, H.fmt(f.last));
  const audioA = await H.allAudioEls(pa);
  check('alice has one <audio> element left (no leftover for carol)', audioA === 1, String(audioA));
  await H.joinDm(pc, group);
  f = await H.waitFlowing([pa, pb, pc], [2, 2, 2], 15000);
  check('carol rejoins: 3-way audio again', f.ok, H.fmt(f.last));

  await alice.post(`/api/dms/${group}/members`, { userIds: [dave.user.id] });
  const gotDm = await waitFor(() => pd.evaluate((id) => window.__frames.some((x) => x.type === 'dm_create' && x.dm.id === id), group), 5000);
  check('dave added mid-call receives dm_create', !!gotDm);
  check('dave is not rung for a call that is already running', (await rings(pd, group)) === 0);
  await H.joinDm(pd, group);
  f = await H.waitFlowing([pa, pb, pc, pd], [3, 3, 3, 3], 15000);
  check('dave joins the live group call: 4-way audio', f.ok, H.fmt(f.last));
  const tiles = await pd.$$eval('#dm-voice-panel .voice-tile', (els) => els.map((e) => Number(e.dataset.uid)));
  check('dave sees 4 tiles', new Set(tiles).size === 4, JSON.stringify(tiles));

  section('1c. a member leaves the group conversation while in its call');
  await carol.del(`/api/dms/${group}/members/me`);
  await sleep(2500);
  const stAfter = await H.lastState(pa, { dm: group });
  const carolStill = stAfter?.participants.some((u) => u.id === carol.user.id);
  const mAfter = await H.measure([pa, pc]);
  H.note('after carol left the conversation: carol still in roster =', carolStill, 'alice inbound', H.fmt([mAfter[0]]), 'carol inbound', H.fmt([mAfter[1]]));
  check('a user who left the group conversation is no longer in its call', !carolStill, `roster ${JSON.stringify(stAfter?.participants.map((u) => u.id))}`);
  check('her client ended the call (no Leave button, no remote audio)', !(await H.inCall(pc)) && (await H.remoteAudioEls(pc)) === 0);
  check('alice and the others no longer receive carol', mAfter[0].flowing === 2);
  // a non-member cannot join or use the SFU of that DM room
  const raw = await H.rawSocket(srv, erin);
  raw.send({ type: 'voice_join', dmChannelId: group, sfu: true });
  await sleep(800);
  const r1 = await raw.request({ dmChannelId: group }, 'caps', {});
  check('a non-member\'s sfu_request for the DM room is refused (not_participant)', r1?.ok === false && r1.error === 'not_participant', JSON.stringify(r1));
  check('a non-member never appears in the DM roster', !(await H.lastState(pa, { dm: group }))?.participants.some((u) => u.id === erin.user.id));
  await raw.close();

  for (const p of [pa, pb, pc, pd]) if (await H.inCall(p)) await H.leaveVoice(p);
  const z2 = await waitFor(async () => { const s = await alice.sfuStatus(); return s.rooms === 0 && s.transports === 0 && s; }, 6000);
  check('group call over: SFU rooms/peers back to 0', !!z2, JSON.stringify(await alice.sfuStatus()));
  H.checkNoPageErrors(all, 'SFU DM part: no page errors');

  section('1d. group DM call in mesh mode');
  await alice.patch('/api/admin/calls', { voice: { mode: 'mesh' } });
  const g2 = (await alice.post('/api/dms/group', { userIds: [bob.user.id, dave.user.id], name: 'MeshTrio' })).dmId;
  await waitFor(() => pd.evaluate((id) => window.__frames.some((x) => x.type === 'dm_create' && x.dm.id === id), g2), 5000);
  await H.joinDm(pa, g2);
  await waitFor(async () => (await rings(pb, g2)) === 1 && (await rings(pd, g2)) === 1, 5000);
  check('mesh: both others rung once', (await rings(pb, g2)) === 1 && (await rings(pd, g2)) === 1);
  await H.joinDm(pb, g2);
  await H.joinDm(pd, g2);
  const modes = await Promise.all([pa, pb, pd].map((p) => H.lastState(p, { dm: g2 }).then((s) => s?.mode)));
  check('mesh: room mode is mesh', modes.every((m) => m === 'mesh'), JSON.stringify(modes));
  f = await H.waitFlowing([pa, pb, pd], [2, 2, 2], 20000);
  check('mesh: 3-way group audio flows', f.ok, H.fmt(f.last));
  check('mesh: two peer connections each', (await Promise.all([pa, pb, pd].map(H.livePcIds))).every((l) => l.length === 2));
  await H.leaveVoice(pd);
  f = await H.waitFlowing([pa, pb], [1, 1], 8000);
  check('mesh: member leaves mid-call, the others keep talking', f.ok, H.fmt(f.last));
  await H.joinDm(pd, g2);
  f = await H.waitFlowing([pa, pb, pd], [2, 2, 2], 20000);
  check('mesh: member rejoins, 3-way again', f.ok, H.fmt(f.last));
  for (const p of [pa, pb, pd]) await H.leaveVoice(p);
  check('mesh calls never touch the SFU', (await alice.sfuStatus()).rooms === 0);
  H.checkNoPageErrors(all, 'mesh DM part: no page errors');
  await H.stopServer(srv);
  check('server log has no exceptions', srv.problems.length === 0, srv.problems.slice(0, 3).join(' | '));
});
