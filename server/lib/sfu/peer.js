'use strict';

class SfuError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'SfuError';
    this.code = code;
  }
}

const DEFAULT_KBPS = { audio: 64, camera: 1500, screen: 3500 };
const MAX_CONSUMERS = 300;
const MEDIA_KIND = new Map([['audio', 'audio'], ['camera', 'video'], ['screen', 'video']]);
const OPS = new Set([
  'caps', 'create_transport', 'connect_transport', 'produce', 'close_producer', 'pause_producer',
  'resume_producer', 'list_producers', 'consume', 'resume_consumer', 'report_failure',
]);

function limitsFor(maxKbpsPerUser) {
  const max = maxKbpsPerUser > 0 ? maxKbpsPerUser : 0;
  const cap = (kbps) => (max ? Math.min(kbps, max) : kbps);
  const total = max || DEFAULT_KBPS.audio + DEFAULT_KBPS.camera + DEFAULT_KBPS.screen;
  return { audio: cap(DEFAULT_KBPS.audio), camera: cap(DEFAULT_KBPS.camera), screen: cap(DEFAULT_KBPS.screen), maxIncomingBitrate: total * 1000 };
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v, max = 64) => typeof v === 'string' && v.length > 0 && v.length <= max;
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const isList = (v, min, max, each = isObj) => Array.isArray(v) && v.length >= min && v.length <= max && v.every(each);
const optional = (v, ok) => v === undefined || ok(v);

function check(ok, what) {
  if (!ok) throw new SfuError('bad_request', `invalid ${what}`);
}

function validDtls(d) {
  return isObj(d)
    && isList(d.fingerprints, 1, 8, (f) => isObj(f) && isStr(f.algorithm, 16) && isStr(f.value, 256))
    && optional(d.role, (r) => r === 'auto' || r === 'client' || r === 'server');
}

function validRtpParameters(p) {
  return isObj(p)
    && isList(p.codecs, 1, 8, (c) => isObj(c) && isStr(c.mimeType, 32) && isInt(c.payloadType, 0, 127) && isInt(c.clockRate, 1, 1000000))
    && optional(p.encodings, (e) => isList(e, 0, 4))
    && optional(p.headerExtensions, (h) => isList(h, 0, 32))
    && optional(p.rtcp, isObj)
    && optional(p.mid, (m) => isStr(m, 32));
}

function validRtpCapabilities(c) {
  return isObj(c)
    && optional(c.codecs, (x) => isList(x, 0, 64))
    && optional(c.headerExtensions, (x) => isList(x, 0, 64));
}

