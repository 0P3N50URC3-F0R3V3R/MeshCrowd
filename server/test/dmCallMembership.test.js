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
const { createSession } = require('../lib/session');

const mkUser = (n) => Number(db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)').run(n, `${n}@t.local`, 'h', n).lastInsertRowid);

function connect(port, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie: `dismesh_session=${token}` } });
    ws.frames = [];
    ws.on('message', (raw) => ws.frames.push(JSON.parse(raw.toString())));
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

let server; let port;
test.before(async () => {
  server = http.createServer();
  socket.attach(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
test.after(async () => {
  await new Promise((r) => server.close(r));
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function groupDm(prefix) {
  const ids = ['a', 'b', 'c'].map((s) => mkUser(`${prefix}_${s}`));
  const dm = Number(db.prepare('INSERT INTO dm_channels (is_group, created_by) VALUES (1, ?)').run(ids[0]).lastInsertRowid);
  for (const u of ids) db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?)').run(dm, u);
  return { ids, dm, room: voice.dmRoomKey(dm), token: (uid) => createSession(uid, 'test', '127.0.0.1').token };
}

async function joinCall(g, uid) {
  const ws = await connect(port, g.token(uid));
  ws.send(JSON.stringify({ type: 'voice_join', dmChannelId: g.dm, sfu: true }));
  assert.ok(await until(() => voice.isParticipant(g.room, uid)));
  return ws;
}

test('leaving the conversation drops the user from its call and tells their client', async () => {
  const g = groupDm('dmc1');
  const [a, b] = g.ids;
  const wsA = await joinCall(g, a);
  const wsB = await joinCall(g, b);
  db.prepare('DELETE FROM dm_members WHERE dm_channel_id = ? AND user_id = ?').run(g.dm, b);
  socket.dropFromDmCall(g.dm, [b]);
  assert.equal(voice.isParticipant(g.room, b), false);
  assert.ok(await until(() => wsB.frames.some((f) => f.type === 'voice_join_denied' && f.dmChannelId === g.dm && f.reason === 'cancelled')));
  assert.ok(await until(() => wsA.frames.some((f) => f.type === 'voice_state' && f.dmChannelId === g.dm && f.participants.length === 1)));
  wsA.close(); wsB.close();
  assert.ok(await until(() => voice.participants(g.room).length === 0));
});

test('dropFromDmCall ignores users who are not in the call', async () => {
  const g = groupDm('dmc2');
  const [a, , c] = g.ids;
  const wsA = await joinCall(g, a);
  socket.dropFromDmCall(g.dm, [c]);
  assert.deepEqual(voice.participants(g.room), [a]);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(wsA.frames.some((f) => f.type === 'voice_join_denied'), false);
  wsA.close();
  assert.ok(await until(() => voice.participants(g.room).length === 0));
});

test('a participant who is no longer a member can still leave the call', async () => {
  const g = groupDm('dmc3');
  const [a, b] = g.ids;
  const wsA = await joinCall(g, a);
  const wsB = await joinCall(g, b);
  db.prepare('DELETE FROM dm_members WHERE dm_channel_id = ? AND user_id = ?').run(g.dm, b);
  wsB.send(JSON.stringify({ type: 'voice_leave', dmChannelId: g.dm }));
  assert.ok(await until(() => !voice.isParticipant(g.room, b)));
  assert.equal(voice.isParticipant(g.room, a), true);
  wsA.close(); wsB.close();
  assert.ok(await until(() => voice.participants(g.room).length === 0));
});
