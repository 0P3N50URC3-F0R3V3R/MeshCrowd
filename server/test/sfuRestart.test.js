'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const dgram = require('node:dgram');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const config = require('../lib/config');
const manager = require('../lib/turn/manager');
const voice = require('../socket/voice');
const { createSfu } = require('../lib/sfu');
const { createSfuSocket } = require('../socket/sfu');

let current = null;
manager.onIpChange(() => current?.ss.restartForAnnouncedChange());

let nextRoom = 97000;

async function setup(port, { announcedHost = '', externalIp = '', ...opts } = {}) {
  config.save({ turn: { externalIp, advertisedHost: '' }, voice: { mode: 'sfu', sfu: { port, workers: 1, announcedHost, enableTcp: false, maxKbpsPerUser: 0 } } });
  const sfu = createSfu({ load: config.load, probe: () => ({ ok: true }), ...opts });
  const sent = [];
  const ss = createSfuSocket({ sfu, notifyUser: (uid, msg) => sent.push([uid, msg]) });
  await ss.start(null);
  current = { sfu, ss, sent };
  return { sfu, ss, sent, room: nextRoom++ };
}

async function cleanup({ sfu, room }) {
  for (const uid of voice.participants(room)) voice.leave(room, uid);
  current = null;
  await sfu.stop();
}

async function ok(ss, uid, room, op, data) {
  const out = [];
  await ss.handleSfuRequest({ id: uid }, { type: 'sfu_request', id: op, channelId: room, op, data }, (m) => out.push(m));
  assert.equal(out[0].ok, true, `${op} failed: ${out[0].error}`);
  return out[0].data;
}

async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
  return true;
}

const resets = (sent) => sent.filter(([, m]) => m.event === 'reset').map(([uid]) => uid).sort((a, b) => a - b);

test('a WAN IP change restarts the SFU once, resets live rooms, and participants can rejoin on the new address', async () => {
  const ctx = await setup(45330);
  const { sfu, ss, sent, room } = ctx;
  try {
    const lanHost = sfu.status().startedWith.resolvedHost;
    await ss.join(room, 1, { sfu: true });
    await ss.join(room, 2, { sfu: true });
    await ok(ss, 1, room, 'caps');
    await ok(ss, 2, room, 'caps');
    voice.forceMute(room, 2);
    const r = await manager.checkWanIp({ detect: async () => '203.0.113.7' });
    assert.equal(r.changed, true);
    assert.deepEqual(resets(sent), [1, 2]);
    assert.deepEqual(voice.participants(room), []);
    const st = sfu.status();
    assert.equal(st.running, true);
    assert.equal(st.startedWith.resolvedHost, '203.0.113.7');
    assert.equal(st.lastAutoRestart.from, lanHost);
    assert.equal(st.lastAutoRestart.to, '203.0.113.7');
    assert.equal(st.lastAutoRestart.ok, true);
    assert.deepEqual(await ss.join(room, 1, { sfu: true }), { ok: true });
    assert.deepEqual(await ss.join(room, 2, { sfu: true }), { ok: true });
    assert.equal(voice.modeOf(room), 'sfu');
    assert.equal(voice.isForceMuted(room, 2), true, 'force-mutes survive the restart');
    const t = await ok(ss, 1, room, 'create_transport', { direction: 'send' });
    assert.ok(t.iceCandidates.every((c) => c.address === '203.0.113.7'));
  } finally {
    await cleanup(ctx);
  }
});

test('an unchanged IP does nothing; the first check after boot restarts only when the host differs', async () => {
  const ctx = await setup(45331, { externalIp: '203.0.113.8' });
  const { sfu, sent } = ctx;
  try {
    assert.equal(sfu.status().startedWith.resolvedHost, '203.0.113.8');
    await manager.checkWanIp({ detect: async () => '203.0.113.8' });
    assert.equal(sfu.status().lastAutoRestart, null);
    assert.deepEqual(sent, []);
    config.save({ turn: { externalIp: '' } });
    await manager.checkWanIp({ detect: async () => '203.0.113.8' });
    assert.equal(sfu.status().lastAutoRestart, null, 'stored IP and announced host agree again after the check');
  } finally {
    await cleanup(ctx);
  }
});

test('the first check after a LAN-fallback boot restarts the SFU onto the public address, with no rooms live', async () => {
  const ctx = await setup(45332);
  const { sfu, sent } = ctx;
  try {
    assert.equal(sfu.status().startedWith.resolvedIsLan, true);
    await manager.checkWanIp({ detect: async () => '203.0.113.9' });
    assert.equal(sfu.status().startedWith.resolvedHost, '203.0.113.9');
    assert.equal(sfu.status().startedWith.resolvedIsLan, false);
    assert.deepEqual(sent, []);
  } finally {
    await cleanup(ctx);
  }
});

