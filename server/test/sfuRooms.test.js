'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkerPool } = require('../lib/sfu/workerPool');
const { createRooms } = require('../lib/sfu/rooms');

const base = { announcedHost: '127.0.0.1', enableTcp: false };

test('open creates a router once per room key', async () => {
  const pool = createWorkerPool({ ...base, workers: 1, port: 45100 });
  await pool.start();
  const rooms = createRooms(pool, { onReset() {} });
  try {
    const [a, b] = await Promise.all([rooms.open('c1'), rooms.open('c1')]);
    assert.equal(a, b);
    assert.equal(rooms.get('c1'), a);
    assert.equal(rooms.get('nope'), null);
    assert.ok(a.peers instanceof Map);
    const codecs = a.router.rtpCapabilities.codecs.map((c) => c.mimeType.toLowerCase());
    assert.deepEqual(codecs.filter((c) => !c.endsWith('/rtx')), ['audio/opus', 'video/vp8']);
    const opus = a.router.rtpCapabilities.codecs.find((c) => c.mimeType === 'audio/opus');
    assert.equal(opus.parameters.usedtx, 1);
    assert.equal(opus.parameters.useinbandfec, 1);
    assert.equal(opus.parameters.minptime, 10);
    assert.equal(await rooms.open('c1'), a);
  } finally {
    await rooms.closeAll();
    await pool.stop();
  }
});

test('close removes the room and closes the router', async () => {
  const pool = createWorkerPool({ ...base, workers: 1, port: 45105 });
  await pool.start();
  const rooms = createRooms(pool, { onReset() {} });
  try {
    const room = await rooms.open('c2');
    await rooms.close('c2');
    assert.equal(rooms.get('c2'), null);
    assert.equal(room.router.closed, true);
    await rooms.close('c2');
  } finally {
    await rooms.closeAll();
    await pool.stop();
  }
});

test('room keeps the webRtcServer of its worker and list returns open rooms', async () => {
  const pool = createWorkerPool({ ...base, workers: 1, port: 45200 });
  await pool.start();
  const rooms = createRooms(pool, { onReset() {} });
  try {
    const room = await rooms.open('w1');
    assert.equal(room.webRtcServer, pool.pick().webRtcServer);
    assert.deepEqual(rooms.list(), [room]);
  } finally {
    await rooms.closeAll();
    await pool.stop();
  }
});

test('open treats a room whose router is already closed as a miss', async () => {
  const pool = createWorkerPool({ ...base, workers: 1, port: 45201 });
  await pool.start();
  const resets = [];
  let died;
  const spyPool = { pick: () => pool.pick(), onDied: (cb) => { died = cb; } };
  const rooms = createRooms(spyPool, { onReset(key, ids) { resets.push([key, ids]); } });
  try {
    const stale = await rooms.open('d1');
    stale.peers.set(5, {});
    stale.router.close();
    const fresh = await rooms.open('d1');
    assert.notEqual(fresh, stale);
    assert.equal(fresh.router.closed, false);
    assert.equal(rooms.get('d1'), fresh);
    assert.deepEqual(resets, [['d1', [5]]]);
    died(fresh.workerIndex);
    assert.equal(rooms.get('d1'), fresh, 'a live room on the replacement worker survives onDied');
    assert.equal(resets.length, 1);
  } finally {
    await rooms.closeAll();
    await pool.stop();
  }
});

test('close during an in-flight open closes the router created afterwards', async () => {
  const pool = createWorkerPool({ ...base, workers: 1, port: 45202 });
  await pool.start();
  const routers = [];
  pool.pick().worker.observer.on('newrouter', (r) => routers.push(r));
  const rooms = createRooms(pool, { onReset() {} });
  try {
    const pending = rooms.open('x1');
    await rooms.close('x1');
    await assert.rejects(pending);
    assert.equal(rooms.get('x1'), null);
    assert.equal(routers.length, 1);
    assert.equal(routers[0].closed, true);
    const again = await rooms.open('x1');
    assert.equal(again.router.closed, false);
    assert.equal(rooms.get('x1'), again);
  } finally {
    await rooms.closeAll();
    await pool.stop();
  }
});

test('rooms on a dead worker are reset via onReset with their participant ids', async () => {
  const pool = createWorkerPool({ ...base, workers: 2, port: 45110 });
  await pool.start();
  const resets = [];
  let resolveReset;
  const done = new Promise((r) => { resolveReset = r; });
  const rooms = createRooms(pool, { onReset(key, ids) { resets.push([key, ids]); resolveReset(); } });
  try {
    const a = await rooms.open('ra');
    const b = await rooms.open('rb');
    assert.notEqual(a.workerIndex, b.workerIndex);
    a.peers.set(7, {});
    a.peers.set(8, {});
    const victim = a;
    const worker = pool.pick();
    const slotWorker = [worker, pool.pick()].find((s) => s.index === victim.workerIndex).worker;
    process.kill(slotWorker.pid, 'SIGKILL');
    await done;
    assert.deepEqual(resets, [['ra', [7, 8]]]);
    assert.equal(rooms.get('ra'), null);
    assert.equal(rooms.get('rb'), b);
    const fresh = await rooms.open('ra');
    assert.equal(fresh.router.closed, false);
  } finally {
    await rooms.closeAll();
    await pool.stop();
  }
});
