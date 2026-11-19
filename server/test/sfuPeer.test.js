'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mediasoup = require('mediasoup');
const { createSfu, SfuError } = require('../lib/sfu');
const { limitsFor } = require('../lib/sfu/peer');

function conf(port, sfu = {}, mode = 'sfu') {
  return { turn: {}, voice: { mode, sfu: { port, workers: 1, announcedHost: '127.0.0.1', maxKbpsPerUser: 0, enableTcp: false, ...sfu } } };
}

async function setup(port, { participants = [1, 2, 3], sfu, muted = new Set() } = {}) {
  const cfg = conf(port, sfu);
  const events = [];
  const s = createSfu({ load: () => cfg, probe: () => ({ ok: true }) });
  await s.start(null, {
    isParticipant: (key, uid) => key === 'room' && participants.includes(uid),
    isMuted: (key, uid) => muted.has(uid),
  });
  s.setNotifier((uid, event, roomKey) => events.push([uid, event, roomKey]));
  await s.openRoom('room');
  return { s, cfg, events };
}

const req = (s, uid, op, data) => s.request('room', uid, op, data);

function rtp(caps, mimeType, ssrc) {
  const c = caps.codecs.find((x) => x.mimeType === mimeType);
  return {
    mid: String(ssrc),
    codecs: [{ mimeType, payloadType: c.preferredPayloadType, clockRate: c.clockRate, ...(c.channels ? { channels: c.channels } : {}), parameters: {}, rtcpFeedback: [] }],
    encodings: [{ ssrc }],
    headerExtensions: [],
    rtcp: { cname: `u${ssrc}` },
  };
}

async function sendTransport(s, uid) {
  return (await req(s, uid, 'create_transport', { direction: 'send' })).id;
}

async function produceAudio(s, uid, ssrc = 1000 + uid) {
  const { rtpCapabilities } = await req(s, uid, 'caps');
  const transportId = await sendTransport(s, uid);
  const { producerId } = await req(s, uid, 'produce', { transportId, kind: 'audio', media: 'audio', rtpParameters: rtp(rtpCapabilities, 'audio/opus', ssrc) });
  return { producerId, transportId, rtpCapabilities };
}

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof SfuError, `expected SfuError, got ${err && err.stack}`);
    assert.equal(err.code, code);
    return true;
  });
}

test('effectiveMode is sfu only when configured, available and started', async () => {
  const cfg = conf(45210);
  const s = createSfu({ load: () => cfg, probe: () => ({ ok: true }) });
  try {
    assert.equal(s.effectiveMode(), 'mesh');
    await rejectsWith(s.request('room', 1, 'caps'), 'unavailable');
    await s.start(null, { isParticipant: () => true });
    assert.equal(s.effectiveMode(), 'sfu');
    assert.equal(s.status().running, true);
    cfg.voice.mode = 'mesh';
    s.refreshMode();
    assert.equal(s.effectiveMode(), 'mesh');
  } finally {
    await s.stop();
  }
  const bad = createSfu({ load: () => conf(45211), probe: () => ({ ok: false, reason: 'nope' }) });
  await bad.start(null, {});
  assert.deepEqual(bad.available(), { ok: false, reason: 'nope' });
  assert.equal(bad.effectiveMode(), 'mesh');
  assert.equal(bad.status().running, false);
  await bad.stop();
  const meshOnly = createSfu({ load: () => conf(45211, {}, 'mesh'), probe: () => ({ ok: true }) });
  await meshOnly.start(null, {});
  assert.equal(meshOnly.status().running, false);
  await meshOnly.stop();
});

test('non-participant gets not_participant', async () => {
  const { s } = await setup(45212, { participants: [1] });
  try {
    await rejectsWith(req(s, 9, 'caps'), 'not_participant');
    await rejectsWith(s.request('other', 1, 'caps'), 'not_participant');
    const { rtpCapabilities } = await req(s, 1, 'caps');
    assert.ok(rtpCapabilities.codecs.some((c) => c.mimeType === 'audio/opus'));
  } finally {
    await s.stop();
  }
});

