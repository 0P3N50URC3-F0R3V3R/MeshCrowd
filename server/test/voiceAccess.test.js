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
const { DEFAULT_EVERYONE_PERMISSIONS, PERMISSIONS } = require('../lib/permissions');

const mkUser = (n) => Number(db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)').run(n, `${n}@t.local`, 'h', n).lastInsertRowid);

function world(prefix) {
  const owner = mkUser(`${prefix}_o`);
  const member = mkUser(`${prefix}_m`);
  const server = Number(db.prepare('INSERT INTO servers (name, owner_id) VALUES (?, ?)').run(prefix, owner).lastInsertRowid);
  const everyone = Number(db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 0, 1)').run(server, '@everyone', DEFAULT_EVERYONE_PERMISSIONS).lastInsertRowid);
  for (const u of [owner, member]) db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(server, u);
  const channel = Number(db.prepare("INSERT INTO channels (server_id, name, type) VALUES (?, 'v', 'voice')").run(server).lastInsertRowid);
  return { owner, member, server, everyone, channel };
}

function connect(port, uid) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie: `dismesh_session=${createSession(uid, 'test', '127.0.0.1').token}` } });
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

async function joinBoth(w) {
  const socks = [];
  for (const uid of [w.owner, w.member]) {
    const ws = await connect(port, uid);
    ws.send(JSON.stringify({ type: 'voice_join', channelId: w.channel, sfu: true }));
    assert.ok(await until(() => voice.isParticipant(w.channel, uid)));
    socks.push(ws);
  }
  return socks;
}

const deniedNoAccess = (ws, channel) => until(() => ws.frames.some((f) => f.type === 'voice_join_denied' && f.channelId === channel && f.reason === 'no_access'));

test('a member removed from the server is dropped from its voice room and told so', async () => {
  const w = world('va1');
  const [wsO, wsM] = await joinBoth(w);
  db.prepare('DELETE FROM server_members WHERE server_id = ? AND user_id = ?').run(w.server, w.member);
  socket.revalidateVoiceAccess(w.server);
  assert.equal(voice.isParticipant(w.channel, w.member), false);
  assert.equal(voice.isParticipant(w.channel, w.owner), true);
  assert.ok(await deniedNoAccess(wsM, w.channel));
  assert.equal(wsO.frames.some((f) => f.type === 'voice_join_denied'), false);
  wsO.close(); wsM.close();
  assert.ok(await until(() => voice.participants(w.channel).length === 0));
});

test('a VIEW_CHANNEL deny drops members without it but keeps the owner', async () => {
  const w = world('va2');
  const [wsO, wsM] = await joinBoth(w);
  db.prepare('INSERT INTO channel_role_overrides (channel_id, role_id, allow, deny) VALUES (?, ?, 0, ?)').run(w.channel, w.everyone, PERMISSIONS.VIEW_CHANNEL);
  socket.revalidateVoiceAccess(w.server);
  assert.deepEqual(voice.participants(w.channel), [w.owner]);
  assert.ok(await deniedNoAccess(wsM, w.channel));
  wsO.close(); wsM.close();
  assert.ok(await until(() => voice.participants(w.channel).length === 0));
});

test('a deleted channel empties its room; rooms of other servers are left alone', async () => {
  const w = world('va3');
  const other = world('va3b');
  const [wsO, wsM] = await joinBoth(w);
  const [wsO2, wsM2] = await joinBoth(other);
  db.prepare('DELETE FROM channels WHERE id = ?').run(w.channel);
  socket.revalidateVoiceAccess(w.server);
  assert.deepEqual(voice.participants(w.channel), []);
  assert.ok(await deniedNoAccess(wsO, w.channel));
  assert.equal(voice.participants(other.channel).length, 2);
  for (const ws of [wsO, wsM, wsO2, wsM2]) ws.close();
  assert.ok(await until(() => voice.participants(other.channel).length === 0));
});

test('an emptied stage forgets its speakers, so a dropped speaker rejoins later as audience', async () => {
  const w = world('va4');
  db.prepare("UPDATE channels SET type = 'stage' WHERE id = ?").run(w.channel);
  const stage = require('../socket/stage');
  const [wsO, wsM] = await joinBoth(w);
  wsO.send(JSON.stringify({ type: 'stage_invite_speaker', channelId: w.channel, userId: w.member }));
  assert.ok(await until(() => stage.isSpeaker(w.channel, w.member)));
  wsM.close();
  assert.ok(await until(() => !voice.isParticipant(w.channel, w.member)));
  assert.equal(stage.isSpeaker(w.channel, w.member), true, 'kept while the room is live (reconnect)');
  wsO.send(JSON.stringify({ type: 'voice_leave', channelId: w.channel }));
  assert.ok(await until(() => voice.participants(w.channel).length === 0));
  assert.equal(stage.isSpeaker(w.channel, w.member), false);
  // let the server finish handling the close before the database is closed
  await new Promise((r) => { wsO.once('close', r); wsO.close(); });
  await new Promise((r) => setTimeout(r, 100));
});
