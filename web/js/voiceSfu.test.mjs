import test from 'node:test';
import assert from 'node:assert/strict';
import { createSfuEngine, createConnectRetry } from './voiceSfu.js';

globalThis.MediaStream = class { constructor(tracks) { this.tracks = tracks; } };

class Emitter {
  constructor() { this.handlers = new Map(); }
  on(name, fn) { this.handlers.set(name, fn); }
  emit(name, ...args) { return this.handlers.get(name)?.(...args); }
}

class FakeTransport extends Emitter {
  constructor(direction, opts, world) {
    super();
    this.direction = direction;
    this.id = opts.id;
    this.world = world;
    this.closed = false;
    this.connected = false;
    this.connectionState = 'new';
  }
  async ensureConnected() {
    if (this.connected) return;
    this.connected = true;
    this.connectionState = 'connecting';
    await new Promise((resolve, reject) => this.emit('connect', { dtlsParameters: { fingerprints: [] } }, resolve, reject));
  }
  async produce(opts) {
    if (this.closed) throw new Error('closed');
    await this.ensureConnected();
    this.world.produced.push(opts);
    const { id } = await new Promise((resolve, reject) => this.emit('produce', { kind: opts.track.kind, rtpParameters: { codecs: [] }, appData: opts.appData }, resolve, reject));
    const p = {
      id, track: opts.track, paused: false, closed: false,
      pause() { this.paused = true; }, resume() { this.paused = false; }, close() { this.closed = true; },
      async replaceTrack({ track }) { this.track = track; },
    };
    this.world.producers.push(p);
    return p;
  }
  async consume({ id, producerId, kind, appData }) {
    if (this.closed) throw new Error('closed');
    await this.ensureConnected();
    const c = {
      id, producerId, kind, appData, closed: false, track: { kind, id: `t-${producerId}` },
      close() { this.closed = true; },
      async getStats() {
        return new Map([['r', { type: 'inbound-rtp', kind: 'audio', packetsLost: 0, packetsReceived: 100, jitter: 0.001 }]]);
      },
    };
    this.world.consumers.push(c);
    return c;
  }
  setState(state) { this.connectionState = state; this.emit('connectionstatechange', state); }
  close() { this.closed = true; }
}

class SfuError extends Error {
  constructor(code) { super(code); this.code = code; }
}

// A fake server answering sfu_request messages through engine.handleResponse; `reply` overrides ops.
function setup({ producers = [], reply = {}, connectTimeoutMs, healthyMs, quality = 'high', hooks = {} } = {}) {
  const world = { log: [], sent: [], events: [], transports: {}, produced: [], producers: [], consumers: [], devices: 0 };
  let engine;
  let nextProducer = 1;
  const defaults = {
    caps: () => ({ rtpCapabilities: { tag: 'router' }, limits: { audio: 32, camera: 1500, screen: 3500 } }),
    create_transport: ({ direction }) => ({ id: `${direction}-t`, iceParameters: {}, iceCandidates: [], dtlsParameters: {} }),
    produce: () => ({ producerId: `p${nextProducer++}` }),
    list_producers: () => producers,
    consume: ({ producerId }) => {
      const p = producers.find((x) => x.producerId === producerId) || { producerId, userId: 9, media: 'audio', kind: 'audio' };
      return { consumerId: `c-${producerId}`, producerId, kind: p.kind, rtpParameters: { codecs: [] }, userId: p.userId, media: p.media };
    },
  };
  const log = (...e) => world.log.push(e.join(':'));
  const ctx = {
    me: 1,
    scopePayload: () => ({ channelId: 7 }),
    quality: () => quality,
    connectTimeoutMs,
    healthyMs,
    loadDevice: async () => {
      log('loadDevice');
      world.devices++;
      return {
        rtpCapabilities: { codecs: [] },
        async load({ routerRtpCapabilities }) { log('load', routerRtpCapabilities.tag); },
        createSendTransport(opts) { return (world.transports.send = new FakeTransport('send', opts, world)); },
        createRecvTransport(opts) { return (world.transports.recv = new FakeTransport('recv', opts, world)); },
      };
    },
    ws: {
      send: (m) => {
        world.sent.push(m);
        log('rpc', m.op);
        const handler = reply[m.op] || defaults[m.op] || (() => ({}));
        queueMicrotask(() => {
          let res;
          try { res = { id: m.id, ok: true, data: handler(m.data) }; } catch (err) { res = { id: m.id, ok: false, error: err.code || 'internal' }; }
          if (res.data !== undefined || !res.ok) engine.handleResponse({ type: 'sfu_response', ...res });
        });
      },
    },
    hooks: {
      attachAudio: (id, stream) => { world.events.push(['attachAudio', id]); log('attachAudio', id, stream.tracks.length); },
      attachVideo: (id, media) => world.events.push(['attachVideo', id, media]),
      detachVideo: (id, media) => world.events.push(['detachVideo', id, media]),
      closeRemote: (id) => world.events.push(['closeRemote', id]),
      onPath: () => {},
      onConnectFailed: (dir) => world.events.push(['connectFailed', dir]),
      onReset: () => world.events.push(['reset']),
      onHealthy: () => world.events.push(['healthy']),
      ...hooks,
    },
  };
  engine = createSfuEngine(ctx);
  return { engine, world };
}

