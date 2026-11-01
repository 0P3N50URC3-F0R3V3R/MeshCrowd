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
const { stickersForUser, userCanUseSticker } = require('../lib/stickers');

test.after(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

const KEY = Buffer.alloc(32, 7).toString('base64');
const NONCE = Buffer.alloc(24, 1).toString('base64');
const envelope = () => JSON.stringify({ v: 1, chainIndex: 0, nonce: NONCE, ciphertext: Buffer.from('ciphertext-body-0123456789' + 'x'.repeat(16)).toString('base64') });

function makeUser(username) {
  return db.prepare('INSERT INTO users (username, email, password_hash, display_name, e2ee_public_key) VALUES (?, ?, ?, ?, ?)')
    .run(username, `${username}@test.local`, 'hash', username, KEY).lastInsertRowid;
}
function makeServer(ownerId, name, members = []) {
  const id = db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)').run(name, ownerId, `inv-${name}`).lastInsertRowid;
  for (const u of [ownerId, ...members]) db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(id, u);
  return id;
}
function makeSticker(serverId, name) {
  return db.prepare('INSERT INTO stickers (server_id, name, image_path) VALUES (?, ?, ?)')
    .run(serverId, name, `/uploads/stickers/${name}.png`).lastInsertRowid;
}
function makeDm(a, b, { group = false, extra = [] } = {}) {
  const id = db.prepare('INSERT INTO dm_channels (is_group, created_by) VALUES (?, ?)').run(group ? 1 : 0, a).lastInsertRowid;
  for (const u of [a, b, ...extra]) db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?)').run(id, u);
  return id;
}

async function withApp(fn) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const uid = Number(req.headers['x-test-user']);
    if (uid) req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
    next();
  });
  app.use('/api/dms', require('../routes/dms'));
  app.use('/api/messages', require('../routes/messages'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (userId, method, url, body) => fetch(base + url, {
    method, headers: { 'content-type': 'application/json', 'x-test-user': String(userId) }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  try { await fn(call); } finally { server.close(); }
}

const alice = makeUser('st_alice');
const bob = makeUser('st_bob');
const carol = makeUser('st_carol');
const srvA = makeServer(alice, 'SA', [bob]);
const srvB = makeServer(carol, 'SB');
const stA = makeSticker(srvA, 'wave');
const stB = makeSticker(srvB, 'secret');

test('stickersForUser lists only stickers of servers the user is a member of', () => {
  assert.deepEqual(stickersForUser(alice).map((s) => s.name), ['wave']);
  assert.deepEqual(stickersForUser(carol).map((s) => s.name), ['secret']);
  assert.deepEqual(stickersForUser(makeUser('st_nobody')), []);
});

test('userCanUseSticker follows server membership', () => {
  assert.equal(userCanUseSticker(bob, stA), true);
  assert.equal(userCanUseSticker(bob, stB), false);
  assert.equal(userCanUseSticker(bob, 99999), false);
});

test('GET /api/dms/stickers returns the caller\'s available stickers with server names', async () => {
  await withApp(async (call) => {
    const res = await call(bob, 'GET', '/api/dms/stickers');
    assert.equal(res.status, 200);
    const { stickers } = await res.json();
    assert.equal(stickers.length, 1);
    assert.equal(stickers[0].name, 'wave');
    assert.equal(stickers[0].serverName, 'SA');
    assert.equal(stickers[0].image_path, '/uploads/stickers/wave.png');
  });
});

test('a 1:1 DM can carry a sticker with no text, and the message serializes it', async () => {
  const dm = makeDm(alice, bob);
  await withApp(async (call) => {
    const res = await call(bob, 'POST', `/api/dms/${dm}/messages`, { content: '', stickerId: stA });
    assert.equal(res.status, 201);
    const { message } = await res.json();
    assert.deepEqual(message.sticker, { id: stA, name: 'wave', imagePath: '/uploads/stickers/wave.png' });
    const list = await (await call(alice, 'GET', `/api/dms/${dm}/messages`)).json();
    assert.equal(list.messages.at(-1).sticker.name, 'wave');
  });
});

test('a sticker from a server the sender is not in is rejected; so is an unknown id', async () => {
  const dm = makeDm(alice, bob);
  await withApp(async (call) => {
    assert.equal((await call(bob, 'POST', `/api/dms/${dm}/messages`, { content: 'x', stickerId: stB })).status, 400);
    assert.equal((await call(bob, 'POST', `/api/dms/${dm}/messages`, { content: 'x', stickerId: 424242 })).status, 400);
    assert.equal((await call(bob, 'POST', `/api/dms/${dm}/messages`, { content: '' })).status, 400);
  });
});

test('group DMs accept stickers the sender can use, regardless of the other members', async () => {
  const dm = makeDm(alice, carol, { group: true, extra: [bob] });
  await withApp(async (call) => {
    assert.equal((await call(alice, 'POST', `/api/dms/${dm}/messages`, { content: 'hi', stickerId: stA })).status, 201);
    assert.equal((await call(carol, 'POST', `/api/dms/${dm}/messages`, { content: 'hi', stickerId: stA })).status, 400);
  });
});

test('encrypted DMs never take a server-side sticker reference; it rides inside the envelope', async () => {
  const dm = makeDm(alice, bob);
  db.prepare('UPDATE dm_channels SET e2ee_enabled = 1 WHERE id = ?').run(dm);
  await withApp(async (call) => {
    const bad = await call(bob, 'POST', `/api/dms/${dm}/messages`, { content: envelope(), stickerId: stA });
    assert.equal(bad.status, 400);
    const ok = await call(bob, 'POST', `/api/dms/${dm}/messages`, { content: envelope() });
    assert.equal(ok.status, 201);
    assert.equal((await ok.json()).message.sticker, null);
  });
});

test('editing a sticker message keeps the sticker, and the text may be emptied', async () => {
  const dm = makeDm(alice, bob);
  await withApp(async (call) => {
    const { message } = await (await call(bob, 'POST', `/api/dms/${dm}/messages`, { content: 'caption', stickerId: stA })).json();
    const edited = await call(bob, 'PATCH', `/api/messages/${message.id}`, { content: 'new caption' });
    assert.equal(edited.status, 200);
    assert.equal((await edited.json()).message.sticker.name, 'wave');
    const emptied = await call(bob, 'PATCH', `/api/messages/${message.id}`, { content: '' });
    assert.equal(emptied.status, 200);
    const plain = await (await call(bob, 'POST', `/api/dms/${dm}/messages`, { content: 'plain' })).json();
    assert.equal((await call(bob, 'PATCH', `/api/messages/${plain.message.id}`, { content: '' })).status, 400);
  });
});

test('reply quotes carry the sticker of the quoted message', async () => {
  const dm = makeDm(alice, bob);
  await withApp(async (call) => {
    const { message } = await (await call(bob, 'POST', `/api/dms/${dm}/messages`, { content: '', stickerId: stA })).json();
    const reply = await (await call(alice, 'POST', `/api/dms/${dm}/messages`, { content: 're', replyToMessageId: message.id })).json();
    assert.equal(reply.message.replyTo.sticker.name, 'wave');
  });
});