test('create_transport twice per direction beyond 2 transports gets limit', async () => {
  const { s } = await setup(45213);
  try {
    const send = await req(s, 1, 'create_transport', { direction: 'send' });
    assert.ok(send.id && send.iceParameters && send.dtlsParameters);
    assert.ok(send.iceCandidates.some((c) => c.address === '127.0.0.1' && c.port === 45213 && c.protocol === 'udp'));
    await rejectsWith(req(s, 1, 'create_transport', { direction: 'send' }), 'limit');
    await req(s, 1, 'create_transport', { direction: 'recv' });
    await rejectsWith(req(s, 1, 'create_transport', { direction: 'recv' }), 'limit');
    await rejectsWith(req(s, 2, 'create_transport', { direction: 'sideways' }), 'bad_request');
    await rejectsWith(req(s, 2, 'create_transport'), 'bad_request');
    assert.equal(s.status().transports, 2);
  } finally {
    await s.stop();
  }
});

test('connect_transport validates and checks ownership', async () => {
  const { s } = await setup(45214);
  try {
    const id = await sendTransport(s, 1);
    const fp = { algorithm: 'sha-256', value: 'AA:'.repeat(31) + 'AA' };
    await rejectsWith(req(s, 2, 'connect_transport', { transportId: id, dtlsParameters: { fingerprints: [fp] } }), 'not_found');
    await rejectsWith(req(s, 1, 'connect_transport', { transportId: id, dtlsParameters: { fingerprints: 'x' } }), 'bad_request');
    await rejectsWith(req(s, 1, 'connect_transport', { transportId: id, dtlsParameters: { fingerprints: [fp], role: 'boss' } }), 'bad_request');
    assert.deepEqual(await req(s, 1, 'connect_transport', { transportId: id, dtlsParameters: { fingerprints: [fp], role: 'client' } }), {});
    await rejectsWith(req(s, 1, 'connect_transport', { transportId: id, dtlsParameters: { fingerprints: [fp], role: 'client' } }), 'bad_request');
  } finally {
    await s.stop();
  }
});

test('second audio producer for the same user gets limit', async () => {
  const { s } = await setup(45215);
  try {
    const { transportId, rtpCapabilities } = await produceAudio(s, 1);
    await rejectsWith(req(s, 1, 'produce', { transportId, kind: 'audio', media: 'audio', rtpParameters: rtp(rtpCapabilities, 'audio/opus', 5555) }), 'limit');
    const cam = await req(s, 1, 'produce', { transportId, kind: 'video', media: 'camera', rtpParameters: rtp(rtpCapabilities, 'video/VP8', 6666) });
    assert.ok(cam.producerId);
    await rejectsWith(req(s, 1, 'produce', { transportId, kind: 'video', media: 'camera', rtpParameters: rtp(rtpCapabilities, 'video/VP8', 6667) }), 'limit');
    await req(s, 1, 'produce', { transportId, kind: 'video', media: 'screen', rtpParameters: rtp(rtpCapabilities, 'video/VP8', 7777) });
    assert.equal(s.status().producers, 3);
  } finally {
    await s.stop();
  }
});