const settle = () => new Promise((r) => setTimeout(r, 15));
const opsSent = (world, op) => world.sent.filter((m) => m.op === op);

test('createSfuEngine exposes the engine interface', () => {
  const { engine } = setup();
  for (const fn of ['start', 'stop', 'setLocalTrack', 'onRoster', 'handleSignal', 'pollStats', 'handleEvent', 'handleResponse']) {
    assert.equal(typeof engine[fn], 'function', fn);
  }
});

test('start: caps -> load -> transports -> list_producers -> consume -> resume_consumer after attach', async () => {
  const { engine, world } = setup({ producers: [{ producerId: 'x1', userId: 5, media: 'audio', kind: 'audio' }] });
  await engine.start();
  await settle();
  const order = ['rpc:caps', 'loadDevice', 'load:router', 'rpc:create_transport', 'rpc:create_transport', 'rpc:list_producers', 'rpc:consume', 'attachAudio:5:1', 'rpc:resume_consumer'];
  let at = -1;
  for (const step of order) {
    const i = world.log.indexOf(step, at + 1);
    assert.ok(i > at, `${step} in order: ${world.log.join(', ')}`);
    at = i;
  }
  assert.deepEqual(opsSent(world, 'create_transport').map((m) => m.data.direction), ['send', 'recv']);
  assert.ok(world.sent.every((m) => m.type === 'sfu_request' && m.channelId === 7 && typeof m.id === 'number'));
  assert.deepEqual(opsSent(world, 'connect_transport').map((m) => m.data.transportId), ['recv-t']);
  assert.deepEqual(opsSent(world, 'resume_consumer')[0].data, { consumerId: 'c-x1' });
  assert.deepEqual(world.events, [['attachAudio', 5]]);
});

test('audio is produced with DTX, FEC, ptime 20 and the preset bitrate capped by the server limit', async () => {
  const { engine, world } = setup({ quality: 'high' });
  engine.setLocalTrack('audio', { kind: 'audio', id: 'mic' });
  await engine.start();
  await settle();
  assert.equal(world.produced.length, 1);
  const o = world.produced[0];
  assert.equal(o.stopTracks, false);
  assert.deepEqual(o.appData, { media: 'audio' });
  assert.equal(o.codecOptions.opusDtx, true);
  assert.equal(o.codecOptions.opusFec, true);
  assert.equal(o.codecOptions.opusPtime, 20);
  assert.equal(o.codecOptions.opusMaxAverageBitrate, 32000, 'high preset 96 kbps capped to the 32 kbps limit');
  assert.equal(o.encodings[0].maxBitrate, 32000);
  const req = opsSent(world, 'produce')[0].data;
  assert.equal(req.media, 'audio');
  assert.equal(req.transportId, 'send-t');
});