test('a manually set announcedHost never auto-restarts', async () => {
  const ctx = await setup(45333, { announcedHost: '198.51.100.9' });
  const { sfu } = ctx;
  try {
    await manager.checkWanIp({ detect: async () => '203.0.113.10' });
    assert.equal(sfu.status().lastAutoRestart, null);
    assert.equal(sfu.status().startedWith.resolvedHost, '198.51.100.9');
  } finally {
    await cleanup(ctx);
  }
});

test('concurrent triggers collapse into one restart; a second change inside the window is applied after it', async () => {
  const ctx = await setup(45334, { restartDebounceMs: 400 });
  const { sfu, ss, sent, room } = ctx;
  try {
    await ss.join(room, 1, { sfu: true });
    await ok(ss, 1, room, 'caps');
    config.save({ turn: { externalIp: '203.0.113.11' } });
    const a = ss.restartForAnnouncedChange();
    const b = ss.restartForAnnouncedChange();
    assert.equal(a, b);
    assert.deepEqual(await Promise.all([a, b]), [true, true]);
    assert.deepEqual(resets(sent), [1]);
    const first = sfu.status().lastAutoRestart;
    await ss.join(room, 1, { sfu: true });
    await ok(ss, 1, room, 'caps');
    config.save({ turn: { externalIp: '203.0.113.12' } });
    assert.equal(await ss.restartForAnnouncedChange(), false, 'inside the window: deferred');
    assert.equal(sfu.status().startedWith.resolvedHost, '203.0.113.11');
    assert.equal(await ss.restartForAnnouncedChange(), false, 'a second deferred trigger adds no second timer');
    assert.equal(await until(() => sfu.status().startedWith?.resolvedHost === '203.0.113.12', 3000), true, 'applied once the window ends');
    await until(() => sfu.status().lastAutoRestart !== first && sfu.status().running);
    assert.equal(sfu.status().lastAutoRestart.to, '203.0.113.12');
    assert.deepEqual(resets(sent), [1, 1], 'exactly one more reset');
  } finally {
    await cleanup(ctx);
  }
});

test('a failed automatic restart is retried with backoff and recovers', async () => {
  const ctx = await setup(45335, { restartRetryMs: [100, 100] });
  const { sfu } = ctx;
  const blocker = dgram.createSocket('udp4');
  await new Promise((r) => blocker.bind(45336, '0.0.0.0', r));
  try {
    config.save({ turn: { externalIp: '203.0.113.13' }, voice: { sfu: { port: 45336 } } });
    assert.equal(await sfu.restartIfAnnouncedChanged(), true);
    assert.equal(sfu.status().running, false);
    assert.equal(sfu.status().lastAutoRestart.ok, false);
    await new Promise((r) => blocker.close(r));
    assert.equal(await until(() => sfu.status().running, 5000), true, 'the retry brings the SFU back');
    assert.equal(sfu.status().lastAutoRestart.ok, true);
    assert.equal(sfu.status().startedWith.resolvedHost, '203.0.113.13');
  } finally {
    try { blocker.close(); } catch { /* closed */ }
    await cleanup(ctx);
  }
});

test('switching to mesh while a restart runs is not recorded as a failure', async () => {
  const ctx = await setup(45337, { restartRetryMs: [50] });
  const { sfu } = ctx;
  try {
    config.save({ turn: { externalIp: '203.0.113.14' }, voice: { mode: 'mesh' } });
    assert.equal(await sfu.restartIfAnnouncedChanged(), true);
    assert.equal(sfu.status().running, false);
    assert.equal(sfu.status().lastAutoRestart, null);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(sfu.status().running, false);
  } finally {
    await cleanup(ctx);
  }
});

test('stop() during a restart waits for it and leaves the SFU stopped', async () => {
  const ctx = await setup(45338, { restartDebounceMs: 50 });
  const { sfu } = ctx;
  try {
    config.save({ turn: { externalIp: '203.0.113.15' } });
    const restarting = sfu.restartIfAnnouncedChanged();
    await sfu.stop();
    await restarting;
    assert.equal(sfu.status().running, false);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(sfu.status().running, false, 'nothing respawns after stop');
  } finally {
    await cleanup(ctx);
  }
});

test('a join while the SFU is still starting waits for it instead of opening a mesh room', async () => {
  config.save({ turn: { externalIp: '', advertisedHost: '' }, voice: { mode: 'sfu', sfu: { port: 45345, workers: 1, announcedHost: '127.0.0.1', enableTcp: false, maxKbpsPerUser: 0 } } });
  const sfu = createSfu({ load: config.load, probe: () => ({ ok: true }) });
  const ss = createSfuSocket({ sfu, notifyUser: () => {} });
  const room = nextRoom++;
  const starting = ss.start(null);
  const joined = await ss.join(room, 1, { sfu: true });
  await starting;
  try {
    assert.equal(joined.ok, true);
    assert.equal(voice.modeOf(room), 'sfu');
  } finally {
    await cleanup({ sfu, room });
  }
});