test('produce with garbage rtpParameters returns bad_request and does not throw', async () => {
  const { s } = await setup(45216);
  try {
    const { rtpCapabilities } = await req(s, 1, 'caps');
    const transportId = await sendTransport(s, 1);
    const good = rtp(rtpCapabilities, 'audio/opus', 1234);
    const bad = [
      { transportId, kind: 'audio', media: 'audio', rtpParameters: 'x' },
      { transportId, kind: 'audio', media: 'audio', rtpParameters: { codecs: 'x' } },
      { transportId, kind: 'audio', media: 'audio', rtpParameters: { codecs: [{ mimeType: 'audio/opus' }] } },
      { transportId, kind: 'audio', media: 'audio', rtpParameters: { ...good, codecs: [{ ...good.codecs[0], mimeType: 'audio/nope' }] } },
      { transportId, kind: 'audio', media: 'audio', rtpParameters: { ...good, encodings: [{ ssrc: 'many' }] } },
      { transportId, kind: 'video', media: 'audio', rtpParameters: good },
      { transportId, kind: 'audio', media: 'toString', rtpParameters: good },
      { transportId, kind: 'audio', media: '__proto__', rtpParameters: good },
      { transportId: 42, kind: 'audio', media: 'audio', rtpParameters: good },
    ];
    for (const data of bad) await rejectsWith(req(s, 1, 'produce', data), 'bad_request');
    await rejectsWith(req(s, 1, 'nonsense', {}), 'bad_request');
    await rejectsWith(req(s, 1, 'caps', 'str'), 'bad_request');
    await rejectsWith(req(s, 1, 'caps', { blob: 'x'.repeat(70000) }), 'bad_request');
    const recv = (await req(s, 1, 'create_transport', { direction: 'recv' })).id;
    await rejectsWith(req(s, 1, 'produce', { transportId: recv, kind: 'audio', media: 'audio', rtpParameters: good }), 'not_found');
    assert.ok((await req(s, 1, 'produce', { transportId, kind: 'audio', media: 'audio', rtpParameters: good })).producerId);
  } finally {
    await s.stop();
  }
});

test('producer for user A is announced to B via notifier', async () => {
  const { s, events } = await setup(45217);
  try {
    await req(s, 2, 'caps');
    const { producerId } = await produceAudio(s, 1);
    assert.deepEqual(events, [[2, { event: 'new_producer', producerId, userId: 1, media: 'audio', kind: 'audio' }, 'room']]);
  } finally {
    await s.stop();
  }
});

test('list_producers returns existing producers for a late joiner', async () => {
  const { s } = await setup(45218);
  try {
    const { producerId } = await produceAudio(s, 1);
    assert.deepEqual(await req(s, 3, 'list_producers'), [{ producerId, userId: 1, media: 'audio', kind: 'audio' }]);
    assert.deepEqual(await req(s, 1, 'list_producers'), []);
  } finally {
    await s.stop();
  }
});

test('consume of an unknown producerId gets not_found; a real one is created paused', async () => {
  const { s } = await setup(45219);
  try {
    const { producerId, rtpCapabilities } = await produceAudio(s, 1);
    await rejectsWith(req(s, 2, 'consume', { producerId, rtpCapabilities }), 'bad_request');
    await req(s, 2, 'create_transport', { direction: 'recv' });
    await rejectsWith(req(s, 2, 'consume', { producerId: 'nope', rtpCapabilities }), 'not_found');
    await rejectsWith(req(s, 2, 'consume', { producerId, rtpCapabilities: 'x' }), 'bad_request');
    await rejectsWith(req(s, 2, 'consume', { producerId, rtpCapabilities: { codecs: [] } }), 'bad_request');
    const c = await req(s, 2, 'consume', { producerId, rtpCapabilities });
    assert.equal(c.producerId, producerId);
    assert.equal(c.kind, 'audio');
    assert.equal(c.userId, 1);
    assert.equal(c.media, 'audio');
    assert.ok(c.rtpParameters.codecs.length);
    const consumer = s.peerOf('room', 2).consumers.get(c.consumerId);
    assert.equal(consumer.paused, true);
    await rejectsWith(req(s, 3, 'resume_consumer', { consumerId: c.consumerId }), 'not_found');
    assert.deepEqual(await req(s, 2, 'resume_consumer', { consumerId: c.consumerId }), {});
    assert.equal(consumer.paused, false);
  } finally {
    await s.stop();
  }
});

