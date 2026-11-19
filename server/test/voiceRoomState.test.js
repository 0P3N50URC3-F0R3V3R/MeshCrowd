'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const { db } = require('../db');
const config = require('../lib/config');
const logger = require('../lib/logger');
const hub = require('../socket/hub');
const voice = require('../socket/voice');
const stage = require('../socket/stage');
const whiteboard = require('../lib/whiteboard');
const socket = require('../socket');
const sfuLib = require('../lib/sfu');
const sfuSocket = require('../socket/sfu');
const { PERMISSIONS } = require('../lib/permissions');
const { createSession } = require('../lib/session');

const mkUser = (n) => Number(db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)').run(n, `${n}@t.local`, 'h', n).lastInsertRowid);
const token = (uid) => createSession(uid, 'test', '127.0.0.1').token;

function mkServer(owner, members) {
  const id = Number(db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)').run('Srv', owner, `i${Math.random()}`).lastInsertRowid);
  for (const uid of [owner, ...members]) db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(id, uid);
  db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 0, 1)').run(id, '@everyone', PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.SEND_MESSAGES);
  return id;
}
const mkChannel = (sid, type) => Number(db.prepare('INSERT INTO channels (server_id, name, type) VALUES (?, ?, ?)').run(sid, type, type).lastInsertRowid);

function connect(port, tok) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie: `dismesh_session=${tok}` } });
    ws.received = [];
    ws.on('message', (raw) => ws.received.push(JSON.parse(raw.toString())));
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
  return true;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const closed = (ws) => new Promise((resolve) => { if (ws.readyState === ws.CLOSED) resolve(); else { ws.once('close', resolve); ws.close(); } });

let srv;
test.before(async () => {
  const server = http.createServer();
  const wss = socket.attach(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  srv = { server, wss, port: server.address().port };
});
test.after(async () => {
  await sfuSocket.stop();
  await new Promise((r) => srv.server.close(r));
});

async function joinChannel(ws, channelId, uid) {
  ws.send(JSON.stringify({ type: 'voice_join', channelId }));
  assert.equal(await until(() => voice.isParticipant(channelId, uid) && ws.received.some((m) => m.type === 'voice_state' && m.channelId === channelId && m.participants.some((p) => p.id === uid))), true);
}

test('an invited stage speaker stays a speaker across an in-place rejoin; a real leave still demotes', async () => {
  const owner = mkUser('rs_owner');
  const member = mkUser('rs_member');
  const ch = mkChannel(mkServer(owner, [member]), 'stage');
  const wo = await connect(srv.port, token(owner));
  const wm = await connect(srv.port, token(member));
  try {
    await joinChannel(wo, ch, owner);
    await joinChannel(wm, ch, member);
    assert.equal(stage.isSpeaker(ch, member), false);
    stage.inviteSpeaker(ch, member);

    wm.received.length = 0;
    await joinChannel(wm, ch, member);
    assert.equal(stage.isSpeaker(ch, member), true, 'the retry rejoin keeps the invited speaker');

    wm.send(JSON.stringify({ type: 'voice_leave', channelId: ch }));
    assert.equal(await until(() => !voice.isParticipant(ch, member)), true);
    wm.received.length = 0;
    await joinChannel(wm, ch, member);
    assert.equal(stage.isSpeaker(ch, member), false, 'a real leave demotes');
  } finally {
    await closed(wo);
    await closed(wm);
    await until(() => voice.participants(ch).length === 0);
  }
});

test('a DM caller rejoining in place does not ring the other member again', async () => {
  const a = mkUser('rs_dm_a');
  const b = mkUser('rs_dm_b');
  const dm = Number(db.prepare('INSERT INTO dm_channels (is_group, created_by) VALUES (?, ?)').run(0, a).lastInsertRowid);
  for (const u of [a, b]) db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?)').run(dm, u);
  const wa = await connect(srv.port, token(a));
  const wb = await connect(srv.port, token(b));
  const rings = () => wb.received.filter((m) => m.type === 'voice_ring').length;
  const states = () => wa.received.filter((m) => m.type === 'voice_state' && m.dmChannelId === dm).length;
  try {
    wa.send(JSON.stringify({ type: 'voice_join', dmChannelId: dm }));
    assert.equal(await until(() => rings() === 1), true);
    const before = states();
    wa.send(JSON.stringify({ type: 'voice_join', dmChannelId: dm }));
    assert.equal(await until(() => states() > before), true);
    await sleep(100);
    assert.equal(rings(), 1);
  } finally {
    await closed(wa);
    await closed(wb);
  }
});

