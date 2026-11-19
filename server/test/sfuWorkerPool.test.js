'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkerPool } = require('../lib/sfu/workerPool');
const { announcedHostFor } = require('../lib/turn/manager');

const base = { announcedHost: '127.0.0.1', enableTcp: true };

test('start creates N workers listening on port..port+N-1', async () => {
  const pool = createWorkerPool({ ...base, workers: 2, port: 45000 });
  await pool.start();
  try {
    assert.equal(pool.size, 2);
    const got = [];
    for (let i = 0; i < 2; i++) {
      const d = await pool.pick().webRtcServer.dump();
      got.push(...d.udpSockets.map((x) => `udp:${x.ip}:${x.port}`), ...d.tcpServers.map((x) => `tcp:${x.ip}:${x.port}`));
    }
    assert.deepEqual(got.sort(), ['tcp:0.0.0.0:45000', 'tcp:0.0.0.0:45001', 'udp:0.0.0.0:45000', 'udp:0.0.0.0:45001']);
  } finally { await pool.stop(); }
});

test('enableTcp false listens on udp only', async () => {
  const pool = createWorkerPool({ ...base, enableTcp: false, workers: 1, port: 45010 });
  await pool.start();
  try {
    const d = await pool.pick().webRtcServer.dump();
    assert.equal(d.udpSockets.length, 1);
    assert.equal(d.tcpServers.length, 0);
  } finally { await pool.stop(); }
});

test('pick round-robins across workers', async () => {
  const pool = createWorkerPool({ ...base, workers: 2, port: 45020 });
  await pool.start();
  try {
    const idx = [pool.pick().index, pool.pick().index, pool.pick().index, pool.pick().index];
    assert.deepEqual(idx, [0, 1, 0, 1]);
  } finally { await pool.stop(); }
});

test('stop closes all workers', async () => {
  const pool = createWorkerPool({ ...base, workers: 2, port: 45030 });
  await pool.start();
  const workers = [pool.pick().worker, pool.pick().worker];
  await pool.stop();
  assert.ok(workers.every((w) => w.closed));
});

test('a killed worker triggers onDied and is replaced, pick() still returns a live worker', async () => {
  const pool = createWorkerPool({ ...base, workers: 2, port: 45040 });
  await pool.start();
  try {
    const died = new Promise((resolve) => pool.onDied(resolve));
    const first = pool.pick();
    process.kill(first.worker.pid);
    assert.equal(await died, first.index);
    let replaced;
    for (let i = 0; i < 40 && !replaced; i++) {
      const p = pool.pick();
      if (p.index === first.index && p.worker !== first.worker) replaced = p;
      else await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(replaced);
    assert.equal(replaced.worker.closed, false);
    assert.equal(replaced.webRtcServer.closed, false);
  } finally { await pool.stop(); }
});

test('stop() during an in-flight replacement leaks no worker', async () => {
  const mediasoup = require('mediasoup');
  const created = [];
  const onNew = (w) => created.push(w);
  mediasoup.observer.on('newworker', onNew);
  const pool = createWorkerPool({ ...base, workers: 2, port: 45050 });
  try {
    await pool.start();
    const first = pool.pick();
    const died = new Promise((resolve) => first.worker.once('died', resolve));
    process.kill(first.worker.pid);
    await died;
    await pool.stop();
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(created.length >= 2);
    assert.ok(created.every((w) => w.closed), 'every created worker is closed');
    for (const w of created) assert.throws(() => process.kill(w.pid, 0));
  } finally {
    mediasoup.observer.off('newworker', onNew);
    await pool.stop();
  }
});

test('announcedHostFor prefers voice.sfu.announcedHost', () => {
  const cfg = { publicHost: 'pub.example', turn: { advertisedHost: 'adv', externalIp: '1.2.3.4' }, voice: { sfu: { announcedHost: 'sfu.example' } } };
  assert.equal(announcedHostFor(cfg, 'req'), 'sfu.example');
  cfg.voice.sfu.announcedHost = '';
  assert.equal(announcedHostFor(cfg, 'req'), 'adv');
  cfg.turn.advertisedHost = '';
  assert.equal(announcedHostFor(cfg, 'req'), '1.2.3.4');
  cfg.turn.externalIp = '';
  assert.equal(announcedHostFor(cfg, 'req'), 'pub.example');
  cfg.publicHost = 'localhost';
  assert.equal(announcedHostFor(cfg, 'req'), 'req');
});
