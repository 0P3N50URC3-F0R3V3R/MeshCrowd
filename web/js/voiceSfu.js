import { voiceQualityPreset } from './voiceQuality.js';
import { createRpc } from './sfuRpc.mjs';

// SFU voice engine: one send and one receive transport to the server's mediasoup router, driven
// over the app WebSocket (`sfu_request`/`sfu_response`, pushed `sfu_event`). Same interface as the
// mesh engine (voiceMesh.js); no DOM access, the view is told about remote media via ctx.hooks.
const CONNECT_TIMEOUT_MS = 10_000;
const HEALTHY_MS = 30_000;

async function loadMediasoupDevice() {
  const { Device } = await import('./vendor/mediasoup-client.js');
  return new Device();
}

const capBitrate = (bps, kbps) => (kbps > 0 ? Math.min(bps, kbps * 1000) : bps);

// Connection-failure budget across engine rebuilds: one retry, then give up. Only an engine that
// reported itself healthy (every started transport connected for HEALTHY_MS) restores the retry,
// so one transport connecting while the other keeps failing cannot loop forever.
export function createConnectRetry({ retries = 1, onRetry, onGiveUp }) {
  let used = 0;
  return {
    failed(direction) {
      if (used < retries) { used++; onRetry(direction); } else onGiveUp(direction);
    },
    healthy() { used = 0; },
    reset() { used = 0; },
  };
}

