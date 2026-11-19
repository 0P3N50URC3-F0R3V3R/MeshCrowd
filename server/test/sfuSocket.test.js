'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const mediasoup = require('mediasoup');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const { db } = require('../db');
const hub = require('../socket/hub');
const voice = require('../socket/voice');
const stage = require('../socket/stage');
const socket = require('../socket');
const { createSfu } = require('../lib/sfu');
const { createSfuSocket } = require('../socket/sfu');

let nextRoom = 96000;

function conf(port, mode = 'sfu') {
  return { turn: {}, voice: { mode, sfu: { port, workers: 1, announcedHost: '127.0.0.1', maxKbpsPerUser: 0, enableTcp: false } } };
}

async function setup(port, mode = 'sfu') {
  const cfg = conf(port, mode);
  const sfu = createSfu({ load: () => cfg, probe: () => ({ ok: true }) });
  const sent = [];
  const ss = createSfuSocket({ sfu, notifyUser: (uid, msg) => sent.push([uid, msg]) });
  await ss.start(null);
  return { cfg, sfu, ss, sent, room: nextRoom++ };
}

async function call(ss, uid, msg) {
  const out = [];
  const handled = await ss.handleSfuRequest({ id: uid }, { type: 'sfu_request', ...msg }, (m) => out.push(m));
  assert.equal(handled, true);
  return out;
}

async function ok(ss, uid, room, op, data) {
  const [res] = await call(ss, uid, { id: `${op}-${uid}`, channelId: room, op, data });
  assert.equal(res.ok, true, `${op} failed: ${res.error}`);
  return res.data;
}

function rtp(caps, ssrc) {
  const c = caps.codecs.find((x) => x.mimeType === 'audio/opus');
  return {
    mid: String(ssrc),
    codecs: [{ mimeType: 'audio/opus', payloadType: c.preferredPayloadType, clockRate: c.clockRate, channels: c.channels, parameters: {}, rtcpFeedback: [] }],
    encodings: [{ ssrc }],
    headerExtensions: [],
    rtcp: { cname: `u${ssrc}` },
  };
}

async function produceAudio(ss, uid, room) {
  const { rtpCapabilities } = await ok(ss, uid, room, 'caps');
  const { id: transportId } = await ok(ss, uid, room, 'create_transport', { direction: 'send' });
  const [res] = await call(ss, uid, { id: 'p', channelId: room, op: 'produce', data: { transportId, kind: 'audio', media: 'audio', rtpParameters: rtp(rtpCapabilities, 2000 + uid) } });
  return res;
}

const audioProducer = (sfu, room, uid) => [...sfu.peerOf(room, uid).producers.values()].find((p) => p.appData.media === 'audio');

async function cleanup(ss, sfu, room) {
  for (const uid of voice.participants(room)) voice.leave(room, uid);
  await sfu.stop();
}

test('voice_join to a new room with sfu mode fixes the room mode to sfu', async () => {
  const { sfu, ss, room } = await setup(45300);
  try {
    assert.deepEqual(await ss.join(room, 1, { sfu: true }), { ok: true });
    assert.equal(voice.modeOf(room), 'sfu');
    assert.equal(sfu.status().rooms, 1);
    assert.ok((await ok(ss, 1, room, 'caps')).rtpCapabilities);
  } finally {
    await cleanup(ss, sfu, room);
  }
});

test('joining an sfu room without sfu:true is denied with update_required', async () => {
  const { sfu, ss, room } = await setup(45301);
  try {
    await ss.join(room, 1, { sfu: true });
    assert.deepEqual(await ss.join(room, 2, {}), { ok: false, reason: 'update_required' });
    assert.equal(voice.isParticipant(room, 2), false);
    assert.equal(sfu.peerOf(room, 2), null);
    const fresh = nextRoom++;
    assert.deepEqual(await ss.join(fresh, 3, {}), { ok: false, reason: 'update_required' });
    assert.deepEqual(voice.participants(fresh), []);
    assert.equal(voice.modeOf(fresh), null);
  } finally {
    await cleanup(ss, sfu, room);
  }
});

test('joining a mesh room with sfu:true works and stays mesh', async () => {
  const { sfu, ss, room } = await setup(45302, 'mesh');
  try {
    assert.deepEqual(await ss.join(room, 1, { sfu: true }), { ok: true });
    assert.deepEqual(await ss.join(room, 2, {}), { ok: true });
    assert.equal(voice.modeOf(room), 'mesh');
    assert.equal(ss.roomMode(room), 'mesh');
    assert.equal(sfu.status().rooms, 0);
  } finally {
    await cleanup(ss, sfu, room);
  }
});

