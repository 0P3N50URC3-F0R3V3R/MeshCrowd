// Scenario 7: limits and abuse over raw authenticated WebSockets: malformed sfu_request payloads,
// flooding, duplicate consume, produce after leave, foreign rooms, oversize frames, invisible users,
// voice channels without VIEW_CHANNEL, and losing access mid-call (kick, ban, leave, channel delete,
// permission override). The server must stay up and usable.
import * as H from './lib.mjs';
const { check, section, sleep, waitFor } = H;

H.run('abuse', async () => {
  const srv = await H.startServer({ port: 8076, sfuPort: 46060 });
  const { apis, server, ch } = await H.world(srv, { users: ['alice', 'bob', 'carol', 'dave', 'erin', 'frank'], voice: ['Lounge', 'Secret', 'Doomed'] });
  const { alice, bob, carol, dave, erin, frank } = apis;
  const L = ch.Lounge.id;
  const scope = { channelId: L };
  const pa = await H.openPage('alice'), pb = await H.openPage('bob');
  await H.loginPage(pa, srv, alice); await H.loginPage(pb, srv, bob);
  await H.joinVoice(pa, server.id, L);
  await H.joinVoice(pb, server.id, L);
  let f = await H.waitFlowing([pa, pb], [1, 1], 15000);
  check('baseline: alice and bob talk', f.ok, H.fmt(f.last));
  const alive = () => srv.proc.exitCode === null;

  section('7a. malformed sfu_request payloads (carol, joined over a raw socket)');
  const rc = await H.rawSocket(srv, carol);
  rc.send({ type: 'voice_join', channelId: L, sfu: true });
  check('raw carol joins Lounge', !!(await rc.wait((m) => m.type === 'voice_state' && m.participants.some((u) => u.id === carol.user.id))));
  const capsR = await rc.request(scope, 'caps', {});
  check('caps works for a participant', capsR?.ok === true && !!capsR.data.rtpCapabilities, JSON.stringify(capsR).slice(0, 120));
  const rtpCaps = capsR.data.rtpCapabilities;
  const cases = [
    ['unknown op', scope, 'nope', {}, 'bad_request'],
    ['op __proto__', scope, '__proto__', {}, 'bad_request'],
    ['op constructor', scope, 'constructor', {}, 'bad_request'],
    ['op toString', scope, 'toString', {}, 'bad_request'],
    ['op as number', scope, 42, {}, 'bad_request'],
    ['data string', scope, 'caps', 'x', 'bad_request'],
    ['data array', scope, 'create_transport', ['send'], 'bad_request'],
    ['data number', scope, 'create_transport', 5, 'bad_request'],
    ['direction object', scope, 'create_transport', { direction: { a: 1 } }, 'bad_request'],
    ['direction missing', scope, 'create_transport', {}, 'bad_request'],
    ['connect unknown transport', scope, 'connect_transport', { transportId: 'x', dtlsParameters: { fingerprints: [{ algorithm: 'sha-256', value: 'AA' }] } }, 'not_found'],
    ['connect bad dtls', scope, 'connect_transport', { transportId: 'x', dtlsParameters: { fingerprints: 'no' } }, 'bad_request'],
    ['produce no transport', scope, 'produce', { transportId: 'x', kind: 'audio', media: 'audio', rtpParameters: { codecs: [{ mimeType: 'audio/opus', payloadType: 100, clockRate: 48000 }] } }, 'not_found'],
    ['produce kind/media mismatch', scope, 'produce', { transportId: 'x', kind: 'video', media: 'audio', rtpParameters: {} }, 'bad_request'],
    ['produce media __proto__', scope, 'produce', { transportId: 'x', kind: 'video', media: '__proto__', rtpParameters: {} }, 'bad_request'],
    ['produce rtpParameters codecs huge list', scope, 'produce', { transportId: 'x', kind: 'audio', media: 'audio', rtpParameters: { codecs: Array.from({ length: 50 }, () => ({ mimeType: 'audio/opus', payloadType: 1, clockRate: 1 })) } }, 'bad_request'],
    ['consume unknown producer', scope, 'consume', { producerId: 'nope', rtpCapabilities: rtpCaps }, 'bad_request'],
    ['consume producerId object', scope, 'consume', { producerId: { $gt: '' }, rtpCapabilities: rtpCaps }, 'bad_request'],
    ['resume unknown consumer', scope, 'resume_consumer', { consumerId: 'nope' }, 'not_found'],
    ['close unknown producer', scope, 'close_producer', { producerId: 'nope' }, 'not_found'],
    ['pause producer id too long', scope, 'pause_producer', { producerId: 'x'.repeat(65) }, 'bad_request'],
    ['report_failure bad direction', scope, 'report_failure', { direction: 'up' }, 'bad_request'],
    ['huge string field (70 KB)', scope, 'create_transport', { direction: 'send', pad: 'x'.repeat(70 * 1024) }, 'bad_request'],
    ['channelId string', { channelId: 'abc' }, 'caps', {}, 'bad_request'],
    ['channelId negative', { channelId: -5 }, 'caps', {}, 'bad_request'],
    ['channelId float', { channelId: 1.5 }, 'caps', {}, 'bad_request'],
    ['channelId huge', { channelId: 1e300 }, 'caps', {}, 'bad_request'],
    ['dmChannelId junk', { dmChannelId: '1e400' }, 'caps', {}, 'bad_request'],
    ['no scope', {}, 'caps', {}, 'bad_request'],
    ['room you are not in', { channelId: ch.Secret.id }, 'caps', {}, 'not_participant'],
    ['nonexistent room', { channelId: 999999 }, 'caps', {}, 'not_participant'],
  ];
  for (const [name, sc, op, data, want] of cases) {
    const r = await rc.request(sc, op, data);
    // consume of an unknown producer can be not_found or bad_request (rtpCaps check first); accept either refusal
    const ok = r && r.ok === false && (r.error === want || (want === 'bad_request' && r.error === 'not_found'));
    check(`refused: ${name}`, ok, JSON.stringify(r));
  }
  // prototype pollution keys inside data, sent as raw JSON text
  rc.sendRaw(`{"type":"sfu_request","id":"pp1","channelId":${L},"op":"create_transport","data":{"__proto__":{"direction":"send","polluted":true},"constructor":{"prototype":{"polluted":true}}}}`);
  const pp = await rc.wait((m) => m.id === 'pp1');
  check('__proto__ in data does not supply direction', pp?.ok === false && pp.error === 'bad_request', JSON.stringify(pp));
  // ids that get no reply at all
  rc.send({ type: 'sfu_request', id: { x: 1 }, channelId: L, op: 'caps' });
  rc.send({ type: 'sfu_request', id: 'y'.repeat(65), channelId: L, op: 'caps' });
  rc.send({ type: 'sfu_request', channelId: L, op: 'caps' });
  rc.sendRaw('not json at all');
  rc.sendRaw('{"type":123}');
  rc.sendRaw('null');
  rc.sendRaw('[1,2,3]');
  rc.sock.send(Buffer.from([0, 1, 2, 3]), { binary: true });
  await sleep(500);
  check('the raw socket is still open after junk frames', rc.isOpen());
  const caps2 = await rc.request(scope, 'caps', {});
  check('and still answered afterwards', caps2?.ok === true);

  section('7b. duplicate consume, transport limits, flood');
  const recv = await rc.request(scope, 'create_transport', { direction: 'recv' });
  check('carol creates a recv transport', recv?.ok === true, JSON.stringify(recv).slice(0, 100));
  const recv2 = await rc.request(scope, 'create_transport', { direction: 'recv' });
  check('a second recv transport is refused (limit)', recv2?.ok === false && recv2.error === 'limit', JSON.stringify(recv2));
  const list = await rc.request(scope, 'list_producers', {});
  const target = list?.data?.find((p) => p.userId === alice.user.id);
  check('list_producers shows alice\'s audio producer', !!target, JSON.stringify(list?.data));
  const c1 = await rc.request(scope, 'consume', { producerId: target?.producerId, rtpCapabilities: rtpCaps });
  check('first consume of alice\'s producer works', c1?.ok === true, JSON.stringify(c1).slice(0, 120));
  const c2 = await rc.request(scope, 'consume', { producerId: target?.producerId, rtpCapabilities: rtpCaps });
  check('second consume of the same producer is refused (limit)', c2?.ok === false && c2.error === 'limit', JSON.stringify(c2));
  const t0 = Date.now();
  const ids = [];
  for (let i = 0; i < 600; i++) { const id = `fl-${i}`; ids.push(id); rc.send({ type: 'sfu_request', id, channelId: L, op: i % 2 ? 'caps' : 'list_producers', data: {} }); }
  const answered = await waitFor(() => ids.every((id) => rc.frames.some((m) => m.id === id)) || null, 20000, 100);
  const replies = rc.frames.filter((m) => ids.includes(m.id));
  const limited = replies.filter((m) => m.error === 'rate_limited').length;
  check('600 flooded requests all get a reply', !!answered, `${replies.length}/600 in ${Date.now() - t0} ms, rate_limited=${limited}`);
  H.note(`flood: ok=${replies.filter((m) => m.ok).length} rate_limited=${limited}`);
  f = await H.measure([pa, pb]);
  check('alice and bob still talk during/after the flood', f.every((x) => x.flowing === 1), H.fmt(f));

  section('7c. produce after leave, foreign rooms, DM room you are not in');
  rc.send({ type: 'voice_leave', channelId: L });
  await sleep(500);
  const afterLeave = await rc.request(scope, 'create_transport', { direction: 'send' });
  check('requests after leaving are refused (not_participant)', afterLeave?.ok === false && afterLeave.error === 'not_participant', JSON.stringify(afterLeave));
  const st = await alice.sfuStatus();
  check('carol\'s raw peer is gone after leave (alice+bob: 4 transports)', st.transports === 4, JSON.stringify({ t: st.transports, c: st.consumers }));
  const dmAB = (await alice.post('/api/dms', { userId: bob.user.id })).dmId;
  const dmReq = await rc.request({ dmChannelId: dmAB }, 'caps', {});
  check('sfu_request for a DM room carol is not a member of: not_participant', dmReq?.ok === false && dmReq.error === 'not_participant', JSON.stringify(dmReq));
  rc.send({ type: 'voice_join', dmChannelId: dmAB, sfu: true });
  rc.send({ type: 'voice_leave', dmChannelId: dmAB });
  rc.send({ type: 'voice_join', channelId: 999999, sfu: true });
  rc.send({ type: 'voice_join', channelId: 'abc', sfu: true });
  rc.send({ type: 'voice_join', channelId: (await alice.get(`/api/servers/${server.id}`)).channels.find((c) => c.type === 'public').id, sfu: true });
  await sleep(500);
  check('joins to a foreign DM / nonexistent / text channel do nothing', !rc.frames.some((m) => m.type === 'voice_state' && (m.dmChannelId === dmAB || m.channelId === 999999)));

  section('7d. oversize frame');
  const big = await H.rawSocket(srv, dave);
  big.sendRaw('x'.repeat(3 * 1024 * 1024));
  const code = await Promise.race([big.closed, sleep(5000).then(() => 'timeout')]);
  check('a >2 MiB frame closes that socket (1009)', code === 1009, String(code));
  await sleep(300);
  check('the server is still up', alive() && (await fetch(`${srv.base}/api/config`)).ok);
  const after = await H.rawSocket(srv, dave);
  after.send({ type: 'ping' });
  check('a new socket works after the oversize frame', !!(await after.wait((m) => m.type === 'pong', 3000)));
  await after.close();

  section('7e. invisible user and VIEW_CHANNEL');
  await erin.put('/api/users/me/status', { status: 'invisible' });
  const re = await H.rawSocket(srv, erin);
  re.send({ type: 'voice_join', channelId: L, sfu: true });
  const denied = await re.wait((m) => m.type === 'voice_join_denied', 3000);
  check('invisible user is refused with reason invisible', denied?.reason === 'invisible', JSON.stringify(denied));
  const capsE = await re.request(scope, 'caps', {});
  check('and cannot use the SFU', capsE?.ok === false && capsE.error === 'not_participant');
  await re.close();
  const detail = await alice.get(`/api/servers/${server.id}`);
  const everyone = detail.roles.find((r) => r.is_default || r.isDefault || r.name === '@everyone');
  await alice.put(`/api/servers/${server.id}/channels/${ch.Secret.id}/overrides/${everyone.id}`, { allow: 0, deny: 1 });
  const rf = await H.rawSocket(srv, frank);
  rf.send({ type: 'voice_join', channelId: ch.Secret.id, sfu: true });
  await sleep(800);
  check('a user without VIEW_CHANNEL cannot join the private voice channel', !rf.frames.some((m) => m.type === 'voice_state' && m.participants?.some((u) => u.id === frank.user.id)));
  check('...and cannot use its SFU', (await rf.request({ channelId: ch.Secret.id }, 'caps', {}))?.error === 'not_participant');

  section('7f. losing access mid-call');
  const inRoster = async (uid, chId = L) => (await H.lastState(pa, chId))?.participants.some((u) => u.id === uid);
  // permission override revoked while frank is in Lounge
  rf.send({ type: 'voice_join', channelId: L, sfu: true });
  await rf.wait((m) => m.type === 'voice_state' && m.channelId === L && m.participants.some((u) => u.id === frank.user.id));
  await alice.put(`/api/servers/${server.id}/channels/${L}/overrides/${everyone.id}`, { allow: 0, deny: 1 });
  await sleep(1500);
  check('VIEW_CHANNEL revoked mid-call: frank is dropped from the call', !(await inRoster(frank.user.id)));
  check('...and his SFU requests are refused', (await rf.request(scope, 'caps', {}))?.error === 'not_participant');
  await alice.put(`/api/servers/${server.id}/channels/${L}/overrides/${everyone.id}`, { allow: 0, deny: 0 });
  // kick
  await sleep(500);
  rf.send({ type: 'voice_join', channelId: L, sfu: true });
  await rf.wait((m) => m.type === 'voice_state' && m.channelId === L && m.participants.some((u) => u.id === frank.user.id), 3000);
  await alice.post(`/api/servers/${server.id}/members/${frank.user.id}/kick`, {});
  await sleep(1500);
  check('kicked mid-call: frank is dropped from the call', !(await inRoster(frank.user.id)));
  // bob (browser) is banned mid-call
  await alice.post(`/api/servers/${server.id}/members/${bob.user.id}/ban`, {});
  await sleep(2000);
  check('banned mid-call: bob is dropped from the call', !(await inRoster(bob.user.id)));
  f = await H.measure([pa, pb]);
  check('...and bob no longer receives alice', f[1].flowing === 0, H.fmt(f));
  check('bob\'s client no longer shows the call', !(await H.inCall(pb)));
  // leave server
  rc.send({ type: 'voice_join', channelId: L, sfu: true });
  await rc.wait((m) => m.type === 'voice_state' && m.channelId === L && m.participants.some((u) => u.id === carol.user.id), 3000);
  await carol.post(`/api/servers/${server.id}/leave`, {});
  await sleep(1500);
  check('leaving the server mid-call drops carol from the call', !(await inRoster(carol.user.id)));
  // channel deleted
  await H.leaveVoice(pa);
  await H.joinVoice(pa, server.id, ch.Doomed.id);
  const rd = await H.rawSocket(srv, dave);
  rd.send({ type: 'voice_join', channelId: ch.Doomed.id, sfu: true });
  await rd.wait((m) => m.type === 'voice_state' && m.channelId === ch.Doomed.id && m.participants.length === 2, 3000);
  await alice.del(`/api/servers/${server.id}/channels/${ch.Doomed.id}`);
  await sleep(1500);
  const sDel = await alice.sfuStatus();
  check('deleting a voice channel mid-call ends its SFU room', sDel.rooms === 0 && sDel.transports === 0, JSON.stringify({ r: sDel.rooms, t: sDel.transports }));
  check('dave\'s SFU requests for the deleted channel are refused', (await rd.request({ channelId: ch.Doomed.id }, 'caps', {}))?.ok === false);
  check('alice\'s client no longer shows the call', !(await H.inCall(pa)));
  for (const s of [rc, rf, rd]) await s.close();
  check('server still up at the end', alive());
  H.checkNoPageErrors([pa, pb]);
  await H.stopServer(srv);
  check('server log has no exceptions', srv.problems.length === 0, srv.problems.slice(0, 3).join(' | '));
});