test('camera uses the camera limit; turning it off closes the producer', async () => {
  const { engine, world } = setup();
  await engine.start();
  await engine.setLocalTrack('camera', { kind: 'video', id: 'cam' });
  assert.equal(world.produced[0].encodings[0].maxBitrate, 1_500_000);
  assert.equal(opsSent(world, 'produce')[0].data.media, 'camera');
  await engine.setLocalTrack('camera', { kind: 'video', id: 'cam2' });
  assert.equal(world.producers[0].track.id, 'cam2', 'a camera flip replaces the track');
  assert.equal(world.produced.length, 1);
  await engine.setLocalTrack('camera', null);
  assert.equal(world.producers[0].closed, true);
  assert.deepEqual(opsSent(world, 'close_producer')[0].data, { producerId: world.producers[0].id });
});

test('new_producer consumes and attaches video; producer_closed detaches and closes the remote', async () => {
  const { engine, world } = setup({ producers: [
    { producerId: 'a', userId: 5, media: 'audio', kind: 'audio' },
    { producerId: 'v', userId: 5, media: 'camera', kind: 'video' },
  ] });
  world.sent.length = 0;
  await engine.start();
  await settle();
  world.events.length = 0;
  engine.handleEvent({ event: 'producer_closed', producerId: 'v', userId: 5, media: 'camera' });
  assert.deepEqual(world.events, [['detachVideo', 5, 'camera']]);
  engine.handleEvent({ event: 'producer_closed', producerId: 'a', userId: 5, media: 'audio' });
  assert.deepEqual(world.events.at(-1), ['closeRemote', 5]);
  assert.ok(world.consumers.every((c) => c.closed));
});

test('new_producer after start is consumed once', async () => {
  const { engine, world } = setup();
  await engine.start();
  engine.handleEvent({ event: 'new_producer', producerId: 'n1', userId: 9, media: 'audio', kind: 'audio' });
  engine.handleEvent({ event: 'new_producer', producerId: 'n1', userId: 9, media: 'audio', kind: 'audio' });
  await settle();
  assert.equal(opsSent(world, 'consume').length, 1);
  assert.deepEqual(world.events, [['attachAudio', 9]]);
});

test('new_producer that arrives during start is consumed once start is ready', async () => {
  const { engine, world } = setup();
  const started = engine.start();
  engine.handleEvent({ event: 'new_producer', producerId: 'early', userId: 4, media: 'audio', kind: 'audio' });
  await started;
  await settle();
  assert.equal(opsSent(world, 'consume').length, 1);
  assert.deepEqual(world.events, [['attachAudio', 9]], 'consume reply names the owner');
});

test('produce refused with muted is not fatal and retryAudio produces again', async () => {
  let refuse = true;
  const { engine, world } = setup({ reply: { produce: () => { if (refuse) throw new SfuError('muted'); return { producerId: 'pa' }; } } });
  engine.setLocalTrack('audio', { kind: 'audio', id: 'mic' });
  await engine.start();
  await settle();
  assert.equal(engine.audioRefused, true);
  assert.equal(engine.stopped, false);
  assert.deepEqual(world.events, []);
  refuse = false;
  await engine.retryAudio();
  assert.equal(engine.audioRefused, false);
  assert.equal(world.producers.length, 1);
  assert.equal(world.producers[0].id, 'pa');
  await engine.retryAudio();
  assert.equal(opsSent(world, 'produce').length, 2, 'no second producer once audio is up');
});

test('setAudioPaused pauses and resumes the audio producer on both ends', async () => {
  const { engine, world } = setup();
  engine.setAudioPaused(true);
  engine.setLocalTrack('audio', { kind: 'audio', id: 'mic' });
  await engine.start();
  await settle();
  assert.equal(world.producers[0].paused, true, 'produced while muted starts paused');
  assert.equal(opsSent(world, 'pause_producer').length, 1);
  engine.setAudioPaused(false);
  engine.setAudioPaused(false);
  assert.equal(world.producers[0].paused, false);
  assert.equal(opsSent(world, 'resume_producer').length, 1);
});

