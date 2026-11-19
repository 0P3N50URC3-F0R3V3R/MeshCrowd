'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const express = require('express');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const { db } = require('../db');
const { OWNER_SITE_PERMISSIONS, SITE_PERMISSIONS } = require('../lib/permissions');
const turnManager = require('../lib/turn/manager');
const appConfig = require('../lib/config');

const mkUser = (n) => Number(db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)').run(n, `${n}@t.local`, 'h', n).lastInsertRowid);

let server; let base; let admin; let staff;
test.before(async () => {
  admin = mkUser('calls_admin');
  staff = mkUser('calls_staff');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const uid = Number(req.headers['x-uid']);
    if (uid) {
      req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
      req.sitePermissions = uid === admin ? OWNER_SITE_PERMISSIONS : SITE_PERMISSIONS.VIEW_ADMIN_PANEL;
    }
    next();
  });
  app.use('/api/admin', require('../routes/admin'));
  app.get('/api/voice/ice', require('../middleware/auth').requireAuth, (req, res) => res.json(turnManager.iceServersFor(req.user, req.hostname)));
  await new Promise((r) => { server = http.createServer(app).listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await turnManager.stop();
  server.close();
  db.close();
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const call = async (method, url, uid, json) => {
  const res = await fetch(base + url, {
    method, headers: { 'x-uid': String(uid), ...(json ? { 'content-type': 'application/json' } : {}) }, body: json ? JSON.stringify(json) : undefined,
  });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, data };
};

test('call settings are for site administrators only and never expose the secret', async () => {
  assert.equal((await call('GET', '/api/admin/calls', staff)).status, 403);
  assert.equal((await call('PATCH', '/api/admin/calls', staff, { turn: { enabled: true } })).status, 403);
  const res = await call('GET', '/api/admin/calls', admin);
  assert.equal(res.status, 200);
  assert.equal(res.data.turn.enabled, false);
  assert.equal(res.data.turn.secretSet, true);
  assert.equal(res.data.turn.secret, undefined);
  assert.equal(res.data.status.running, false);
});

test('the built-in server is off by default and hands out no credentials', () => {
  const ice = turnManager.iceServersFor({ id: 1 }, 'chat.example.com');
  assert.deepEqual(ice.iceServers, []);
  assert.equal(ice.builtIn, false);
});

test('invalid settings are rejected', async () => {
  const bad = [
    { turn: { port: 0 } }, { turn: { port: 70000 } }, { turn: { enabled: 'yes' } }, { turn: { externalIp: 'not an ip' } },
    { turn: { relayPortMin: 50000, relayPortMax: 50003 } }, { turn: { realm: 'bad realm!' } }, { turn: { maxKbps: -1 } },
    { turn: { advertisedHost: 'host/with/slash' } }, { iceServers: [{ urls: 'http://nope' }] }, { iceServers: 'x' },
    { iceServers: new Array(11).fill({ urls: 'stun:a.example.com:3478' }) },
  ];
  for (const body of bad) assert.equal((await call('PATCH', '/api/admin/calls', admin, body)).status, 400, JSON.stringify(body));
});

test('enabling starts the relay live, signed-in users get time-limited credentials, disabling stops it', async () => {
  const on = await call('PATCH', '/api/admin/calls', admin, {
    turn: { enabled: true, port: 23478, listenAddress: '127.0.0.1', externalIp: '203.0.113.9', relayPortMin: 55000, relayPortMax: 55050 },
  });
  assert.equal(on.status, 200);
  assert.equal(on.data.status.running, true);
  assert.equal(on.data.status.port, 23478);

  const ice = await call('GET', '/api/voice/ice', staff);
  assert.equal(ice.data.builtIn, true);
  const turn = ice.data.iceServers.find((s) => s.username);
  assert.ok(turn.urls.every((u) => u.startsWith('turn:203.0.113.9:23478')));
  assert.ok(Number(turn.username.split(':')[0]) * 1000 > Date.now());
  assert.ok(ice.data.iceServers.some((s) => s.urls[0] === 'stun:203.0.113.9:23478'));

  const test1 = await call('POST', '/api/admin/calls/test', admin);
  assert.equal(test1.data.checks.find((c) => c.name === 'allocate').ok, true);

  const secretBefore = appConfig.load().turn.secret;
  await call('PATCH', '/api/admin/calls', admin, { turn: { rotateSecret: true } });
  assert.notEqual(appConfig.load().turn.secret, secretBefore);

  const off = await call('PATCH', '/api/admin/calls', admin, { turn: { enabled: false } });
  assert.equal(off.data.status.running, false);
});

test('external ICE servers are stored, served to signed-in users and credential-free ones to everyone', async () => {
  const put = await call('PATCH', '/api/admin/calls', admin, {
    iceServers: [{ urls: 'stun:stun.example.com:3478' }, { urls: ['turn:turn.example.com:3478'], username: 'u', credential: 'p' }],
  });
  assert.equal(put.status, 200);
  assert.equal(put.data.iceServers.length, 2);
  const ice = await call('GET', '/api/voice/ice', staff);
  assert.equal(ice.data.iceServers.length, 2);
  assert.deepEqual(turnManager.publicIceServers(), [{ urls: 'stun:stun.example.com:3478' }]);
});

test('a port that is already taken is reported, not thrown', async () => {
  const dgram = require('node:dgram');
  const blocker = dgram.createSocket('udp4');
  await new Promise((r) => blocker.bind(23999, '127.0.0.1', r));
  const res = await call('PATCH', '/api/admin/calls', admin, { turn: { enabled: true, port: 23999, listenAddress: '127.0.0.1' } });
  assert.equal(res.status, 200);
  assert.equal(res.data.status.running, false);
  assert.match(res.data.status.error, /already in use/);
  blocker.close();
  await call('PATCH', '/api/admin/calls', admin, { turn: { enabled: false } });
});

test('lanNetworks are validated, stored and returned by the admin API', async () => {
  const bad = [{ lanNetworks: 'x' }, { lanNetworks: ['nope'] }, { lanNetworks: ['1.2.3.4'] }, { lanNetworks: ['300.0.0.0/8'] }, { lanNetworks: ['10.0.0.0/33'] }, { lanNetworks: [5] }, { lanNetworks: new Array(33).fill('10.0.0.0/8') }];
  for (const body of bad) assert.equal((await call('PATCH', '/api/admin/calls', admin, body)).status, 400, JSON.stringify(body));
  assert.equal((await call('PATCH', '/api/admin/calls', staff, { lanNetworks: ['10.0.0.0/8'] })).status, 403);
  const put = await call('PATCH', '/api/admin/calls', admin, { lanNetworks: [' 26.0.0.0/8 ', '192.168.3.0/24'] });
  assert.equal(put.status, 200);
  assert.deepEqual(put.data.lanNetworks, ['26.0.0.0/8', '192.168.3.0/24']);
  assert.deepEqual(appConfig.load().lanNetworks, ['26.0.0.0/8', '192.168.3.0/24']);
  assert.deepEqual((await call('PATCH', '/api/admin/calls', admin, { lanNetworks: [] })).data.lanNetworks, []);
});

const sfuFacade = require('../lib/sfu');
const sfuSocket = require('../socket/sfu');

test('GET calls includes voice with mode mesh by default', async () => {
  const res = await call('GET', '/api/admin/calls', admin);
  assert.equal(res.status, 200);
  const v = res.data.voice;
  assert.equal(v.mode, 'mesh');
  assert.equal(v.effectiveMode, 'mesh');
  assert.equal(typeof v.available, 'boolean');
  assert.deepEqual(v.sfu, { port: 40000, workers: 0, announcedHost: '', enableTcp: true, maxKbpsPerUser: 0 });
  assert.equal(v.restartRequired, false);
  assert.equal(typeof v.announcedIsLan, 'boolean');
  for (const k of ['rooms', 'transports', 'producers', 'consumers', 'bytesIn', 'bytesOut', 'connectFailures']) assert.equal(v.status[k], 0, k);
  assert.equal(res.data.status.running, false);
});

test('PATCH voice.mode sfu persists and is reflected', async () => {
  const origStart = sfuSocket.start;
  let started = 0;
  sfuSocket.start = async () => { started++; };
  try {
    const res = await call('PATCH', '/api/admin/calls', admin, { voice: { mode: 'sfu', sfu: { port: 41234, workers: 2, announcedHost: 'v.example.com', enableTcp: false, maxKbpsPerUser: 500 } } });
    assert.equal(res.status, 200);
    assert.equal(res.data.voice.mode, 'sfu');
    assert.deepEqual(res.data.voice.sfu, { port: 41234, workers: 2, announcedHost: 'v.example.com', enableTcp: false, maxKbpsPerUser: 500 });
    assert.equal(started, 1);
    assert.equal(appConfig.load().voice.mode, 'sfu');
    assert.equal(appConfig.load().voice.sfu.port, 41234);
    assert.equal((await call('GET', '/api/admin/calls', admin)).data.voice.mode, 'sfu');
    const back = await call('PATCH', '/api/admin/calls', admin, { voice: { mode: 'mesh' } });
    assert.equal(back.data.voice.mode, 'mesh');
    assert.equal(back.data.voice.sfu.port, 41234);
    assert.equal(started, 1);
  } finally {
    sfuSocket.start = origStart;
    appConfig.save({ voice: { mode: 'mesh', sfu: { port: 40000, workers: 0, announcedHost: '', enableTcp: true, maxKbpsPerUser: 0 } } });
    sfuFacade.refreshMode();
  }
});

test("PATCH voice.mode 'x' is rejected 400", async () => {
  const bad = [
    { voice: { mode: 'x' } }, { voice: 'sfu' }, { voice: { mode: 5 } }, { voice: { sfu: { port: 0 } } }, { voice: { sfu: { port: 65536 } } },
    { voice: { sfu: { workers: 17 } } }, { voice: { sfu: { workers: 1.5 } } }, { voice: { sfu: { enableTcp: 'yes' } } },
    { voice: { sfu: { announcedHost: 'a/b' } } }, { voice: { sfu: { announcedHost: 5 } } }, { voice: { sfu: { maxKbpsPerUser: -1 } } }, { voice: { sfu: [] } },
  ];
  for (const body of bad) assert.equal((await call('PATCH', '/api/admin/calls', admin, body)).status, 400, JSON.stringify(body));
  assert.equal(appConfig.load().voice.mode, 'mesh');
});

test('non site-admin PATCH is 403', async () => {
  assert.equal((await call('PATCH', '/api/admin/calls', staff, { voice: { mode: 'sfu' } })).status, 403);
  assert.equal(appConfig.load().voice.mode, 'mesh');
});

test('effectiveMode is mesh and reason is set when the SFU is unavailable', async () => {
  const origAvailable = sfuFacade.available;
  const origStart = sfuSocket.start;
  sfuFacade.available = () => ({ ok: false, reason: 'mediasoup worker binary missing: /x' });
  sfuSocket.start = async () => {};
  try {
    const res = await call('PATCH', '/api/admin/calls', admin, { voice: { mode: 'sfu' } });
    assert.equal(res.data.voice.mode, 'sfu');
    assert.equal(res.data.voice.effectiveMode, 'mesh');
    assert.equal(res.data.voice.available, false);
    assert.match(res.data.voice.reason, /worker binary missing/);
  } finally {
    sfuFacade.available = origAvailable;
    sfuSocket.start = origStart;
    appConfig.save({ voice: { mode: 'mesh' } });
    sfuFacade.refreshMode();
  }
});

test('restartRequired is set when saved SFU settings differ from the running pool', async () => {
  const origStatus = sfuFacade.status;
  const origStats = sfuFacade.stats;
  const startedWith = { port: 40000, workers: 0, announcedHost: '', enableTcp: true, resolvedHost: sfuFacade.announced(appConfig.load()).host, resolvedIsLan: false };
  const running = () => ({ running: true, workers: 1, rooms: 0, transports: 0, producers: 0, consumers: 0, bytesIn: 0, bytesOut: 0, connectFailures: 0, lastConnectFailureAt: null, startedWith });
  sfuFacade.stats = async () => running();
  try {
    assert.equal((await call('GET', '/api/admin/calls', admin)).data.voice.restartRequired, false);
    const res = await call('PATCH', '/api/admin/calls', admin, { voice: { sfu: { port: 41000 } } });
    assert.equal(res.data.voice.restartRequired, true);
    assert.equal((await call('PATCH', '/api/admin/calls', admin, { voice: { sfu: { port: 40000, maxKbpsPerUser: 9 } } })).data.voice.restartRequired, false);
  } finally {
    sfuFacade.status = origStatus;
    sfuFacade.stats = origStats;
    appConfig.save({ voice: { sfu: { port: 40000, maxKbpsPerUser: 0 } } });
  }
});

test('the voice payload follows the running pool: its announced address and a changed public IP', async () => {
  const origStats = sfuFacade.stats;
  const origIp = appConfig.load().turn.externalIp;
  appConfig.save({ turn: { externalIp: '203.0.113.20' }, voice: { sfu: { announcedHost: '' } } });
  const startedWith = { port: 40000, workers: 0, announcedHost: '', enableTcp: true, resolvedHost: '192.168.1.5', resolvedIsLan: true };
  sfuFacade.stats = async () => ({ running: true, workers: 1, rooms: 0, transports: 0, producers: 0, consumers: 0, bytesIn: 0, bytesOut: 0, connectFailures: 0, lastConnectFailureAt: null, startedWith });
  try {
    let v = (await call('GET', '/api/admin/calls', admin)).data.voice;
    assert.equal(v.announcedIsLan, true, 'the running pool announces a LAN address although the config now knows a public one');
    assert.equal(v.restartRequired, true);
    Object.assign(startedWith, { resolvedHost: '203.0.113.20', resolvedIsLan: false });
    v = (await call('GET', '/api/admin/calls', admin)).data.voice;
    assert.equal(v.announcedIsLan, false);
    assert.equal(v.restartRequired, false);
    appConfig.save({ turn: { externalIp: '203.0.113.21' } });
    assert.equal((await call('GET', '/api/admin/calls', admin)).data.voice.restartRequired, true, 'a new public IP needs an SFU restart');
  } finally {
    sfuFacade.stats = origStats;
    appConfig.save({ turn: { externalIp: origIp } });
  }
});

test('recentConnectFailure is set only for a failure within the last 30 minutes', async () => {
  const origStats = sfuFacade.stats;
  let last = null;
  sfuFacade.stats = async () => ({ running: false, workers: 0, rooms: 0, transports: 0, producers: 0, consumers: 0, bytesIn: 0, bytesOut: 0, connectFailures: last ? 3 : 0, lastConnectFailureAt: last, startedWith: null });
  try {
    const recent = async () => (await call('GET', '/api/admin/calls', admin)).data.voice.status;
    assert.equal((await recent()).recentConnectFailure, false);
    last = Date.now() - 60_000;
    const st = await recent();
    assert.equal(st.recentConnectFailure, true);
    assert.equal(st.connectFailures, 3);
    assert.equal(st.lastConnectFailureAt, last);
    last = Date.now() - 31 * 60_000;
    assert.equal((await recent()).recentConnectFailure, false);
  } finally {
    sfuFacade.stats = origStats;
  }
});

test('a TURN address PATCH asks the SFU to follow it, and the payload reports the last automatic restart', async () => {
  const origRestart = sfuSocket.restartForAnnouncedChange;
  const origStats = sfuFacade.stats;
  let restarts = 0;
  sfuSocket.restartForAnnouncedChange = async () => { restarts++; return true; };
  const lastAutoRestart = { at: new Date().toISOString(), from: '192.168.1.5', to: '203.0.113.30', ok: true };
  sfuFacade.stats = async () => ({ running: true, workers: 1, rooms: 0, transports: 0, producers: 0, consumers: 0, bytesIn: 0, bytesOut: 0, connectFailures: 0, lastConnectFailureAt: null, lastAutoRestart, startedWith: null });
  try {
    const res = await call('PATCH', '/api/admin/calls', admin, { turn: { externalIp: '203.0.113.30' } });
    assert.equal(res.status, 200);
    assert.equal(restarts, 1);
    assert.deepEqual(res.data.voice.status.lastAutoRestart, lastAutoRestart);
    await call('PATCH', '/api/admin/calls', admin, { lanNetworks: [] });
    assert.equal(restarts, 1, 'non-TURN changes do not touch the SFU');
  } finally {
    sfuSocket.restartForAnnouncedChange = origRestart;
    sfuFacade.stats = origStats;
    await call('PATCH', '/api/admin/calls', admin, { turn: { externalIp: '' } });
  }
});

test('SFU port ranges past 65535 or overlapping the TURN, HTTP, HTTPS or SSH ports are rejected', async () => {
  appConfig.save({ ssh: { enabled: true } });
  const cfg = appConfig.load();
  const bad = [
    [{ port: 65534, workers: 4 }, /ends above 65535/],
    [{ port: 65533, workers: 0 }, /ends above 65535/],
    [{ port: cfg.turn.port - 1, workers: 2 }, /TURN port/],
    [{ port: cfg.turn.relayPortMin + 3, workers: 1 }, /TURN relay range/],
    [{ port: cfg.port - 3, workers: 0 }, /HTTP port/],
    [{ port: cfg.httpsPort, workers: 1 }, /HTTPS port/],
    [{ port: cfg.ssh.port, workers: 1 }, /SSH console port/],
  ];
  for (const [sfu, msg] of bad) {
    const res = await call('PATCH', '/api/admin/calls', admin, { voice: { sfu } });
    assert.equal(res.status, 400, JSON.stringify(sfu));
    assert.match(res.data.error, msg);
  }
  assert.equal(appConfig.load().voice.sfu.port, cfg.voice.sfu.port);
  const turnMove = await call('PATCH', '/api/admin/calls', admin, { turn: { relayPortMin: 41000, relayPortMax: 41100 }, voice: { sfu: { port: 41050 } } });
  assert.equal(turnMove.status, 400, 'checked against the TURN range saved in the same request');
  const ok = await call('PATCH', '/api/admin/calls', admin, { voice: { sfu: { port: 65532, workers: 4 } } });
  assert.equal(ok.status, 200);
  appConfig.save({ ssh: { enabled: false }, voice: { sfu: { port: 40000, workers: 0 } } });
});

test('only a changed SFU range is checked; HTTPS and SSH count only when enabled; TURN moves are checked in sfu mode', async () => {
  const origStart = sfuSocket.start;
  sfuSocket.start = async () => {};
  const cfg = appConfig.load();
  try {
    appConfig.save({ useHttps: false, ssh: { enabled: false } });
    assert.equal((await call('PATCH', '/api/admin/calls', admin, { voice: { sfu: { port: cfg.httpsPort, workers: 1 } } })).status, 200, 'HTTPS off');
    assert.equal((await call('PATCH', '/api/admin/calls', admin, { voice: { sfu: { port: cfg.ssh.port, workers: 1 } } })).status, 200, 'SSH off');
    appConfig.save({ voice: { sfu: { port: cfg.turn.relayPortMin, workers: 1 } } });
    const rollback = await call('PATCH', '/api/admin/calls', admin, { voice: { mode: 'mesh', sfu: { port: cfg.turn.relayPortMin, workers: 1 } } });
    assert.equal(rollback.status, 200, 'an already stored conflict does not block other saves');
    appConfig.save({ voice: { mode: 'mesh', sfu: { port: cfg.turn.relayPortMin, workers: 1 } } });
    const enable = await call('PATCH', '/api/admin/calls', admin, { voice: { mode: 'sfu' } });
    assert.equal(enable.status, 400, 'switching to sfu with a stored conflicting range is refused');
    appConfig.save({ voice: { mode: 'sfu', sfu: { port: 40000, workers: 1 } } });
    const moveTurn = await call('PATCH', '/api/admin/calls', admin, { turn: { relayPortMin: 39990, relayPortMax: 40010 } });
    assert.equal(moveTurn.status, 400);
    assert.match(moveTurn.data.error, /TURN relay range/);
    appConfig.save({ voice: { mode: 'mesh' } });
    assert.equal((await call('PATCH', '/api/admin/calls', admin, { turn: { relayPortMin: 39990, relayPortMax: 40010 } })).status, 200, 'not checked while the SFU is not in use');
  } finally {
    sfuSocket.start = origStart;
    appConfig.save({ useHttps: true, voice: { mode: 'mesh', sfu: { port: 40000, workers: 0 } }, turn: { relayPortMin: cfg.turn.relayPortMin, relayPortMax: cfg.turn.relayPortMax } });
    sfuFacade.refreshMode();
  }
});