function createPeer({ userId, room, enableTcp = true, limits, notify, isMuted = () => false, onFailure = () => {} }) {
  const transports = new Map();
  const producers = new Map();
  const consumers = new Map();
  const clientPaused = new Set();
  let closed = false;
  let queue = Promise.resolve();

  const others = () => [...room.peers.values()].filter((p) => p !== peer);
  const broadcast = (event) => { for (const p of others()) notify(p.userId, event); };
  const muted = () => isMuted(room.roomKey, userId);

  async function ms(fn) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof SfuError) throw err;
      if (closed || room.router.closed) throw new SfuError('unavailable', err.message);
      throw new SfuError('bad_request', err.message);
    }
  }

  // A leave() or worker death can land while mediasoup is creating something for this peer.
  function keep(map, obj) {
    if (closed || room.router.closed) {
      obj.close();
      throw new SfuError('unavailable', 'peer closed');
    }
    map.set(obj.id, obj);
    obj.observer.on('close', () => {
      map.delete(obj.id);
      clientPaused.delete(obj.id);
    });
    return obj;
  }

  function own(map, id, what) {
    check(isStr(id), what);
    const obj = map.get(id);
    if (!obj) throw new SfuError('not_found', `${what} not found`);
    return obj;
  }

  function transportOf(direction) {
    return [...transports.values()].find((t) => t.appData.direction === direction);
  }

  const describe = (p) => ({ producerId: p.id, userId, media: p.appData.media, kind: p.kind });

  const handlers = {
    caps() {
      return { rtpCapabilities: room.router.rtpCapabilities, limits: { audio: limits.audio, camera: limits.camera, screen: limits.screen } };
    },

    async create_transport({ direction }) {
      check(direction === 'send' || direction === 'recv', 'direction');
      if (transportOf(direction) || transports.size >= 2) throw new SfuError('limit', `${direction} transport already exists`);
      const t = keep(transports, await ms(() => room.router.createWebRtcTransport({
        webRtcServer: room.webRtcServer, enableUdp: true, enableTcp, preferUdp: true, appData: { userId, direction },
      })));
      if (direction === 'send') await ms(() => t.setMaxIncomingBitrate(limits.maxIncomingBitrate));
      return { id: t.id, iceParameters: t.iceParameters, iceCandidates: t.iceCandidates, dtlsParameters: t.dtlsParameters };
    },

    async connect_transport({ transportId, dtlsParameters }) {
      check(validDtls(dtlsParameters), 'dtlsParameters');
      const t = own(transports, transportId, 'transport');
      await ms(() => t.connect({ dtlsParameters }));
      return {};
    },

    async produce({ transportId, kind, rtpParameters, media }) {
      check(MEDIA_KIND.get(media) === kind, 'kind/media');
      check(validRtpParameters(rtpParameters), 'rtpParameters');
      const t = own(transports, transportId, 'transport');
      if (t.appData.direction !== 'send') throw new SfuError('not_found', 'send transport not found');
      if ([...producers.values()].some((p) => p.appData.media === media)) throw new SfuError('limit', `${media} producer already exists`);
      if (media === 'audio' && muted()) throw new SfuError('muted');
      const p = keep(producers, await ms(() => t.produce({ kind, rtpParameters, appData: { userId, media } })));
      // setMuted() is not queued, so a force-mute during the produce RPC found no producer to pause.
      if (media === 'audio' && muted()) await ms(() => p.pause());
      broadcast({ event: 'new_producer', ...describe(p) });
      return { producerId: p.id };
    },

    close_producer({ producerId }) {
      const p = own(producers, producerId, 'producer');
      p.close();
      broadcast({ event: 'producer_closed', producerId: p.id, userId, media: p.appData.media });
      return {};
    },

    async pause_producer({ producerId }) {
      const p = own(producers, producerId, 'producer');
      clientPaused.add(p.id);
      await ms(() => p.pause());
      return {};
    },

    async resume_producer({ producerId }) {
      const p = own(producers, producerId, 'producer');
      if (p.appData.media === 'audio' && muted()) throw new SfuError('muted');
      clientPaused.delete(p.id);
      await ms(() => p.resume());
      return {};
    },

    list_producers() {
      return others().flatMap((o) => o.listOwnProducers());
    },

    async consume({ producerId, rtpCapabilities }) {
      check(isStr(producerId), 'producerId');
      check(validRtpCapabilities(rtpCapabilities), 'rtpCapabilities');
      const t = transportOf('recv');
      check(t, 'state: no recv transport');
      const owner = others().find((o) => o.producers.has(producerId));
      if (!owner) throw new SfuError('not_found', 'producer not found');
      if ([...consumers.values()].some((c) => c.producerId === producerId)) throw new SfuError('limit', 'already consuming');
      if (consumers.size >= MAX_CONSUMERS) throw new SfuError('limit', 'too many consumers');
      const producer = owner.producers.get(producerId);
      const ok = await ms(() => room.router.canConsume({ producerId, rtpCapabilities }));
      check(ok, 'rtpCapabilities: cannot consume');
      const c = keep(consumers, await ms(() => t.consume({
        producerId, rtpCapabilities, paused: true, appData: { userId: owner.userId, media: producer.appData.media },
      })));
      return { consumerId: c.id, producerId, kind: c.kind, rtpParameters: c.rtpParameters, userId: owner.userId, media: producer.appData.media };
    },

    async resume_consumer({ consumerId }) {
      const c = own(consumers, consumerId, 'consumer');
      await ms(() => c.resume());
      return {};
    },

    report_failure({ direction }) {
      check(direction === 'send' || direction === 'recv', 'direction');
      onFailure(userId, direction);
      return {};
    },
  };

  function handle(op, data) {
    check(OPS.has(op), 'op');
    const run = queue.then(() => {
      if (closed) throw new SfuError('unavailable', 'peer closed');
      return handlers[op](data);
    });
    queue = run.catch(() => {});
    return run;
  }

  async function setMuted(isOn) {
    const p = [...producers.values()].find((x) => x.appData.media === 'audio');
    if (!p || p.closed) return;
    try {
      if (isOn) await p.pause();
      else if (!clientPaused.has(p.id)) await p.resume();
    } catch { /* producer closed meanwhile */ }
  }

  function close() {
    if (closed) return;
    closed = true;
    const gone = [...producers.values()].map((p) => ({ producerId: p.id, userId, media: p.appData.media }));
    for (const t of [...transports.values()]) t.close();
    for (const g of gone) broadcast({ event: 'producer_closed', ...g });
  }

  const peer = {
    userId,
    limits,
    transports,
    producers,
    consumers,
    get closed() { return closed; },
    handle,
    setMuted,
    close,
    listOwnProducers: () => [...producers.values()].map(describe),
  };
  return peer;
}

module.exports = { createPeer, SfuError, limitsFor, OPS };
