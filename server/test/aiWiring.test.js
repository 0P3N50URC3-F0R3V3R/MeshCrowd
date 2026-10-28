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
const botStore = require('../lib/ai/botStore');
const dispatcher = require('../lib/ai/dispatcher');

let fake; let fakePort; let app; let server; let base;
test.before(async () => {
  fake = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(`${JSON.stringify({ message: { content: 'Wired reply' }, done: false })}\n`);
      res.end(`${JSON.stringify({ message: { content: '' }, done: true })}\n`);
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  fakePort = fake.address().port;
  dispatcher._settings.cooldownMs = 0;
  dispatcher._settings.editIntervalMs = 20;

  app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const uid = Number(req.headers['x-uid']);
    if (uid) { req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid); req.sitePermissions = 0; }
    next();
  });
  app.use('/api/servers/:id/channels/:channelId/messages', require('../routes/channelMessages'));
  app.use('/api/servers/:id/channels/:channelId/threads', require('../routes/threads'));
  app.use('/api/servers/:id/channels/:channelId/invites', require('../routes/channelInvites'));
  app.use('/api/servers', require('../routes/servers'));
  app.use('/api/dms', require('../routes/dms'));
  await new Promise((r) => { server = http.createServer(app).listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.close(); fake.closeAllConnections?.(); fake.close(); db.close();
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const mkUser = (n) => Number(db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
  .run(n, `${n}@t.local`, 'h', n).lastInsertRowid);

async function call(method, url, uid, json) {
  const res = await fetch(base + url, { method, headers: { 'x-uid': String(uid), ...(json ? { 'content-type': 'application/json' } : {}) }, body: json ? JSON.stringify(json) : undefined });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, data };
}

async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); }
  return null;
}

function world(botOpts = {}) {
  const owner = mkUser(`w_o${Math.random().toString(36).slice(2, 7)}`);
  const alice = mkUser(`w_a${Math.random().toString(36).slice(2, 7)}`);
  const serverId = Number(db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)').run('Srv', owner, `i${Math.random()}`).lastInsertRowid);
  for (const u of [owner, alice]) db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(serverId, u);
  db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 0, 1)').run(serverId, '@everyone', 3);
  const channel = Number(db.prepare("INSERT INTO channels (server_id, name, type) VALUES (?, 'general', 'public')").run(serverId).lastInsertRowid);
  const provider = Number(db.prepare('INSERT INTO ai_providers (name, kind, base_url, server_admin_usable) VALUES (?, ?, ?, 1)')
    .run(`p${Math.random()}`, 'ollama', `http://127.0.0.1:${fakePort}`).lastInsertRowid);
  const bot = botStore.createBot({ serverId, actorId: owner, siteAuthority: true, body: { displayName: 'Wire', providerId: provider, model: 'm', ...botOpts } });
  return { owner, alice, serverId, channel, bot };
}
const botMsgs = (w, scopeType, scopeId) => db.prepare('SELECT * FROM messages WHERE scope_type = ? AND scope_id = ? AND author_id = ?').all(scopeType, scopeId, w.bot.userId);

test('posting a mention through the channel route produces a bot reply', async () => {
  const w = world();
  const r = await call('POST', `/api/servers/${w.serverId}/channels/${w.channel}/messages`, w.alice, { content: `hello @${w.bot.user.username}` });
  assert.equal(r.status, 201);
  const reply = await until(() => botMsgs(w, 'channel', w.channel)[0]);
  assert.ok(reply, 'bot did not reply');
  assert.equal(reply.content, 'Wired reply');
});

test('a thread message mention produces a bot reply', async () => {
  const w = world();
  const t = await call('POST', `/api/servers/${w.serverId}/channels/${w.channel}/threads`, w.alice, { title: 'T', content: 'first' });
  assert.equal(t.status, 201);
  const m = await call('POST', `/api/servers/${w.serverId}/channels/${w.channel}/threads/${t.data.thread.id}/messages`, w.alice, { content: `@${w.bot.user.username} in thread` });
  assert.equal(m.status, 201);
  assert.ok(await until(() => botMsgs(w, 'thread', t.data.thread.id)[0]));
});

test('DM with a bot: refused when DM mode is off, works when on, answers without a mention', async () => {
  const off = world({ dmEnabled: false });
  const refused = await call('POST', '/api/dms', off.alice, { userId: off.bot.userId });
  assert.equal(refused.status, 403);
  assert.match(refused.data.error, /does not accept direct messages/);

  const on = world({ dmEnabled: true });
  const dm = await call('POST', '/api/dms', on.alice, { userId: on.bot.userId });
  assert.equal(dm.status, 201);
  const sent = await call('POST', `/api/dms/${dm.data.dmId}/messages`, on.alice, { content: 'hello there' });
  assert.equal(sent.status, 201);
  const reply = await until(() => botMsgs(on, 'dm', dm.data.dmId)[0]);
  assert.ok(reply);
  assert.equal(reply.content, 'Wired reply');
});

test('DM with a bot needs a shared server and ignores the human\'s dm privacy settings on the bot', async () => {
  const w = world({ dmEnabled: true });
  const outsider = mkUser(`w_x${Math.random().toString(36).slice(2, 7)}`);
  assert.equal((await call('POST', '/api/dms', outsider, { userId: w.bot.userId })).status, 404);
  db.prepare("UPDATE users SET dm_privacy = 'none' WHERE id = ?").run(w.bot.userId);
  assert.equal((await call('POST', '/api/dms', w.alice, { userId: w.bot.userId })).status, 201);
});

test('group DMs refuse bots', async () => {
  const w = world({ dmEnabled: true });
  const third = mkUser(`w_t${Math.random().toString(36).slice(2, 7)}`);
  const r = await call('POST', '/api/dms/group', w.alice, { userIds: [w.bot.userId, third] });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /bots cannot be added/);
});

test('a bot cannot be invited into another server', async () => {
  const home = world();
  const other = world();
  const direct = await call('POST', `/api/servers/${other.serverId}/invite-direct`, other.owner, { userId: home.bot.userId });
  assert.equal(direct.status, 404);
  const viaChannel = await call('POST', `/api/servers/${other.serverId}/channels/${other.channel}/invites/direct`, other.owner, { userId: home.bot.userId });
  assert.equal(viaChannel.status, 404);
  assert.equal(db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(other.serverId, home.bot.userId), undefined);
});