export function createSfuEngine(ctx) {
  const { ws, scopePayload, hooks } = ctx;
  const loadDevice = ctx.loadDevice || loadMediasoupDevice;
  const connectTimeoutMs = ctx.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const healthyMs = ctx.healthyMs ?? HEALTHY_MS;
  const rpc = createRpc((m) => ws.send({ type: 'sfu_request', ...scopePayload(), ...m }), { timeoutMs: ctx.rpcTimeoutMs });
  let stopped = false;
  let ready = false;
  let failed = false;
  let device = null;
  let limits = {};
  let sendTransport = null;
  let recvTransport = null;
  const timers = new Set();
  const watched = new Set(); // transports that started connecting
  let healthyTimer = null;
  const local = { audio: null, camera: null, screen: null };
  const producers = new Map(); // media -> client Producer
  const chains = new Map(); // media -> promise serializing produce/replace/close of that media
  const consumers = new Map(); // producerId -> client Consumer (appData: { userId, media })
  const consuming = new Set();
  const gone = new Set(); // producer ids closed while their consume was in flight
  const queued = []; // producers announced before the transports were ready
  let audioPaused = false;
  let audioRefused = false;

  function clearHealthy() {
    clearTimeout(healthyTimer);
    healthyTimer = null;
  }

  function checkHealthy() {
    clearHealthy();
    if (failed || stopped || ![...watched].every((t) => t.connectionState === 'connected')) return;
    healthyTimer = setTimeout(() => {
      healthyTimer = null;
      if (!failed && !stopped && [...watched].every((t) => t.connectionState === 'connected')) hooks.onHealthy?.();
    }, healthyMs);
  }

  function fail(direction) {
    if (failed || stopped) return;
    failed = true;
    clearHealthy();
    for (const t of timers) clearTimeout(t);
    timers.clear();
    if (direction) rpc.request('report_failure', { direction }).catch(() => {});
    hooks.onConnectFailed?.(direction);
  }

  function watchConnect(transport, direction) {
    watched.add(transport);
    checkHealthy();
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (transport.connectionState !== 'connected') fail(direction);
    }, connectTimeoutMs);
    timers.add(timer);
    transport.on('connectionstatechange', (state) => {
      if (state === 'connected') { clearTimeout(timer); timers.delete(timer); }
      if (state === 'failed') fail(direction);
      else checkHealthy();
    });
  }

  async function createTransport(direction) {
    const info = await rpc.request('create_transport', { direction });
    if (stopped) return null;
    const opts = { id: info.id, iceParameters: info.iceParameters, iceCandidates: info.iceCandidates, dtlsParameters: info.dtlsParameters, iceServers: [] };
    const t = direction === 'send' ? device.createSendTransport(opts) : device.createRecvTransport(opts);
    // mediasoup-client only connects a transport on its first produce/consume, so the 10 s
    // budget starts there: a recv transport in an empty room never connects and must not "fail".
    let watched = false;
    t.on('connect', ({ dtlsParameters }, callback, errback) => {
      if (!watched) { watched = true; watchConnect(t, direction); }
      rpc.request('connect_transport', { transportId: t.id, dtlsParameters }).then(() => callback(), errback);
    });
    if (direction === 'send') {
      t.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
        rpc.request('produce', { transportId: t.id, kind, rtpParameters, media: appData.media })
          .then(({ producerId }) => callback({ id: producerId }), errback);
      });
    }
    return t;
  }

  async function start() {
    try {
      const caps = await rpc.request('caps');
      if (stopped) return;
      limits = caps.limits || {};
      const d = await loadDevice();
      if (stopped) return;
      await d.load({ routerRtpCapabilities: caps.rtpCapabilities });
      if (stopped) return;
      device = d;
      sendTransport = await createTransport('send');
      if (stopped) return;
      recvTransport = await createTransport('recv');
      if (stopped) return;
      const list = await rpc.request('list_producers');
      if (stopped) return;
      ready = true;
      for (const p of [...(Array.isArray(list) ? list : []), ...queued.splice(0)]) consume(p);
      for (const media of Object.keys(local)) if (local[media]) syncProducer(media);
    } catch {
      fail(null);
    }
  }

  async function consume({ producerId, userId, media }) {
    if (stopped || !producerId || consumers.has(producerId) || consuming.has(producerId)) return;
    if (!ready) {
      if (!queued.some((p) => p.producerId === producerId)) queued.push({ producerId, userId, media });
      return;
    }
    consuming.add(producerId);
    try {
      const data = await rpc.request('consume', { producerId, rtpCapabilities: device.rtpCapabilities });
      if (stopped || gone.has(producerId)) return;
      const consumer = await recvTransport.consume({
        id: data.consumerId, producerId, kind: data.kind, rtpParameters: data.rtpParameters,
        appData: { userId: data.userId, media: data.media },
      });
      if (stopped || gone.has(producerId)) { consumer.close(); return; }
      consumers.set(producerId, consumer);
      const stream = new MediaStream([consumer.track]);
      if (consumer.kind === 'audio') hooks.attachAudio(data.userId, stream);
      else hooks.attachVideo(data.userId, data.media, stream);
      await rpc.request('resume_consumer', { consumerId: data.consumerId });
    } catch { /* producer closed meanwhile (not_found) or engine stopped */ } finally {
      consuming.delete(producerId);
      gone.delete(producerId);
    }
  }

  function producerClosed({ producerId }) {
    const qi = queued.findIndex((p) => p.producerId === producerId);
    if (qi >= 0) queued.splice(qi, 1);
    if (consuming.has(producerId)) gone.add(producerId);
    const consumer = consumers.get(producerId);
    if (!consumer) return;
    consumers.delete(producerId);
    consumer.close();
    const { userId, media } = consumer.appData;
    if (consumer.kind !== 'audio') hooks.detachVideo(userId, media);
    if (![...consumers.values()].some((c) => c.appData.userId === userId)) hooks.closeRemote(userId);
  }

  function handleEvent(ev) {
    if (stopped || !ev) return;
    if (ev.event === 'new_producer') consume(ev);
    else if (ev.event === 'producer_closed') producerClosed(ev);
    else if (ev.event === 'reset') { stop(); hooks.onReset?.(); }
  }

  function produceOptions(media, track) {
    const opts = { track, stopTracks: false, disableTrackOnPause: false, appData: { media } };
    if (media === 'audio') {
      const preset = voiceQualityPreset(ctx.quality());
      const bitrate = capBitrate(preset.bitrate, limits.audio);
      opts.codecOptions = {
        opusDtx: true, opusFec: true, opusPtime: 20, opusStereo: preset.stereo,
        opusMaxPlaybackRate: preset.khz * 1000, opusMaxAverageBitrate: bitrate,
      };
      opts.encodings = [{ maxBitrate: bitrate }];
    } else if (limits[media] > 0) {
      opts.encodings = [{ maxBitrate: limits[media] * 1000 }];
    }
    return opts;
  }

  async function applyProducer(media) {
    if (stopped || !ready) return;
    const track = local[media];
    const current = producers.get(media);
    if (current && track) {
      if (current.track !== track) await current.replaceTrack({ track });
      return;
    }
    if (current) {
      producers.delete(media);
      current.close();
      await rpc.request('close_producer', { producerId: current.id }).catch(() => {});
      return;
    }
    if (!track) return;
    let producer;
    try {
      producer = await sendTransport.produce(produceOptions(media, track));
    } catch (err) {
      // Force-muted or stage audience: the server refuses the audio producer. Not fatal; retryAudio()
      // produces again when the mute or stage state changes.
      if (media === 'audio') {
        if (err?.code === 'muted') audioRefused = true;
        return;
      }
      // Otherwise nobody would see the camera or screen the user thinks they are sharing.
      if (!stopped && local[media] === track) hooks.onProduceFailed?.(media, err?.code || 'internal');
      return;
    }
    if (stopped) { producer.close(); return; }
    producers.set(media, producer);
    if (media === 'audio') {
      audioRefused = false;
      if (audioPaused) pauseAudio(producer, true);
    }
  }

  function syncProducer(media) {
    const run = (chains.get(media) || Promise.resolve()).then(() => applyProducer(media)).catch(() => {});
    chains.set(media, run);
    return run;
  }

  function setLocalTrack(media, track) {
    local[media] = track;
    if (media === 'audio' && track) audioRefused = false;
    return syncProducer(media);
  }

  // Called when the mute or stage state changes in my favour: produces a refused audio producer
  // again, or re-sends a resume the server refused while I was muted.
  function retryAudio() {
    if (stopped || !local.audio) return Promise.resolve();
    const p = producers.get('audio');
    if (p) return !audioPaused && p.paused ? pauseAudio(p, false) : Promise.resolve();
    audioRefused = false;
    return syncProducer('audio');
  }

  // A resume the server refuses ('muted') leaves the producer paused locally too, so the client
  // state matches the server and retryAudio() knows to resume it later.
  function pauseAudio(producer, paused) {
    if (paused) producer.pause(); else producer.resume();
    return rpc.request(paused ? 'pause_producer' : 'resume_producer', { producerId: producer.id }).catch((err) => {
      if (!paused && err?.code === 'muted' && !producer.closed) producer.pause();
    });
  }

  function setAudioPaused(paused) {
    audioPaused = paused;
    const p = producers.get('audio');
    if (p && !stopped && p.paused !== paused) pauseAudio(p, paused);
  }

  async function pollStats() {
    const out = new Map();
    for (const consumer of [...consumers.values()]) {
      if (consumer.kind !== 'audio') continue;
      try {
        const report = await consumer.getStats();
        let rtt = 0, lost = 0, received = 0, jitter = 0;
        report.forEach((stat) => {
          if (stat.type === 'candidate-pair' && stat.state === 'succeeded' && stat.currentRoundTripTime != null) {
            rtt = Math.max(rtt, stat.currentRoundTripTime * 1000);
          }
          if (stat.type === 'inbound-rtp' && stat.kind === 'audio') {
            lost = stat.packetsLost ?? 0;
            received = stat.packetsReceived ?? 0;
            jitter = (stat.jitter ?? 0) * 1000;
          }
        });
        const lossRatio = received > 0 ? lost / (lost + received) : 0;
        const quality = rtt < 150 && lossRatio < 0.02 && jitter < 30 ? 'good'
          : rtt < 300 && lossRatio < 0.05 && jitter < 60 ? 'ok' : 'poor';
        if (!consumer.closed) out.set(consumer.appData.userId, { quality, path: 'sfu' });
      } catch { /* consumer closed meanwhile */ }
    }
    return stopped ? new Map() : out;
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    ready = false;
    rpc.close();
    clearHealthy();
    for (const t of timers) clearTimeout(t);
    timers.clear();
    const users = new Set([...consumers.values()].map((c) => c.appData.userId));
    for (const c of consumers.values()) c.close();
    consumers.clear();
    for (const p of producers.values()) p.close();
    producers.clear();
    queued.length = 0;
    sendTransport?.close();
    recvTransport?.close();
    for (const uid of users) hooks.closeRemote(uid);
  }

  return {
    start,
    stop,
    setLocalTrack,
    onRoster: () => {},
    handleSignal: () => {},
    pollStats,
    handleEvent,
    handleResponse: (msg) => rpc.handleResponse(msg),
    retryAudio,
    setAudioPaused,
    get audioRefused() { return audioRefused; },
    get stopped() { return stopped; },
  };
}