test('a frame over 2 MiB closes the socket with 1009; normal frames still work', async () => {
  const u = mkUser('rs_payload');
  const ok = await connect(srv.port, token(u));
  ok.send(JSON.stringify({ type: 'ping' }));
  assert.equal(await until(() => ok.received.some((m) => m.type === 'pong')), true);
  ok.send(JSON.stringify({ type: 'typing', scopeType: 'dm', scopeId: 1, pad: 'x'.repeat(1024 * 1024) }));
  ok.send(JSON.stringify({ type: 'ping' }));
  assert.equal(await until(() => ok.received.filter((m) => m.type === 'pong').length === 2), true, 'a 1 MiB frame is accepted');
  const logged = [];
  const prevLevel = logger.getLevel();
  logger.setLevel('debug');
  const off = logger.subscribe((e) => { if (e.level === 'debug') logged.push(e); });
  const big = await connect(srv.port, token(u));
  const code = new Promise((resolve) => big.once('close', (c) => resolve(c)));
  big.send(JSON.stringify({ type: 'typing', pad: 'x'.repeat(2 * 1024 * 1024 + 16) }));
  assert.equal(await code, 1009);
  assert.equal(await until(() => logged.some((e) => e.category === 'ws' && /Max payload/.test(e.message))), true, 'the swallowed error is logged at debug level');
  logger.setLevel(prevLevel);
  off();
  await closed(ok);
});

test('a room reset that nobody rejoins drops its whiteboard and the friends activity', async () => {
  const u1 = mkUser('rs_ev1');
  const u2 = mkUser('rs_ev2');
  const u3 = mkUser('rs_ev3');
  const ch = mkChannel(mkServer(u1, [u2, u3]), 'voice');
  const dmKey = voice.dmRoomKey(987654);
  const other = mkChannel(mkServer(u1, [u2]), 'voice');
  config.save({ turn: { externalIp: '' }, voice: { mode: 'sfu', sfu: { port: 45340, workers: 1, announcedHost: '', enableTcp: false } } });
  socket.setEvictCleanupMs(100);
  const friends = [];
  const origFriends = hub.broadcastToFriends;
  hub.broadcastToFriends = (uid, payload) => friends.push([uid, payload.channel]);
  try {
    await sfuSocket.start();
    assert.equal(sfuLib.status().running, true);
    for (const uid of [u1, u2, u3]) assert.deepEqual(await sfuSocket.join(ch, uid, { sfu: true }), { ok: true });
    const draw = (room, uid, id) => whiteboard.applyStroke(room, uid, { strokeId: id, color: whiteboard.PALETTE[0], width: whiteboard.WIDTHS[0], points: [0, 0, 0.5, 0.5] }, { participant: true, canDraw: true });
    assert.equal(draw(ch, u1, 's1').ok, true);
    config.save({ turn: { externalIp: '203.0.113.40' } });
    assert.equal(await sfuSocket.restartForAnnouncedChange(), true);
    assert.deepEqual(voice.participants(ch), []);
    assert.deepEqual(await sfuSocket.join(other, u2, { sfu: true }), { ok: true });
    assert.deepEqual(await sfuSocket.join(dmKey, u3, { sfu: true }), { ok: true });
    assert.equal(await until(() => friends.length >= 1, 1000), true);
    await sleep(100);
    assert.equal(whiteboard.strokeCount(ch), 0, 'the whiteboard of the abandoned room is dropped');
    assert.deepEqual(friends.sort((a, b) => a[0] - b[0]), [[u1, null], [u3, null]], 'u2 is in another channel and stays; u3 is only in a DM call, which friends never see');
  } finally {
    hub.broadcastToFriends = origFriends;
    for (const room of [ch, other, dmKey]) for (const uid of voice.participants(room)) voice.leave(room, uid);
    await sfuSocket.stop();
  }
});