test('leave closes the user\'s transports and emits producer_closed to others', async () => {
  const { s, events } = await setup(45220);
  try {
    const { producerId, rtpCapabilities } = await produceAudio(s, 1);
    await req(s, 2, 'create_transport', { direction: 'recv' });
    const c = await req(s, 2, 'consume', { producerId, rtpCapabilities });
    const peer = s.peerOf('room', 1);
    const transports = [...peer.transports.values()];
    const consumer = s.peerOf('room', 2).consumers.get(c.consumerId);
    const consumerClosed = new Promise((r) => consumer.observer.once('close', r));
    events.length = 0;
    await s.leave('room', 1);
    assert.ok(transports.every((t) => t.closed));
    assert.equal(s.peerOf('room', 1), null);
    assert.deepEqual(events, [[2, { event: 'producer_closed', producerId, userId: 1, media: 'audio' }, 'room']]);
    await consumerClosed;
    assert.equal(s.peerOf('room', 2).consumers.has(c.consumerId), false);
    assert.deepEqual(await req(s, 3, 'list_producers'), []);
    await s.leave('room', 1);
  } finally {
    await s.stop();
  }
});

test('close_producer, pause_producer and resume_producer act on own producers only', async () => {
  const { s, events } = await setup(45221);
  try {
    await req(s, 2, 'caps');
    const { producerId } = await produceAudio(s, 1);
    const producer = s.peerOf('room', 1).producers.get(producerId);
    await rejectsWith(req(s, 2, 'pause_producer', { producerId }), 'not_found');
    await req(s, 1, 'pause_producer', { producerId });
    assert.equal(producer.paused, true);
    await req(s, 1, 'resume_producer', { producerId });
    assert.equal(producer.paused, false);
    events.length = 0;
    assert.deepEqual(await req(s, 1, 'close_producer', { producerId }), {});
    assert.equal(producer.closed, true);
    assert.deepEqual(events, [[2, { event: 'producer_closed', producerId, userId: 1, media: 'audio' }, 'room']]);
    await rejectsWith(req(s, 1, 'close_producer', { producerId }), 'not_found');
  } finally {
    await s.stop();
  }
});

test('maxKbpsPerUser 0 applies the default caps (audio 64, camera 1500, screen 3500)', async () => {
  assert.deepEqual(limitsFor(0), { audio: 64, camera: 1500, screen: 3500, maxIncomingBitrate: 5064000 });
  assert.deepEqual(limitsFor(1000), { audio: 64, camera: 1000, screen: 1000, maxIncomingBitrate: 1000000 });
  const calls = [];
  const onWorker = (w) => w.observer.on('newrouter', (r) => r.observer.on('newtransport', (t) => {
    const orig = t.setMaxIncomingBitrate.bind(t);
    t.setMaxIncomingBitrate = (bps) => { calls.push([t.appData.direction, bps]); return orig(bps); };
  }));
  mediasoup.observer.on('newworker', onWorker);
  const { s } = await setup(45222);
  mediasoup.observer.off('newworker', onWorker);
  try {
    const caps = await req(s, 1, 'caps');
    assert.deepEqual(caps.limits, { audio: 64, camera: 1500, screen: 3500 });
    await sendTransport(s, 1);
    await req(s, 1, 'create_transport', { direction: 'recv' });
    const peer = s.peerOf('room', 1);
    assert.equal(peer.limits.audio, 64);
    assert.equal(peer.limits.camera, 1500);
    assert.equal(peer.limits.screen, 3500);
    assert.deepEqual(calls, [['send', 5064000]]);
  } finally {
    await s.stop();
  }
});

test('force-muted user cannot produce or resume audio, setMuted pauses and resumes', async () => {
  const muted = new Set();
  const { s } = await setup(45223, { muted });
  try {
    const { producerId, transportId, rtpCapabilities } = await produceAudio(s, 1);
    const producer = s.peerOf('room', 1).producers.get(producerId);
    muted.add(1);
    await s.setMuted('room', 1, true);
    assert.equal(producer.paused, true);
    await rejectsWith(req(s, 1, 'resume_producer', { producerId }), 'muted');
    muted.delete(1);
    await s.setMuted('room', 1, false);
    assert.equal(producer.paused, false);
    await req(s, 1, 'pause_producer', { producerId });
    await s.setMuted('room', 1, true);
    await s.setMuted('room', 1, false);
    assert.equal(producer.paused, true, 'unmute does not resume a producer the client paused');
    await req(s, 1, 'close_producer', { producerId });
    muted.add(1);
    await rejectsWith(req(s, 1, 'produce', { transportId, kind: 'audio', media: 'audio', rtpParameters: rtp(rtpCapabilities, 'audio/opus', 999) }), 'muted');
    await s.setMuted('room', 9, true);
  } finally {
    await s.stop();
  }
});