test('reset stops the engine and asks the view to rejoin', async () => {
  const { engine, world } = setup({ producers: [{ producerId: 'a', userId: 5, media: 'audio', kind: 'audio' }] });
  engine.setLocalTrack('audio', { kind: 'audio', id: 'mic' });
  await engine.start();
  await settle();
  engine.handleEvent({ event: 'reset' });
  assert.equal(engine.stopped, true);
  assert.deepEqual(world.events.slice(-2), [['closeRemote', 5], ['reset']]);
  assert.ok(world.transports.send.closed && world.transports.recv.closed);
  assert.ok(world.producers.every((p) => p.closed));
});

test('stop is idempotent and nothing is created after stop', async () => {
  const { engine, world } = setup();
  engine.setLocalTrack('audio', { kind: 'audio', id: 'mic' });
  const started = engine.start();
  engine.stop();
  engine.stop();
  await started;
  await settle();
  assert.equal(world.devices, 0, 'the caps reply was dropped, no device loaded');
  engine.handleEvent({ event: 'new_producer', producerId: 'late', userId: 3, media: 'audio', kind: 'audio' });
  await engine.setLocalTrack('camera', { kind: 'video', id: 'cam' });
  await settle();
  assert.equal(world.consumers.length, 0);
  assert.equal(world.produced.length, 0);
  assert.equal(world.transports.send, undefined);
  assert.equal((await engine.pollStats()).size, 0);
});

test('stop while transports are being created leaves no live transport', async () => {
  const { engine, world } = setup({ reply: {
    create_transport: ({ direction }) => (direction === 'send' ? { id: 'send-t', iceParameters: {}, iceCandidates: [], dtlsParameters: {} } : undefined),
  } });
  const started = engine.start();
  await settle();
  assert.ok(world.transports.send, 'send transport exists, recv reply still pending');
  engine.stop();
  await started;
  await settle();
  assert.equal(world.transports.send.closed, true);
  assert.equal(world.transports.recv, undefined);
});

test('a transport that fails reports the failure once and tells the view', async () => {
  const { engine, world } = setup({ producers: [{ producerId: 'a', userId: 5, media: 'audio', kind: 'audio' }] });
  await engine.start();
  await settle();
  world.transports.recv.setState('failed');
  world.transports.recv.setState('failed');
  await settle();
  assert.deepEqual(opsSent(world, 'report_failure').map((m) => m.data), [{ direction: 'recv' }]);
  assert.deepEqual(world.events.filter((e) => e[0] === 'connectFailed'), [['connectFailed', 'recv']]);
});

test('a transport that does not connect within the timeout counts as failed', async () => {
  const { engine, world } = setup({ connectTimeoutMs: 20, producers: [{ producerId: 'a', userId: 5, media: 'audio', kind: 'audio' }] });
  await engine.start();
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(world.events.filter((e) => e[0] === 'connectFailed'), [['connectFailed', 'recv']]);
  engine.stop();
});

test('a connected transport does not time out', async () => {
  const { engine, world } = setup({ connectTimeoutMs: 20, producers: [{ producerId: 'a', userId: 5, media: 'audio', kind: 'audio' }] });
  await engine.start();
  await settle();
  world.transports.recv.setState('connected');
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(world.events.filter((e) => e[0] === 'connectFailed'), []);
  engine.stop();
});

test('pollStats reports the mesh quality labels with path sfu', async () => {
  const { engine } = setup({ producers: [{ producerId: 'a', userId: 5, media: 'audio', kind: 'audio' }] });
  await engine.start();
  await settle();
  const stats = await engine.pollStats();
  assert.deepEqual(stats.get(5), { quality: 'good', path: 'sfu' });
  engine.stop();
});

