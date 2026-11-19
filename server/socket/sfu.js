'use strict';

const voice = require('./voice');
const stage = require('./stage');
const { SfuError } = require('../lib/sfu');

const MAX_IN_FLIGHT = 32;
const RESET_MUTE_KEEP_MS = 5 * 60_000;

function validId(id) {
  return (typeof id === 'number' && Number.isFinite(id)) || (typeof id === 'string' && id.length > 0 && id.length <= 64);
}

function scopeOf(roomKey) {
  return typeof roomKey === 'string' && roomKey.startsWith('dm:') ? { dmChannelId: Number(roomKey.slice(3)) } : { channelId: roomKey };
}

function roomKeyOf(msg) {
  const dm = Number(msg.dmChannelId);
  if (msg.dmChannelId != null) return Number.isSafeInteger(dm) && dm > 0 ? voice.dmRoomKey(dm) : null;
  const id = Number(msg.channelId);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function createSfuSocket({
  sfu = require('../lib/sfu'),
  notifyUser = (uid, msg) => require('./hub').notifyUser(uid, msg),
  resetMuteKeepMs = RESET_MUTE_KEEP_MS,
} = {}) {
  let log = null;
  const stageRooms = new Set();
  const inFlight = new Map();
  const evictedCbs = [];

  const sendEvent = (userId, event, roomKey) => notifyUser(userId, { type: 'sfu_event', ...scopeOf(roomKey), ...event });

  function isMuted(roomKey, userId) {
    return voice.isForceMuted(roomKey, userId) || (stageRooms.has(roomKey) && !stage.isSpeaker(roomKey, userId));
  }

  // The facade only knows peers that already made an SFU request, so participants still in their
  // first handshake are notified here too. Everyone is removed from the room so the rejoin
  // recreates it with the current effective mode instead of keeping 'sfu' over a dead router.
  // Moderator force-mutes are kept for the rejoin (bounded by resetMuteKeepMs).
  // Stage speaker state is kept so speakers rejoin as speakers.
  function handleReset(roomKey, userIds) {
    if (voice.modeOf(roomKey) !== 'sfu') return;
    const members = voice.participants(roomKey);
    for (const uid of members) if (!userIds.includes(uid)) sendEvent(uid, { event: 'reset' }, roomKey);
    voice.evict(roomKey, resetMuteKeepMs);
    stageRooms.delete(roomKey);
    const all = [...new Set([...userIds, ...members])];
    for (const cb of evictedCbs) {
      try { cb(roomKey, all); } catch (err) { log?.error?.(`[sfu] reset callback failed: ${err.message}`); }
    }
  }

  sfu.setNotifier(sendEvent);
  sfu.onReset(handleReset);

  function start(logger) {
    if (logger) log = logger;
    return sfu.start(logger, { isParticipant: voice.isParticipant, isMuted });
  }

  // isOpen: whether the joining socket is still open. A rejoin from a socket that already closed
  // must not tear down the SFU peer another live socket of the same user is using.
  async function join(roomKey, userId, { sfu: capable = false, stage: isStage = false, isOpen = () => true } = {}) {
    // Clients rejoin as soon as a restart resets their room, or reconnect while the pool is still
    // starting after a server restart; they must find the pool, not mesh.
    const restarting = sfu.whenRestarted();
    if (restarting) await restarting;
    if (voice.inOtherRoom(roomKey, userId)) return { ok: false };
    const rejoin = voice.isParticipant(roomKey, userId);
    const existing = voice.participants(roomKey).length > 0;
    const mode = existing ? (voice.modeOf(roomKey) || 'mesh') : sfu.effectiveMode();
    if (mode === 'sfu' && !capable) return { ok: false, reason: 'update_required' };
    voice.join(roomKey, userId, mode);
    if (!existing && isStage) stageRooms.add(roomKey);
    if (voice.modeOf(roomKey) !== 'sfu') return { ok: true };
    try {
      await sfu.openRoom(roomKey);
    } catch (err) {
      log?.warn?.(`[sfu] could not open room ${roomKey}: ${err.message}`);
      if (existing && voice.modeOf(roomKey) === 'sfu') {
        voice.leave(roomKey, userId);
        await left([roomKey], userId);
        return { ok: false, reason: 'sfu_unavailable' };
      }
      // A fresh room falls back to mesh; clients pick the engine from the first voice_state.
      if (voice.participants(roomKey).length > 0) voice.setMode(roomKey, 'mesh');
    }
    if (!voice.isParticipant(roomKey, userId)) {
      await left([roomKey], userId);
      return { ok: false, silent: true };
    }
    // Same-room rejoin (e.g. a WS reconnect): drop the old peer so the new engine starts clean.
    if (rejoin && voice.modeOf(roomKey) === 'sfu' && isOpen()) await sfu.leave(roomKey, userId);
    return { ok: true };
  }

  // Called after the voice registry already dropped the user from these rooms.
  async function left(roomKeys, userId) {
    for (const roomKey of roomKeys) {
      try {
        await sfu.leave(roomKey, userId);
        if (voice.participants(roomKey).length === 0) {
          stageRooms.delete(roomKey);
          await sfu.closeRoom(roomKey);
        }
      } catch (err) {
        log?.error?.(`[sfu] leave cleanup failed for ${roomKey}: ${err.message}`);
      }
    }
  }

  async function syncMute(roomKey, userId) {
    try {
      await sfu.setMuted(roomKey, userId, isMuted(roomKey, userId));
    } catch (err) {
      log?.error?.(`[sfu] mute sync failed for ${roomKey}: ${err.message}`);
    }
  }

  async function handleSfuRequest(user, msg, send) {
    if (!msg || msg.type !== 'sfu_request') return false;
    const { id } = msg;
    if (!validId(id)) return true;
    const fail = (code) => send({ type: 'sfu_response', id, ok: false, error: code });
    const roomKey = roomKeyOf(msg);
    if (roomKey === null) { fail('bad_request'); return true; }
    const count = inFlight.get(user.id) || 0;
    if (count >= MAX_IN_FLIGHT) { fail('rate_limited'); return true; }
    inFlight.set(user.id, count + 1);
    try {
      const data = await sfu.request(roomKey, user.id, msg.op, msg.data);
      send({ type: 'sfu_response', id, ok: true, data });
    } catch (err) {
      if (!(err instanceof SfuError)) log?.error?.(`[sfu] request ${msg.op} failed: ${err.message}`);
      fail(err instanceof SfuError ? err.code : 'internal');
    } finally {
      const n = inFlight.get(user.id) - 1;
      if (n > 0) inFlight.set(user.id, n); else inFlight.delete(user.id);
    }
    return true;
  }

  return {
    start,
    stop: () => sfu.stop(),
    restartForAnnouncedChange: () => sfu.restartIfAnnouncedChanged(),
    join,
    left,
    syncMute,
    isMuted,
    handleSfuRequest,
    roomMode: (roomKey) => voice.modeOf(roomKey) || 'mesh',
    onEvicted: (cb) => { evictedCbs.push(cb); },
  };
}

module.exports = { ...createSfuSocket(), createSfuSocket };