test('closeRoom closes every peer without per-producer events and the room becomes unavailable', async () => {
  const { s, events } = await setup(45226);
  try {
    await req(s, 2, 'caps');
    const { transportId } = await produceAudio(s, 1);
    const transport = s.peerOf('room', 1).transports.get(transportId);
    events.length = 0;
    await s.closeRoom('room');
    assert.equal(transport.closed, true);
    assert.deepEqual(events, []);
    assert.equal(s.status().rooms, 0);
    await rejectsWith(req(s, 1, 'caps'), 'unavailable');
    await s.closeRoom('room');
  } finally {
    await s.stop();
  }
});

test('closeRoom during an in-flight openRoom closes the router created afterwards', async () => {
  const routers = [];
  const onWorker = (w) => w.observer.on('newrouter', (r) => routers.push(r));
  mediasoup.observer.on('newworker', onWorker);
  const { s } = await setup(45227);
  mediasoup.observer.off('newworker', onWorker);
  try {
    await s.closeRoom('room');
    routers.length = 0;
    const opening = s.openRoom('room');
    await s.closeRoom('room');
    await rejectsWith(opening, 'unavailable');
    assert.equal(s.status().rooms, 0);
    assert.equal(routers.length, 1);
    assert.equal(routers[0].closed, true);
  } finally {
    await s.stop();
  }
});

test('a force-mute landing while produce(audio) is in flight leaves the producer paused', async () => {
  const muted = new Set();
  const { s } = await setup(45228, { muted });
  try {
    const { rtpCapabilities } = await req(s, 1, 'caps');
    const transportId = await sendTransport(s, 1);
    const t = s.peerOf('room', 1).transports.get(transportId);
    const orig = t.produce.bind(t);
    t.produce = async (opts) => {
      muted.add(1);
      await s.setMuted('room', 1, true);
      return orig(opts);
    };
    const { producerId } = await req(s, 1, 'produce', { transportId, kind: 'audio', media: 'audio', rtpParameters: rtp(rtpCapabilities, 'audio/opus', 4242) });
    assert.equal(s.peerOf('room', 1).producers.get(producerId).paused, true);
  } finally {
    await s.stop();
  }
});

test('report_failure increments connectFailures', async () => {
  const { s } = await setup(45224);
  try {
    assert.equal(s.status().connectFailures, 0);
    assert.equal(s.status().lastConnectFailureAt, null);
    const before = Date.now();
    assert.deepEqual(await req(s, 1, 'report_failure', { direction: 'recv' }), {});
    assert.ok(s.status().lastConnectFailureAt >= before);
    await rejectsWith(req(s, 1, 'report_failure', { direction: 'up' }), 'bad_request');
    assert.equal(s.status().connectFailures, 1);
    const st = await s.stats();
    assert.equal(st.rooms, 1);
    assert.equal(typeof st.bytesIn, 'number');
  } finally {
    await s.stop();
  }
});

