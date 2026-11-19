'use strict';

const os = require('node:os');
const config = require('../config');
const availability = require('./availability');
const { createWorkerPool } = require('./workerPool');
const { createRooms } = require('./rooms');
const { createPeer, SfuError, limitsFor, OPS } = require('./peer');
const { announcedHostFor } = require('../turn/manager');

const MAX_DATA_CHARS = 64 * 1024;
const RESTART_DEBOUNCE_MS = 30_000;
const RESTART_START_ATTEMPTS = 5;
const RESTART_RETRY_MS = [30_000, 60_000, 120_000];

function lanIpv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return '';
}

function createSfu({ load = config.load, probe = availability.probe, restartDebounceMs = RESTART_DEBOUNCE_MS, restartRetryMs = RESTART_RETRY_MS } = {}) {
  let log = null;
  let probed = null;
  let pool = null;
  let rooms = null;
  let starting = null;
  let lastError = null;
  let notifier = null;
  let connectFailures = 0;
  let lastConnectFailureAt = null;
  let modeCache = null;
  let maxKbpsCache = 0;
  let startedWith = null;
  let restarting = null;
  let lastRestartAt = 0;
  let lastAutoRestart = null;
  let trailing = null;
  let failedRetries = 0;
  let bytes = { in: 0, out: 0 };
  const resetCbs = [];
  const hooks = { isParticipant: () => false, isMuted: () => false };

  function available() {
    if (!probed) probed = probe();
    return probed.ok ? { ok: true } : { ok: false, reason: probed.reason };
  }

  // config.load() reads (and may rewrite) config.json, so the live voice settings are cached;
  // start(), the admin PATCH and the console config command refresh them.
  function cacheVoice(cfg) {
    modeCache = cfg.voice.mode;
    maxKbpsCache = Number(cfg.voice.sfu.maxKbpsPerUser) || 0;
  }

  function refreshMode() {
    cacheVoice(load());
  }

  function effectiveMode() {
    if (modeCache === null) refreshMode();
    return modeCache === 'sfu' && available().ok && pool && pool.alive() ? 'sfu' : 'mesh';
  }

  function announced(cfg = load()) {
    const host = announcedHostFor(cfg, '');
    return host ? { host, isLan: false } : { host: lanIpv4() || '127.0.0.1', isLan: true };
  }

  function notify(userId, event, roomKey) {
    try {
      notifier?.(userId, event, roomKey);
    } catch (err) {
      log?.error?.(`[sfu] notifier failed: ${err.message}`);
    }
  }

  function handleReset(roomKey, userIds, why = 'after a worker died') {
    log?.warn?.(`[sfu] room ${roomKey} reset ${why}`);
    for (const id of userIds) notify(id, { event: 'reset' }, roomKey);
    for (const cb of resetCbs) {
      try { cb(roomKey, userIds); } catch (err) { log?.error?.(`[sfu] onReset callback failed: ${err.message}`); }
    }
  }

  // Re-callable: when voice.mode was mesh at boot, calling start() again after the admin switches
  // to sfu brings the workers up.
  async function start(logger, options = {}) {
    if (logger) log = logger;
    if (options.isParticipant) hooks.isParticipant = options.isParticipant;
    if (options.isMuted) hooks.isMuted = options.isMuted;
    if (pool) return;
    if (starting) return starting;
    const cfg = load();
    cacheVoice(cfg);
    if (cfg.voice.mode !== 'sfu') return;
    const a = available();
    if (!a.ok) {
      lastError = a.reason;
      log?.warn?.(`[sfu] voice.mode is sfu but the SFU is unavailable, using mesh: ${a.reason}`);
      return;
    }
    starting = (async () => {
      const s = cfg.voice.sfu;
      const { host: announcedHost, isLan } = announced(cfg);
      const p = createWorkerPool({ workers: s.workers, port: s.port, announcedHost, enableTcp: s.enableTcp, logger: log });
      try {
        await p.start();
      } catch (err) {
        lastError = err.message;
        log?.error?.(`[sfu] could not start, using mesh: ${err.message}`);
        return;
      }
      lastError = null;
      pool = p;
      startedWith = { port: s.port, workers: s.workers, announcedHost: s.announcedHost, enableTcp: s.enableTcp, resolvedHost: announcedHost, resolvedIsLan: isLan };
      rooms = createRooms(p, { onReset: handleReset });
      log?.info?.(`[sfu] ${p.size} worker(s) on port ${s.port}${p.size > 1 ? `-${s.port + p.size - 1}` : ''}, announced as ${announcedHost}`);
    })().finally(() => { starting = null; });
    return starting;
  }

  async function stopPool() {
    if (starting) await starting;
    if (!pool) return;
    const r = rooms;
    const p = pool;
    pool = null;
    rooms = null;
    startedWith = null;
    for (const room of r.list()) for (const peer of room.peers.values()) peer.close();
    await r.closeAll();
    await p.stop();
  }

  // Waits for a running restart first, so a shutdown cannot be followed by the restart's start().
  async function stop() {
    clearTimeout(trailing);
    trailing = null;
    if (restarting) await restarting.catch(() => {});
    clearTimeout(trailing);
    trailing = null;
    await stopPool();
  }

  function scheduleTrailing(ms) {
    if (trailing) return;
    trailing = setTimeout(() => {
      trailing = null;
      if (!pool && lastAutoRestart?.ok === false) retryFailedStart();
      else restartIfAnnouncedChanged();
    }, Math.max(0, ms));
    trailing.unref?.();
  }

  function scheduleRetry() {
    if (failedRetries >= restartRetryMs.length) {
      log?.error?.('[sfu] the SFU could not start again after an address change; giving up until the Voice settings are saved again');
      return;
    }
    scheduleTrailing(restartRetryMs[failedRetries++]);
  }

  // null: voice.mode was switched to mesh meanwhile, so not starting is not a failure.
  async function startAgain() {
    for (let i = 0; i < RESTART_START_ATTEMPTS && !pool; i++) {
      if (load().voice.mode !== 'sfu') return null;
      if (i) await new Promise((r) => setTimeout(r, 300));
      await start();
    }
    return !!pool;
  }

  function recordStart(ok, from, to) {
    if (ok === null) return;
    lastAutoRestart = { at: new Date().toISOString(), from, to, ok };
    if (ok) failedRetries = 0;
    else scheduleRetry();
  }

  function retryFailedStart() {
    if (restarting || pool) return restarting || Promise.resolve(false);
    const { from, to } = lastAutoRestart;
    restarting = (async () => {
      log?.warn?.('[sfu] retrying the SFU start after a failed automatic restart');
      const ok = await startAgain();
      recordStart(ok, from, to);
      return !!ok;
    })().finally(() => { restarting = null; });
    return restarting;
  }

  // Restarts the pool when the address it announces is out of date (the server's public IP
  // changed). A manually set voice.sfu.announcedHost is never second-guessed. Live rooms get the
  // same reset as after a worker crash, so clients rejoin by themselves once the pool is back.
  // Within the debounce window the change is deferred to one trailing check, not dropped.
  function restartIfAnnouncedChanged() {
    if (restarting) return restarting;
    if (!pool || !startedWith) return Promise.resolve(false);
    const cfg = load();
    if (cfg.voice.sfu.announcedHost) return Promise.resolve(false);
    const from = startedWith.resolvedHost;
    const to = announced(cfg).host;
    if (to === from) return Promise.resolve(false);
    if (Date.now() - lastRestartAt < restartDebounceMs) {
      scheduleTrailing(lastRestartAt + restartDebounceMs - Date.now());
      return Promise.resolve(false);
    }
    lastRestartAt = Date.now();
    failedRetries = 0;
    restarting = (async () => {
      log?.warn?.(`[sfu] announced address changed ${from} -> ${to}, restarting the SFU`);
      for (const room of rooms.list()) handleReset(room.roomKey, [...room.peers.keys()], 'for an SFU restart');
      await stopPool();
      recordStart(await startAgain(), from, to);
      return true;
    })().finally(() => { restarting = null; });
    return restarting;
  }

  async function openRoom(roomKey) {
    if (!rooms) throw new SfuError('unavailable', 'sfu not running');
    try {
      await rooms.open(roomKey);
    } catch (err) {
      throw new SfuError('unavailable', err.message);
    }
  }

  async function closeRoom(roomKey) {
    if (!rooms) return;
    const room = rooms.get(roomKey);
    if (room) {
      const peers = [...room.peers.values()];
      room.peers.clear();
      for (const peer of peers) peer.close();
    }
    await rooms.close(roomKey);
  }

  async function leave(roomKey, userId) {
    const room = rooms?.get(roomKey);
    const peer = room?.peers.get(userId);
    if (!peer) return;
    room.peers.delete(userId);
    peer.close();
  }

  function peerFor(room, userId) {
    let peer = room.peers.get(userId);
    if (peer) return peer;
    peer = createPeer({
      userId,
      room,
      enableTcp: startedWith.enableTcp,
      limits: limitsFor(maxKbpsCache),
      notify: (uid, event) => notify(uid, event, room.roomKey),
      isMuted: (key, uid) => hooks.isMuted(key, uid),
      onFailure: (uid, direction) => {
        connectFailures++;
        lastConnectFailureAt = Date.now();
        log?.warn?.(`[sfu] user ${uid} reported a ${direction} transport failure in ${room.roomKey}`);
      },
    });
    room.peers.set(userId, peer);
    return peer;
  }

  async function request(roomKey, userId, op, data) {
    if (!rooms) throw new SfuError('unavailable', 'sfu not running');
    if (!hooks.isParticipant(roomKey, userId)) throw new SfuError('not_participant');
    if (typeof op !== 'string' || !OPS.has(op)) throw new SfuError('bad_request', 'unknown op');
    const payload = data === undefined || data === null ? {} : data;
    if (typeof payload !== 'object' || Array.isArray(payload)) throw new SfuError('bad_request', 'data must be an object');
    let size;
    try { size = JSON.stringify(payload).length; } catch { size = Infinity; }
    if (size > MAX_DATA_CHARS) throw new SfuError('bad_request', 'data too large');
    const room = rooms.get(roomKey);
    if (!room || room.router.closed) throw new SfuError('unavailable', 'room not open');
    return peerFor(room, userId).handle(op, payload);
  }

  async function setMuted(roomKey, userId, muted) {
    await rooms?.get(roomKey)?.peers.get(userId)?.setMuted(muted);
  }

  function status() {
    const list = rooms ? rooms.list() : [];
    const peers = list.flatMap((r) => [...r.peers.values()]);
    const sum = (key) => peers.reduce((n, p) => n + p[key].size, 0);
    return {
      running: !!pool,
      workers: pool ? pool.size : 0,
      error: lastError,
      rooms: list.length,
      peers: peers.length,
      transports: sum('transports'),
      producers: sum('producers'),
      consumers: sum('consumers'),
      bytesIn: bytes.in,
      bytesOut: bytes.out,
      connectFailures,
      lastConnectFailureAt,
      lastAutoRestart,
      startedWith,
    };
  }

  // Byte counters come from mediasoup asynchronously; status() reports the last refresh.
  async function stats() {
    const transports = (rooms ? rooms.list() : []).flatMap((r) => [...r.peers.values()].flatMap((p) => [...p.transports.values()]));
    const next = { in: 0, out: 0 };
    await Promise.all(transports.map(async (t) => {
      try {
        for (const s of await t.getStats()) {
          next.in += s.bytesReceived || 0;
          next.out += s.bytesSent || 0;
        }
      } catch { /* closed meanwhile */ }
    }));
    bytes = next;
    return status();
  }

  return {
    available,
    effectiveMode,
    refreshMode,
    announced,
    start,
    stop,
    status,
    stats,
    setNotifier: (fn) => { notifier = fn; },
    onReset: (cb) => { resetCbs.push(cb); },
    openRoom,
    closeRoom,
    leave,
    request,
    setMuted,
    restartIfAnnouncedChanged,
    // A start at boot counts too: clients reconnecting right after a server restart must not open mesh rooms.
    whenRestarted: () => restarting || starting,
    peerOf: (roomKey, userId) => rooms?.get(roomKey)?.peers.get(userId) || null,
  };
}

module.exports = { ...createSfu(), createSfu, SfuError };
