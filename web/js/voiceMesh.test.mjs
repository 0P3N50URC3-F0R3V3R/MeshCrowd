import test from 'node:test';
import assert from 'node:assert/strict';
import { createMeshEngine } from './voiceMesh.js';

class FakePC {
  constructor(config) {
    this.config = config;
    this.senders = [];
    this.closed = false;
    this.signalingState = 'stable';
    this.localDescription = null;
    this.remoteDescription = null;
  }
  getTransceivers() { return []; }
  getSenders() { return this.senders; }
  addTrack(track) { const s = { track, replaceTrack: async (t) => { s.track = t; } }; this.senders.push(s); return s; }
  removeTrack(sender) { this.senders = this.senders.filter((s) => s !== sender); }
  async createOffer() { return { type: 'offer', sdp: 'v=0\r\n' }; }
  async createAnswer() { return { type: 'answer', sdp: 'v=0\r\n' }; }
  async setLocalDescription(d) { this.localDescription = d; this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable'; }
  async setRemoteDescription(d) { this.remoteDescription = d; this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable'; }
  async addIceCandidate() {}
  async getStats() { return new Map(); }
  close() { this.closed = true; }
}
globalThis.RTCPeerConnection = FakePC;
globalThis.MediaStream = class { constructor(tracks) { this.tracks = tracks; } };

function makeCtx(me = 2) {
  const sent = [];
  const events = [];
  const ctx = {
    me,
    ws: { send: (m) => sent.push(m) },
    scopePayload: () => ({ channelId: 7 }),
    getIceConfig: async () => ({ servers: [], lanNetworks: [] }),
    quality: () => 'medium',
    hooks: {
      attachAudio: (id) => events.push(['attachAudio', id]),
      attachVideo: (id, media) => events.push(['attachVideo', id, media]),
      detachVideo: (id, media) => events.push(['detachVideo', id, media]),
      closeRemote: (id) => events.push(['closeRemote', id]),
      onPath: (id, path) => events.push(['onPath', id, path]),
    },
  };
  return { ctx, sent, events };
}

const settle = () => new Promise((r) => setTimeout(r, 10));
const offersTo = (sent) => sent.filter((m) => m.type === 'voice_signal' && m.signal.kind === 'offer').map((m) => m.toUserId).sort();

test('createMeshEngine exposes the engine interface', () => {
  const engine = createMeshEngine(makeCtx().ctx);
  for (const fn of ['start', 'stop', 'setLocalTrack', 'onRoster', 'handleSignal', 'pollStats']) {
    assert.equal(typeof engine[fn], 'function', fn);
  }
  assert.ok(engine.start() instanceof Promise);
  assert.ok(engine.pollStats() instanceof Promise);
});

// Rule found in views/voice.js applyRoster: the newcomer offers. On the roster update where my
// own id first appears, I offer to every other member regardless of id; on any later update a
// new arrival is someone else joining, so I wait for their offer and send none.
test('onRoster with a new user id starts an offer toward only the users the current initiator rule says', async () => {
  const { ctx, sent } = makeCtx(2);
  const engine = createMeshEngine(ctx);
  engine.onRoster([1, 3]);
  await settle();
  assert.deepEqual(offersTo(sent), [], 'not in the room yet: no offers');

  engine.onRoster([1, 2, 3]);
  await settle();
  assert.deepEqual(offersTo(sent), [1, 3], 'my join lands: offer to everyone already there');
  assert.ok(sent.every((m) => m.channelId === 7));

  sent.length = 0;
  engine.onRoster([1, 2, 3, 4]);
  await settle();
  assert.deepEqual(offersTo(sent), [], 'a later arrival offers to me, not the other way round');
});

test('onRoster closes peers that left and reports closeRemote', async () => {
  const { ctx, events } = makeCtx(2);
  const engine = createMeshEngine(ctx);
  engine.onRoster([1, 2, 3]);
  await settle();
  engine.onRoster([2, 3]);
  assert.deepEqual(events.filter((e) => e[0] === 'closeRemote'), [['closeRemote', 1]]);
});

test('an incoming offer from a new peer is answered and reported by pollStats', async () => {
  const { ctx, sent } = makeCtx(2);
  const engine = createMeshEngine(ctx);
  const track = { kind: 'audio', id: 'a1' };
  await engine.setLocalTrack('audio', track);
  engine.onRoster([2]);
  await engine.handleSignal(5, { kind: 'offer', sdp: 'v=0\r\n' });
  const answer = sent.find((m) => m.signal.kind === 'answer');
  assert.equal(answer.toUserId, 5);
  const stats = await engine.pollStats();
  assert.ok(stats.has(5));
  assert.equal(stats.get(5).quality, 'good');
});

test('setLocalTrack camera on/off announces and renegotiates with every peer', async () => {
  const { ctx, sent } = makeCtx(2);
  const engine = createMeshEngine(ctx);
  engine.onRoster([1, 2]);
  await settle();
  sent.length = 0;
  const cam = { kind: 'video', id: 'c1' };
  await engine.setLocalTrack('camera', cam);
  assert.deepEqual(sent.map((m) => m.signal.kind), ['media-announce', 'offer']);
  assert.equal(sent[0].signal.active, true);
  sent.length = 0;
  await engine.setLocalTrack('camera', null);
  assert.deepEqual(sent.map((m) => [m.signal.kind, m.signal.active]), [['media-announce', false], ['offer', undefined]]);
});

test('no peer connection is created after stop while the ICE config was loading', async () => {
  const { ctx, sent } = makeCtx(2);
  const waiting = [];
  const release = () => { for (const r of waiting) r({ servers: [], lanNetworks: [] }); };
  ctx.getIceConfig = () => new Promise((r) => { waiting.push(r); });
  let created = 0;
  const Orig = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = class extends Orig { constructor(c) { super(c); created++; } };
  try {
    const engine = createMeshEngine(ctx);
    engine.onRoster([1, 2]);
    const answering = engine.handleSignal(3, { kind: 'offer', sdp: 'v=0\r\n' });
    engine.stop();
    release();
    await answering;
    await settle();
    assert.equal(created, 0);
    assert.deepEqual(sent, []);
    assert.equal((await engine.pollStats()).size, 0);
  } finally {
    globalThis.RTCPeerConnection = Orig;
  }
});

test('stop closes every peer', async () => {
  const { ctx, events } = makeCtx(2);
  const engine = createMeshEngine(ctx);
  engine.onRoster([1, 2, 3]);
  await settle();
  engine.stop();
  assert.deepEqual(events.filter((e) => e[0] === 'closeRemote').map((e) => e[1]).sort(), [1, 3]);
  assert.equal((await engine.pollStats()).size, 0);
});