test('flipping config.voice.mode while a room is live does not change that room\'s mode', async () => {
  const { cfg, sfu, ss, room } = await setup(45303);
  const other = nextRoom++;
  try {
    await ss.join(room, 1, { sfu: true });
    cfg.voice.mode = 'mesh';
    sfu.refreshMode();
    assert.deepEqual(await ss.join(room, 2, { sfu: true }), { ok: true });
    assert.equal(voice.modeOf(room), 'sfu');
    assert.deepEqual(await ss.join(room, 3, {}), { ok: false, reason: 'update_required' });
    assert.deepEqual(await ss.join(other, 4, {}), { ok: true });
    assert.equal(voice.modeOf(other), 'mesh');
    cfg.voice.mode = 'sfu';
    voice.leave(other, 4);
    await ss.left([other], 4);
  } finally {
    await cleanup(ss, sfu, room);
  }
});

test('voice_state payloads carry mode', async () => {
  const mk = (n) => Number(db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)').run(n, `${n}@t.local`, 'h', n).lastInsertRowid);
  const a = mk('sfusock_a');
  const b = mk('sfusock_b');
  const captured = [];
  const origDm = hub.broadcastToDm;
  const origCh = hub.broadcastToChannel;
  hub.broadcastToDm = (id, payload) => captured.push(payload);
  hub.broadcastToChannel = (channel, payload) => captured.push(payload);
  const room = nextRoom++;
  try {
    voice.join(voice.dmRoomKey(4242), a, 'sfu');
    voice.join(room, b);
    socket.broadcastDmVoiceState(4242);
    socket.broadcastVoiceState({ id: room, server_id: 1 });
    assert.equal(captured[0].mode, 'sfu');
    assert.equal(captured[0].dmChannelId, 4242);
    assert.equal(captured[1].mode, 'mesh');
    assert.equal(captured[1].channelId, room);
  } finally {
    hub.broadcastToDm = origDm;
    hub.broadcastToChannel = origCh;
    voice.leave(voice.dmRoomKey(4242), a);
    voice.leave(room, b);
  }
});

test('force_mute pauses the target\'s audio producer and further produce(audio) returns muted', async () => {
  const { sfu, ss, sent, room } = await setup(45304);
  try {
    await ss.join(room, 1, { sfu: true });
    await ss.join(room, 2, { sfu: true });
    await ok(ss, 2, room, 'caps');
    const res = await produceAudio(ss, 1, room);
    assert.equal(res.ok, true);
    assert.ok(sent.some(([uid, m]) => uid === 2 && m.type === 'sfu_event' && m.channelId === room && m.event === 'new_producer' && m.userId === 1));
    voice.forceMute(room, 1);
    await ss.syncMute(room, 1);
    const p = audioProducer(sfu, room, 1);
    assert.equal(p.paused, true);
    await ok(ss, 1, room, 'close_producer', { producerId: p.id });
    const again = await call(ss, 1, { id: 'again', channelId: room, op: 'produce', data: { transportId: [...sfu.peerOf(room, 1).transports.keys()][0], kind: 'audio', media: 'audio', rtpParameters: rtp((await ok(ss, 1, room, 'caps')).rtpCapabilities, 3001) } });
    assert.deepEqual(again, [{ type: 'sfu_response', id: 'again', ok: false, error: 'muted' }]);
  } finally {
    await cleanup(ss, sfu, room);
  }
});

test('force_unmute resumes', async () => {
  const { sfu, ss, room } = await setup(45305);
  try {
    await ss.join(room, 1, { sfu: true });
    assert.equal((await produceAudio(ss, 1, room)).ok, true);
    voice.forceMute(room, 1);
    await ss.syncMute(room, 1);
    assert.equal(audioProducer(sfu, room, 1).paused, true);
    voice.forceUnmute(room, 1);
    await ss.syncMute(room, 1);
    assert.equal(audioProducer(sfu, room, 1).paused, false);
  } finally {
    await cleanup(ss, sfu, room);
  }
});

test('stage audience produce(audio) returns muted', async () => {
  const { sfu, ss, room } = await setup(45306);
  try {
    await ss.join(room, 1, { sfu: true, stage: true });
    stage.onJoin(room, 1, true);
    await ss.join(room, 2, { sfu: true, stage: true });
    stage.onJoin(room, 2, false);
    assert.equal((await produceAudio(ss, 1, room)).ok, true);
    assert.deepEqual(await produceAudio(ss, 2, room), { type: 'sfu_response', id: 'p', ok: false, error: 'muted' });
    stage.inviteSpeaker(room, 2);
    const transportId = [...sfu.peerOf(room, 2).transports.keys()][0];
    const caps = (await ok(ss, 2, room, 'caps')).rtpCapabilities;
    await ok(ss, 2, room, 'produce', { transportId, kind: 'audio', media: 'audio', rtpParameters: rtp(caps, 4002) });
    stage.moveToAudience(room, 2);
    await ss.syncMute(room, 2);
    assert.equal(audioProducer(sfu, room, 2).paused, true);
  } finally {
    stage.onLeave(room, 1);
    stage.onLeave(room, 2);
    await cleanup(ss, sfu, room);
  }
});

