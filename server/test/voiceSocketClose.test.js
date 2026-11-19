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
const voice = require('../socket/voice');
const socket = require('../socket');
const sfuLib = require('../lib/sfu');
const { createSession } = require('../lib/session');

const mkUser = (n) => Number(db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)').run(n, `${n}@t.local`, 'h', n).lastInsertRowid);

function connect(port, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie: `dismesh_session=${token}` } });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextMessage(ws, pred) {
  return new Promise((resolve) => {
    const onMsg = (raw) => {
      const m = JSON.parse(raw.toString());
      if (pred(m)) { ws.off('message', onMsg); resolve(m); }
    };
    ws.on('message', onMsg);
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

const closed = (ws) => new Promise((resolve) => { ws.once('close', resolve); ws.close(); });

async function startServer(t) {
  const server = http.createServer();
  const wss = socket.attach(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  return { port: server.address().port, wss };
}

// Connects and returns the client socket plus its server-side counterpart.
async function connectPair(srv, token) {
  const before = new Set(srv.wss.clients);
  const client = await connect(srv.port, token);
  await until(() => srv.wss.clients.size > before.size);
  const server = [...srv.wss.clients].find((s) => !before.has(s));
  return { client, server };
}

function dmFor(prefix) {
  const a = mkUser(`${prefix}_a`);
  const b = mkUser(`${prefix}_b`);
  const dm = Number(db.prepare('INSERT INTO dm_channels (is_group, created_by) VALUES (?, ?)').run(0, a).lastInsertRowid);
  for (const u of [a, b]) db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?)').run(dm, u);
  return { a, dm, token: createSession(a, 'test', '127.0.0.1').token, room: voice.dmRoomKey(dm) };
}

// SFU joins wait on openRoom; the stub holds them until the test releases the gate.
function stubSfu(t) {
  const sfu = { left: [], opens: 0, gate: null };
  const orig = { effectiveMode: sfuLib.effectiveMode, openRoom: sfuLib.openRoom, leave: sfuLib.leave };
  sfuLib.effectiveMode = () => 'sfu';
  sfuLib.openRoom = () => { sfu.opens++; return sfu.gate?.promise; };
  sfuLib.leave = async (key, uid) => { sfu.left.push([key, uid]); };
  sfu.hold = () => { let release; sfu.gate = { promise: new Promise((r) => { release = r; }) }; sfu.gate.release = release; };
  sfu.release = () => { const g = sfu.gate; sfu.gate = null; g.release(); };
  t.after(() => Object.assign(sfuLib, orig));
  return sfu;
}

async function joinDm(ws, dm) {
  const joined = nextMessage(ws, (m) => m.type === 'voice_state' && m.dmChannelId === dm);
  ws.send(JSON.stringify({ type: 'voice_join', dmChannelId: dm, sfu: true }));
  return joined;
}

test('closing a second socket of a user does not end the call held on another socket', async (t) => {
  const srv = await startServer(t);
  const { a, dm, token, room } = dmFor('vclose');

  const callSocket = await connect(srv.port, token);
  await joinDm(callSocket, dm);
  assert.equal(voice.isParticipant(room, a), true);

  const otherTab = await connect(srv.port, token);
  await closed(otherTab);
  assert.equal(await until(() => !voice.isParticipant(room, a), 300), false, 'the call survives another tab closing');

  await closed(callSocket);
  assert.equal(await until(() => !voice.isParticipant(room, a)), true, 'closing the socket that joined still leaves the call');
});

test('a stale holder plus a close during an SFU join leaves no ghost behind', async (t) => {
  const srv = await startServer(t);
  const { a, dm, token, room } = dmFor('vrace');
  const sfu = stubSfu(t);

  // Socket A joins and leaves its call but stays open.
  const sockA = await connect(srv.port, token);
  await joinDm(sockA, dm);
  const leftA = nextMessage(sockA, (m) => m.type === 'voice_state' && m.dmChannelId === dm);
  sockA.send(JSON.stringify({ type: 'voice_leave', dmChannelId: dm }));
  await leftA;
  assert.equal(voice.isParticipant(room, a), false);

  // Socket B joins; it closes, and the server handles that close, while openRoom is still pending.
  sfu.hold();
  const b = await connectPair(srv, token);
  const opens = sfu.opens;
  b.client.send(JSON.stringify({ type: 'voice_join', dmChannelId: dm, sfu: true }));
  assert.equal(await until(() => sfu.opens > opens), true, 'B is joining');
  sfu.left.length = 0;
  await closed(b.client);
  assert.equal(await until(() => !srv.wss.clients.has(b.server)), true, 'the server handled B closing');
  sfu.release();

  assert.equal(await until(() => !voice.isParticipant(room, a)), true, 'no ghost participant');
  assert.equal(await until(() => sfu.left.some(([key, uid]) => key === room && uid === a)), true, 'the SFU peer is released');

  const other = dmFor('vrace2');
  db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?)').run(other.dm, a);
  assert.ok((await joinDm(sockA, other.dm)).participants.some((u) => u.id === a), 'the user can join another room');
  await closed(sockA);
  assert.equal(await until(() => !voice.isParticipant(other.room, a)), true);
});

test('a second tab closing mid-join of the same room keeps the call held by the first tab', async (t) => {
  const srv = await startServer(t);
  const { a, dm, token, room } = dmFor('vtwotab');
  const sfu = stubSfu(t);

  const sockA = await connect(srv.port, token);
  await joinDm(sockA, dm);

  sfu.hold();
  const b = await connectPair(srv, token);
  const opens = sfu.opens;
  b.client.send(JSON.stringify({ type: 'voice_join', dmChannelId: dm, sfu: true }));
  assert.equal(await until(() => sfu.opens > opens), true, 'B is joining');
  sfu.left.length = 0;
  await closed(b.client);
  assert.equal(await until(() => !srv.wss.clients.has(b.server)), true, 'the server handled B closing');
  sfu.release();

  assert.equal(await until(() => !voice.isParticipant(room, a) || sfu.left.length > 0, 300), false, 'the user stays in the room and keeps the SFU peer');

  await closed(sockA);
  assert.equal(await until(() => !voice.isParticipant(room, a)), true, 'the first tab still owns the call');
});

test('the only socket closing just as its SFU join resolves leaves no ghost behind', async (t) => {
  const srv = await startServer(t);
  const { a, dm, token, room } = dmFor('vonly');
  const sfu = stubSfu(t);

  sfu.hold();
  const b = await connectPair(srv, token);
  // Release the join the moment the server starts closing B (state CLOSING), which is before B's
  // close handler can run, so the join resolves on a socket that is no longer open.
  const close = b.server.close;
  b.server.close = function (...args) {
    const r = close.apply(this, args);
    sfu.release();
    return r;
  };
  let inRoomAtClose = null;
  b.server.prependListener('close', () => { inRoomAtClose = voice.isParticipant(room, a); });
  b.client.send(JSON.stringify({ type: 'voice_join', dmChannelId: dm, sfu: true }));
  assert.equal(await until(() => voice.isParticipant(room, a)), true, 'B is joining');
  await closed(b.client);

  assert.equal(await until(() => inRoomAtClose !== null), true);
  assert.equal(inRoomAtClose, false, 'the join itself dropped the closed socket\'s membership, before the close handler');
  assert.equal(await until(() => !voice.isParticipant(room, a)), true, 'no ghost participant');
  assert.equal(await until(() => sfu.left.some(([key, uid]) => key === room && uid === a)), true, 'the SFU peer is released');

  const sockC = await connect(srv.port, token);
  await joinDm(sockC, dm);
  await closed(sockC);
  assert.equal(await until(() => !voice.isParticipant(room, a)), true, 'no stale holder keeps a later call alive');
});

test('a pending join overtaken by the holder socket closing is told it was cancelled', async (t) => {
  const srv = await startServer(t);
  const { a, dm, token, room } = dmFor('vcancel');
  const sfu = stubSfu(t);

  const sockA = await connect(srv.port, token);
  await joinDm(sockA, dm);

  sfu.hold();
  const b = await connectPair(srv, token);
  const opens = sfu.opens;
  const denied = nextMessage(b.client, (m) => m.type === 'voice_join_denied');
  b.client.send(JSON.stringify({ type: 'voice_join', dmChannelId: dm, sfu: true }));
  assert.equal(await until(() => sfu.opens > opens), true, 'B is joining');
  await closed(sockA);
  assert.equal(await until(() => !voice.isParticipant(room, a)), true, 'closing the holder ended the call');
  sfu.release();

  assert.deepEqual(await denied, { type: 'voice_join_denied', dmChannelId: dm, reason: 'cancelled' });
  assert.equal(voice.isParticipant(room, a), false);
  await closed(b.client);
});

test('joining the same call from a second tab tells the first tab its call moved', async (t) => {
  const srv = await startServer(t);
  const { a, dm, token, room } = dmFor('vmoved');

  const sockA = await connect(srv.port, token);
  await joinDm(sockA, dm);
  const moved = nextMessage(sockA, (m) => m.type === 'voice_join_denied');
  const sockB = await connect(srv.port, token);
  const bFrames = [];
  sockB.on('message', (raw) => bFrames.push(JSON.parse(raw.toString())));
  await joinDm(sockB, dm);
  const m = await moved;
  assert.deepEqual({ dm: m.dmChannelId, reason: m.reason }, { dm, reason: 'moved' });
  assert.equal(bFrames.some((f) => f.type === 'voice_join_denied'), false, 'the new tab is not told anything');

  await closed(sockA);
  assert.equal(await until(() => !voice.isParticipant(room, a), 300), false, 'the old tab closing keeps the call');
  await closed(sockB);
  assert.equal(await until(() => !voice.isParticipant(room, a)), true);
});
