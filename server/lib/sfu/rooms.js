'use strict';

const mediaCodecs = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
    parameters: { usedtx: 1, useinbandfec: 1, minptime: 10 },
  },
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000 },
];

function createRooms(pool, { onReset } = {}) {
  const rooms = new Map();
  const opening = new Map();

  function open(roomKey) {
    const existing = rooms.get(roomKey);
    if (existing && !existing.router.closed) return Promise.resolve(existing);
    if (existing) reset(roomKey, existing);
    let pending = opening.get(roomKey);
    if (!pending) {
      pending = (async () => {
        const { worker, webRtcServer, index } = pool.pick();
        const router = await worker.createRouter({ mediaCodecs });
        // close() ran while the router was being created: it removed this pending open.
        if (opening.get(roomKey) !== pending) {
          router.close();
          throw new Error(`room ${roomKey} was closed while opening`);
        }
        const room = { roomKey, router, webRtcServer, workerIndex: index, peers: new Map() };
        rooms.set(roomKey, room);
        return room;
      })().finally(() => {
        if (opening.get(roomKey) === pending) opening.delete(roomKey);
      });
      opening.set(roomKey, pending);
    }
    return pending;
  }

  async function close(roomKey) {
    opening.delete(roomKey);
    const room = rooms.get(roomKey);
    if (!room) return;
    rooms.delete(roomKey);
    room.router.close();
  }

  async function closeAll() {
    for (const key of [...opening.keys()]) opening.delete(key);
    for (const key of [...rooms.keys()]) await close(key);
  }

  function reset(key, room) {
    rooms.delete(key);
    room.router.close();
    onReset?.(key, [...room.peers.keys()]);
  }

  // onDied fires only after the replacement worker is up, so rooms already opened on it (same index,
  // live router) must survive.
  pool.onDied((index) => {
    for (const [key, room] of [...rooms]) {
      if (room.workerIndex === index && room.router.closed) reset(key, room);
    }
  });

  return { open, get: (roomKey) => rooms.get(roomKey) || null, list: () => [...rooms.values()], close, closeAll };
}

module.exports = { createRooms };