test('ws close for a participant closes their SFU peer (leaveAll path)', async () => {
  const { sfu, ss, room } = await setup(45307);
  try {
    await ss.join(room, 1, { sfu: true });
    await ss.join(room, 2, { sfu: true });
    await ok(ss, 1, room, 'caps');
    await ok(ss, 2, room, 'caps');
    const peer = sfu.peerOf(room, 1);
    await ss.left(voice.leaveAll(1), 1);
    assert.equal(peer.closed, true);
    assert.equal(sfu.peerOf(room, 1), null);
    assert.equal(sfu.status().rooms, 1);
    await ss.left(voice.leaveAll(2), 2);
    assert.equal(sfu.status().rooms, 0);
    assert.equal(voice.modeOf(room), null);
  } finally {
    await cleanup(ss, sfu, room);
  }
});

test('sfu_request with an unknown op replies bad_request', async () => {
  const { sfu, ss, room } = await setup(45308);
  try {
    await ss.join(room, 1, { sfu: true });
    assert.deepEqual(await call(ss, 1, { id: 7, channelId: room, op: 'nope' }), [{ type: 'sfu_response', id: 7, ok: false, error: 'bad_request' }]);
    assert.deepEqual(await call(ss, 1, { channelId: room, op: 'caps' }), []);
    assert.deepEqual(await call(ss, 1, { id: { x: 1 }, channelId: room, op: 'caps' }), []);
    assert.deepEqual(await call(ss, 1, { id: 'x'.repeat(65), channelId: room, op: 'caps' }), []);
    assert.deepEqual(await call(ss, 9, { id: 8, channelId: room, op: 'caps' }), [{ type: 'sfu_response', id: 8, ok: false, error: 'not_participant' }]);
    const [bad] = await call(ss, 1, { id: 9, channelId: room, op: 'connect_transport', data: { transportId: 'x', dtlsParameters: { role: 'auto', fingerprints: [{ algorithm: 'sha-256', value: 'AA' }] } } });
    assert.deepEqual(Object.keys(bad).sort(), ['error', 'id', 'ok', 'type']);
    assert.equal(await ss.handleSfuRequest({ id: 1 }, { type: 'voice_join' }, () => {}), false);
  } finally {
    await cleanup(ss, sfu, room);
  }
});

test('a user already in one voice room gets voice_join_denied for a second room and holds no SFU peer in the second', async () => {
  const { sfu, ss, room } = await setup(45309);
  const second = nextRoom++;
  try {
    await ss.join(room, 1, { sfu: true });
    await ss.join(second, 2, { sfu: true });
    assert.deepEqual(await ss.join(second, 1, { sfu: true }), { ok: false });
    assert.equal(voice.isParticipant(second, 1), false);
    assert.deepEqual(await call(ss, 1, { id: 1, channelId: second, op: 'caps' }), [{ type: 'sfu_response', id: 1, ok: false, error: 'not_participant' }]);
    assert.equal(sfu.peerOf(second, 1), null);
  } finally {
    await cleanup(ss, sfu, second);
    voice.leave(room, 1);
  }
});

test('report_failure increments connectFailures', async () => {
  const { sfu, ss, room } = await setup(45310);
  try {
    await ss.join(room, 1, { sfu: true });
    assert.equal(sfu.status().connectFailures, 0);
    await ok(ss, 1, room, 'report_failure', { direction: 'send' });
    assert.equal(sfu.status().connectFailures, 1);
  } finally {
    await cleanup(ss, sfu, room);
  }
});

test('sfu events and requests for a DM room use dmChannelId', async () => {
  const { sfu, ss, sent } = await setup(45311);
  const key = voice.dmRoomKey(5151);
  try {
    await ss.join(key, 1, { sfu: true });
    await ss.join(key, 2, { sfu: true });
    const [caps] = await call(ss, 2, { id: 1, dmChannelId: 5151, op: 'caps' });
    assert.equal(caps.ok, true);
    const { rtpCapabilities } = (await call(ss, 1, { id: 2, dmChannelId: 5151, op: 'caps' }))[0].data;
    const { id: transportId } = (await call(ss, 1, { id: 3, dmChannelId: 5151, op: 'create_transport', data: { direction: 'send' } }))[0].data;
    const [prod] = await call(ss, 1, { id: 4, dmChannelId: 5151, op: 'produce', data: { transportId, kind: 'audio', media: 'audio', rtpParameters: rtp(rtpCapabilities, 5001) } });
    assert.equal(prod.ok, true);
    const ev = sent.find(([uid, m]) => uid === 2 && m.event === 'new_producer');
    assert.equal(ev[1].dmChannelId, 5151);
    assert.equal(ev[1].channelId, undefined);
  } finally {
    await cleanup(ss, sfu, key);
  }
});