test('a dead worker resets the room: reset event to its peers and onReset forwarded', async () => {
  const workers = [];
  const onNew = (w) => workers.push(w);
  mediasoup.observer.on('newworker', onNew);
  const { s, events } = await setup(45225);
  mediasoup.observer.off('newworker', onNew);
  try {
    await req(s, 1, 'caps');
    await req(s, 2, 'caps');
    const resets = [];
    const done = new Promise((resolve) => s.onReset((key, ids) => { resets.push([key, ids]); resolve(); }));
    process.kill(workers[0].pid, 'SIGKILL');
    await done;
    assert.deepEqual(resets, [['room', [1, 2]]]);
    assert.deepEqual(events.filter(([, e]) => e.event === 'reset'), [[1, { event: 'reset' }, 'room'], [2, { event: 'reset' }, 'room']]);
    await rejectsWith(req(s, 1, 'caps'), 'unavailable');
    await s.openRoom('room');
    assert.ok((await req(s, 1, 'caps')).rtpCapabilities);
  } finally {
    await s.stop();
  }
});

test('effectiveMode caches the configured mode until refreshMode or start', async () => {
  const cfg = conf(45230, {}, 'mesh');
  let loads = 0;
  const s = createSfu({ load: () => { loads++; return cfg; }, probe: () => ({ ok: true }) });
  try {
    for (let i = 0; i < 5; i++) s.effectiveMode();
    assert.equal(loads, 1);
    cfg.voice.mode = 'sfu';
    assert.equal(s.effectiveMode(), 'mesh');
    assert.equal(loads, 1);
    s.refreshMode();
    assert.equal(loads, 2);
    await s.start(null, { isParticipant: () => true });
    assert.equal(s.effectiveMode(), 'sfu');
    await s.openRoom('room');
    const after = loads;
    for (const uid of [1, 2, 3]) await req(s, uid, 'caps');
    await req(s, 1, 'create_transport', { direction: 'send' });
    assert.equal(loads, after, 'new peers and requests do not reload the config');
    cfg.voice.sfu.maxKbpsPerUser = 1000;
    assert.equal((await req(s, 4, 'caps')).limits.camera, 1500);
    s.refreshMode();
    assert.equal((await req(s, 5, 'caps')).limits.camera, 1000);
  } finally {
    await s.stop();
  }
});

test('announced() reports a LAN fallback and status exposes what the pool started with', async () => {
  const cfg = conf(45231, { announcedHost: '' });
  const s = createSfu({ load: () => cfg, probe: () => ({ ok: true }) });
  try {
    assert.equal(s.announced().isLan, true);
    cfg.voice.sfu.announcedHost = 'v.example.com';
    assert.deepEqual(s.announced(), { host: 'v.example.com', isLan: false });
    assert.equal(s.status().startedWith, null);
    await s.start(null, {});
    assert.deepEqual(s.status().startedWith, { port: 45231, workers: 1, announcedHost: 'v.example.com', enableTcp: false, resolvedHost: 'v.example.com', resolvedIsLan: false });
  } finally {
    await s.stop();
  }
  assert.equal(s.status().startedWith, null);
});

test('a second consume of the same producer by the same peer gets limit', async () => {
  const { s } = await setup(45229);
  try {
    const { producerId, rtpCapabilities } = await produceAudio(s, 1);
    await req(s, 2, 'create_transport', { direction: 'recv' });
    await req(s, 2, 'consume', { producerId, rtpCapabilities });
    await rejectsWith(req(s, 2, 'consume', { producerId, rtpCapabilities }), 'limit');
    assert.equal(s.peerOf('room', 2).consumers.size, 1);
    await req(s, 3, 'create_transport', { direction: 'recv' });
    assert.ok((await req(s, 3, 'consume', { producerId, rtpCapabilities })).consumerId);
  } finally {
    await s.stop();
  }
});

test('effectiveMode is mesh once every worker of the running pool is gone', async () => {
  const workers = [];
  const onNew = (w) => workers.push(w);
  mediasoup.observer.on('newworker', onNew);
  const s = createSfu({ load: () => conf(45232), probe: () => ({ ok: true }) });
  try {
    await s.start(null, {});
    mediasoup.observer.off('newworker', onNew);
    assert.equal(s.effectiveMode(), 'sfu');
    for (const w of workers) w.close();
    assert.equal(s.effectiveMode(), 'mesh');
  } finally {
    mediasoup.observer.off('newworker', onNew);
    await s.stop();
  }
});