// Mirrors views/voice.js: every failure goes through one retry budget shared across engine
// rebuilds, and only onHealthy restores it.
test('send connects but recv keeps failing: one retry, then give up, never a loop', async () => {
  const log = [];
  let cycles = 0;
  let current;
  const producers = [{ producerId: 'a', userId: 5, media: 'audio', kind: 'audio' }];
  const retry = createConnectRetry({
    onRetry: () => { log.push('retry'); cycle(); },
    onGiveUp: () => { log.push('giveUp'); current.engine.stop(); },
  });
  async function cycle() {
    if (++cycles > 5) return;
    current = setup({ producers, connectTimeoutMs: 20, healthyMs: 30, hooks: {
      onConnectFailed: (dir) => { log.push(`failed:${dir}`); current.engine.stop(); retry.failed(dir); },
      onHealthy: () => retry.healthy(),
    } });
    current.engine.setLocalTrack('audio', { kind: 'audio', id: 'mic' });
    await current.engine.start();
    await settle();
    current.world.transports.send.setState('connected');
  }
  await cycle();
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(log, ['failed:recv', 'retry', 'failed:recv', 'giveUp']);
  assert.equal(cycles, 2);
});

test('an engine whose started transports all stay connected reports healthy, which restores the retry', async () => {
  const { engine, world } = setup({ healthyMs: 20, producers: [{ producerId: 'a', userId: 5, media: 'audio', kind: 'audio' }] });
  engine.setLocalTrack('audio', { kind: 'audio', id: 'mic' });
  await engine.start();
  await settle();
  world.transports.send.setState('connected');
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(world.events.filter((e) => e[0] === 'healthy'), [], 'recv not connected yet');
  world.transports.recv.setState('connected');
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(world.events.filter((e) => e[0] === 'healthy'), [['healthy']]);
  engine.stop();

  const calls = [];
  const retry = createConnectRetry({ onRetry: () => calls.push('retry'), onGiveUp: () => calls.push('giveUp') });
  retry.failed('recv');
  retry.healthy();
  retry.failed('recv');
  retry.failed('recv');
  assert.deepEqual(calls, ['retry', 'retry', 'giveUp']);
});

test('a resume refused while muted is resumed on the server after re-promotion', async () => {
  const srv = { muted: false, clientPaused: false, serverPaused: false };
  const { engine, world } = setup({ reply: {
    produce: () => ({ producerId: 'pa' }),
    pause_producer: () => { srv.clientPaused = true; srv.serverPaused = true; return {}; },
    resume_producer: () => {
      if (srv.muted) throw new SfuError('muted');
      srv.clientPaused = false; srv.serverPaused = false; return {};
    },
  } });
  const setMuted = (on) => { srv.muted = on; if (on) srv.serverPaused = true; else if (!srv.clientPaused) srv.serverPaused = false; };
  engine.setLocalTrack('audio', { kind: 'audio', id: 'mic' });
  await engine.start();
  await settle();
  const p = world.producers[0];

  setMuted(true); // speaker moved to the audience
  engine.setAudioPaused(true); // deafen
  await settle();
  engine.setAudioPaused(false); // undeafen: refused with 'muted'
  await settle();
  assert.equal(p.paused, true, 'refused resume leaves the producer paused locally');
  assert.equal(srv.serverPaused, true);

  setMuted(false); // re-promoted: server skips the resume because the client paused it
  assert.equal(srv.serverPaused, true);
  await engine.retryAudio();
  await settle();
  assert.equal(srv.serverPaused, false, 'resumed on the server');
  assert.equal(p.paused, false);
  assert.equal(opsSent(world, 'produce').length, 1, 'no new producer');
  engine.stop();
});

test('a refused camera or screen producer is reported through onProduceFailed; a muted audio refusal is not', async () => {
  const failures = [];
  const { engine, world } = setup({
    hooks: { onProduceFailed: (media, code) => failures.push([media, code]) },
    reply: { produce: ({ media }) => { if (media === 'audio') throw new SfuError('muted'); throw new SfuError('limit'); } },
  });
  engine.setLocalTrack('audio', { kind: 'audio', id: 'mic' });
  await engine.start();
  await settle();
  await engine.setLocalTrack('camera', { kind: 'video', id: 'cam' });
  await engine.setLocalTrack('screen', { kind: 'video', id: 'scr' });
  assert.deepEqual(failures, [['camera', 'limit'], ['screen', 'limit']]);
  assert.equal(world.producers.length, 0);
  assert.equal(engine.stopped, false);
});