test('a dead worker evicts the room and sends reset to every participant', async () => {
  const workers = [];
  const onNew = (w) => workers.push(w);
  mediasoup.observer.on('newworker', onNew);
  const { sfu, ss, sent, room } = await setup(45312);
  mediasoup.observer.off('newworker', onNew);
  const mk = (n) => Number(db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)').run(n, `${n}@t.local`, 'h', n).lastInsertRowid);
  const u1 = mk('sfusock_reset1');
  const u2 = mk('sfusock_reset2');
  const origCh = hub.broadcastToChannel;
  try {
    await ss.join(room, u1, { sfu: true });
    await ss.join(room, u2, { sfu: true });
    await ok(ss, u1, room, 'caps');
    voice.forceMute(room, u2);
    const evicted = new Promise((resolve) => ss.onEvicted((key, ids) => resolve([key, ids])));
    process.kill(workers[0].pid, 'SIGKILL');
    const [key, ids] = await evicted;
    assert.equal(key, room);
    assert.deepEqual(ids.sort((a, b) => a - b), [u1, u2]);
    const resets = sent.filter(([, m]) => m.event === 'reset').map(([uid, m]) => [uid, m.channelId]).sort((a, b) => a[0] - b[0]);
    assert.deepEqual(resets, [[u1, room], [u2, room]]);
    assert.deepEqual(voice.participants(room), []);
    assert.equal(voice.modeOf(room), null);
    assert.deepEqual(await ss.join(room, u1, { sfu: true }), { ok: true });
    assert.ok((await ok(ss, u1, room, 'caps')).rtpCapabilities);
    assert.deepEqual(await ss.join(room, u2, { sfu: true }), { ok: true });
    assert.equal(voice.isForceMuted(room, u2), true);
    const captured = [];
    hub.broadcastToChannel = (channel, payload) => captured.push(payload);
    socket.broadcastVoiceState({ id: room, server_id: 1 });
    assert.equal(captured[0].participants.find((p) => p.id === u2).mutedByMod, true);
    assert.deepEqual(await produceAudio(ss, u2, room), { type: 'sfu_response', id: 'p', ok: false, error: 'muted' });
  } finally {
    hub.broadcastToChannel = origCh;
    await cleanup(ss, sfu, room);
  }
});

test('rejoining the same room from a new socket drops the stale SFU peer', async () => {
  const { sfu, ss, sent, room } = await setup(45313);
  try {
    await ss.join(room, 1, { sfu: true });
    await ss.join(room, 2, { sfu: true });
    await ok(ss, 2, room, 'caps');
    assert.equal((await produceAudio(ss, 1, room)).ok, true);
    const producerId = audioProducer(sfu, room, 1).id;
    const stale = sfu.peerOf(room, 1);

    assert.deepEqual(await ss.join(room, 1, { sfu: true, isOpen: () => false }), { ok: true });
    assert.equal(sfu.peerOf(room, 1), stale, 'a rejoin from a socket that already closed keeps the peer');

    sent.length = 0;
    assert.deepEqual(await ss.join(room, 1, { sfu: true }), { ok: true });
    assert.equal(stale.closed, true);
    assert.ok(sent.some(([uid, m]) => uid === 2 && m.event === 'producer_closed' && m.producerId === producerId));
    assert.ok((await ok(ss, 1, room, 'create_transport', { direction: 'send' })).id);
    assert.deepEqual(voice.participants(room).sort(), [1, 2]);
  } finally {
    await cleanup(ss, sfu, room);
  }
});

test('a fresh room falls back to mesh when the SFU room cannot open; an existing sfu room still denies', async () => {
  const { sfu, ss, room } = await setup(45314);
  const fresh = nextRoom++;
  const openRoom = sfu.openRoom;
  try {
    await ss.join(room, 1, { sfu: true });
    sfu.openRoom = async () => { throw new Error('router failed'); };
    assert.deepEqual(await ss.join(fresh, 3, { sfu: true }), { ok: true });
    assert.equal(voice.modeOf(fresh), 'mesh');
    assert.deepEqual(await ss.join(fresh, 4, {}), { ok: true });
    assert.deepEqual(await ss.join(room, 2, { sfu: true }), { ok: false, reason: 'sfu_unavailable' });
    assert.equal(voice.isParticipant(room, 2), false);
  } finally {
    sfu.openRoom = openRoom;
    for (const uid of voice.participants(fresh)) voice.leave(fresh, uid);
    await cleanup(ss, sfu, room);
  }
});
