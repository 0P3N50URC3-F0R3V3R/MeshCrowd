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
const { AiError } = require('../lib/ai/errors');

const mkUser = (n) => Number(db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)').run(n, `${n}@t.local`, 'h', n).lastInsertRowid);
const mkServer = (owner) => {
  const id = Number(db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)').run('Srv', owner, `i${Math.random()}`).lastInsertRowid);
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(id, owner);
  db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 0, 1)').run(id, '@everyone', 3);
  return id;
};
const mkChannel = (serverId, name, type = 'public') => Number(db.prepare('INSERT INTO channels (server_id, name, type) VALUES (?, ?, ?)').run(serverId, name, type).lastInsertRowid);
const mkApiBot = (serverId, owner, name = 'Hook') => {
  const bot = botStore.createBot({ serverId, actorId: owner, body: { displayName: name }, siteAuthority: true });
  return { bot, ...botStore.issueApiToken(bot.id, owner) };
};

let server; let base;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/bot', require('../routes/botApi'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  server.close();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const call = async (method, url, token, body) => {
  const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bot ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})), headers: res.headers };
};

test('an API-only bot needs no AI provider', () => {
  const owner = mkUser('own1');
  const sid = mkServer(owner);
  const bot = botStore.createBot({ serverId: sid, actorId: owner, body: { displayName: 'Plain' }, siteAuthority: false });
  assert.equal(bot.hasAi, false);
  assert.equal(bot.providerId, null);
  assert.equal(bot.api.hasToken, false);
});

test('the token is shown once, only its hash is stored, and the public shape never leaks it', () => {
  const owner = mkUser('own2');
  const sid = mkServer(owner);
  const { bot, token } = mkApiBot(sid, owner);
  assert.match(token, /^mcb_[A-Za-z0-9_-]{40,}$/);
  const row = db.prepare('SELECT * FROM bots WHERE id = ?').get(bot.id);
  assert.notEqual(row.api_token_hash, token);
  assert.equal(row.api_token_hash.length, 64);
  assert.equal(JSON.stringify(botStore.publicBot(botStore.getBotRow(bot.id))).includes(token), false);
  assert.ok(botStore.findBotByToken(token));
  assert.equal(botStore.findBotByToken(token + 'x'), null);
});

test('missing, malformed and revoked tokens are refused', async () => {
  const owner = mkUser('own3');
  const sid = mkServer(owner);
  const { bot, token } = mkApiBot(sid, owner);
  assert.equal((await call('GET', '/api/bot/me', null)).status, 401);
  assert.equal((await call('GET', '/api/bot/me', 'not-a-token')).status, 401);
  assert.equal((await call('GET', '/api/bot/me', 'mcb_' + 'a'.repeat(43))).status, 401);
  const ok = await call('GET', '/api/bot/me', token);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.bot.serverId, sid);
  botStore.revokeApiToken(bot.id, owner);
  assert.equal((await call('GET', '/api/bot/me', token)).status, 401);
});

test('a deleted bot cannot use its old token', async () => {
  const owner = mkUser('own4');
  const sid = mkServer(owner);
  const { bot, token } = mkApiBot(sid, owner);
  botStore.deleteBot(bot.id, owner);
  assert.equal((await call('GET', '/api/bot/me', token)).status, 401);
});

test('regenerating a token invalidates the previous one', async () => {
  const owner = mkUser('own5');
  const sid = mkServer(owner);
  const { bot, token } = mkApiBot(sid, owner);
  const next = botStore.issueApiToken(bot.id, owner).token;
  assert.equal((await call('GET', '/api/bot/me', token)).status, 401);
  assert.equal((await call('GET', '/api/bot/me', next)).status, 200);
});

test('channels lists only what the bot may view', async () => {
  const owner = mkUser('own6');
  const sid = mkServer(owner);
  const open = mkChannel(sid, 'open');
  const secret = mkChannel(sid, 'secret', 'private');
  const notes = mkChannel(sid, 'mine', 'notes');
  const { token } = mkApiBot(sid, owner);
  const names = (await call('GET', '/api/bot/channels', token)).json.channels.map((c) => c.id);
  assert.ok(names.includes(open));
  assert.ok(!names.includes(secret));
  assert.ok(!names.includes(notes));
});

test('posting works, is attributed to the bot and defuses @everyone', async () => {
  const owner = mkUser('own7');
  const sid = mkServer(owner);
  const ch = mkChannel(sid, 'talk');
  const { bot, token } = mkApiBot(sid, owner);
  const res = await call('POST', '/api/bot/messages', token, { scopeType: 'channel', scopeId: ch, content: 'hello @everyone and @here' });
  assert.equal(res.status, 201);
  assert.equal(res.json.message.author.id, bot.userId);
  assert.equal(res.json.message.author.isBot, true);
  assert.ok(!/@everyone|@here/.test(res.json.message.content));
  const stored = db.prepare('SELECT content FROM messages WHERE id = ?').get(res.json.message.id);
  assert.ok(stored.content.includes('everyone'));
});

test('posting validates its input and the target', async () => {
  const owner = mkUser('own8');
  const sid = mkServer(owner);
  const ch = mkChannel(sid, 'talk');
  const { token } = mkApiBot(sid, owner);
  const post = (b) => call('POST', '/api/bot/messages', token, b);
  assert.equal((await post({ scopeType: 'nope', scopeId: ch, content: 'x' })).status, 400);
  assert.equal((await post({ scopeType: 'channel', scopeId: ch })).status, 400);
  assert.equal((await post({ scopeType: 'channel', scopeId: ch, content: '   ' })).status, 400);
  assert.equal((await post({ scopeType: 'channel', scopeId: ch, content: 'x'.repeat(15001) })).status, 400);
  assert.equal((await post({ scopeType: 'channel', scopeId: 999999, content: 'x' })).status, 404);
  assert.equal((await post({ scopeType: 'channel', scopeId: ch, content: 'x', replyToMessageId: 999999 })).status, 400);
});

test('a bot cannot post in another server, a private channel it cannot see, or Notes', async () => {
  const owner = mkUser('own9');
  const sid = mkServer(owner);
  const other = mkServer(mkUser('own9b'));
  const foreign = mkChannel(other, 'foreign');
  const secret = mkChannel(sid, 'secret', 'private');
  const notes = mkChannel(sid, 'mine', 'notes');
  const { token } = mkApiBot(sid, owner);
  const post = (id) => call('POST', '/api/bot/messages', token, { scopeType: 'channel', scopeId: id, content: 'x' });
  assert.notEqual((await post(foreign)).status, 201);
  assert.equal((await post(secret)).status, 403);
  assert.notEqual((await post(notes)).status, 201);
  const rows = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE scope_id IN (?, ?, ?) AND scope_type = ?').get(foreign, secret, notes, 'channel');
  assert.equal(rows.n, 0);
});

test('DMs: only a 1:1, unencrypted conversation with a bot that accepts DMs', async () => {
  const owner = mkUser('own10');
  const human = mkUser('human10');
  const sid = mkServer(owner);
  const { bot, token } = mkApiBot(sid, owner);
  const mkDm = (e2ee = 0, group = 0) => {
    const id = Number(db.prepare('INSERT INTO dm_channels (is_group, e2ee_enabled, created_by) VALUES (?, ?, ?)').run(group, e2ee, human).lastInsertRowid);
    db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?)').run(id, human);
    db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?)').run(id, bot.userId);
    return id;
  };
  const dm = mkDm();
  const post = (id) => call('POST', '/api/bot/messages', token, { scopeType: 'dm', scopeId: id, content: 'hi' });
  assert.equal((await post(dm)).status, 403);
  db.prepare('UPDATE bots SET dm_enabled = 1 WHERE id = ?').run(bot.id);
  assert.equal((await post(dm)).status, 201);
  assert.equal((await post(mkDm(1))).status, 403);
  assert.equal((await post(mkDm(0, 1))).status, 403);
  const stranger = Number(db.prepare('INSERT INTO dm_channels (is_group, e2ee_enabled, created_by) VALUES (0, 0, ?)').run(human).lastInsertRowid);
  db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?)').run(stranger, human);
  assert.equal((await post(stranger)).status, 403);
  const read = await call('GET', `/api/bot/messages?scopeType=dm&scopeId=${dm}`, token);
  assert.equal(read.status, 200);
  assert.equal((await call('GET', `/api/bot/messages?scopeType=dm&scopeId=${stranger}`, token)).status, 403);
});

test('reading history and editing or deleting only its own messages', async () => {
  const owner = mkUser('own11');
  const sid = mkServer(owner);
  const ch = mkChannel(sid, 'talk');
  const { token } = mkApiBot(sid, owner);
  const humanMsg = Number(db.prepare("INSERT INTO messages (scope_type, scope_id, author_id, content) VALUES ('channel', ?, ?, 'human says hi')").run(ch, owner).lastInsertRowid);
  const mine = (await call('POST', '/api/bot/messages', token, { scopeType: 'channel', scopeId: ch, content: 'first' })).json.message;
  const hist = await call('GET', `/api/bot/messages?scopeType=channel&scopeId=${ch}&limit=10`, token);
  assert.equal(hist.json.messages.length, 2);
  const edit = await call('PATCH', `/api/bot/messages/${mine.id}`, token, { content: 'second' });
  assert.equal(edit.status, 200);
  assert.equal(edit.json.message.content, 'second');
  assert.ok(edit.json.message.editedAt);
  assert.equal((await call('PATCH', `/api/bot/messages/${humanMsg}`, token, { content: 'hijack' })).status, 404);
  assert.equal((await call('DELETE', `/api/bot/messages/${humanMsg}`, token)).status, 404);
  assert.equal(db.prepare('SELECT content FROM messages WHERE id = ?').get(humanMsg).content, 'human says hi');
  assert.equal((await call('DELETE', `/api/bot/messages/${mine.id}`, token)).status, 200);
  assert.equal(db.prepare('SELECT 1 FROM messages WHERE id = ?').get(mine.id), undefined);
});

test('writes are rate limited per bot', async () => {
  const owner = mkUser('own12');
  const sid = mkServer(owner);
  const ch = mkChannel(sid, 'talk');
  const a = mkApiBot(sid, owner, 'Fast');
  const b = mkApiBot(sid, owner, 'Calm');
  const post = (token) => call('POST', '/api/bot/messages', token, { scopeType: 'channel', scopeId: ch, content: 'x' });
  let last;
  for (let i = 0; i < 31; i++) last = await post(a.token);
  assert.equal(last.status, 429);
  assert.ok(last.headers.get('retry-after'));
  assert.equal((await post(b.token)).status, 201);
});

test('enabling a webhook needs a URL and a signing secret first', () => {
  const owner = mkUser('own13');
  const sid = mkServer(owner);
  const bot = botStore.createBot({ serverId: sid, actorId: owner, body: { displayName: 'Wh' }, siteAuthority: true });
  const upd = (body, siteAuthority = true) => botStore.updateBot(bot.id, { actorId: owner, body, siteAuthority });
  assert.throws(() => upd({ webhookEnabled: true }), (e) => e instanceof AiError && /URL/.test(e.message));
  upd({ webhookUrl: 'http://127.0.0.1:9/hook' });
  assert.throws(() => upd({ webhookEnabled: true }), (e) => e instanceof AiError && /secret/.test(e.message));
  botStore.rotateWebhookSecret(bot.id, owner);
  assert.equal(upd({ webhookEnabled: true }).webhook.enabled, true);
  assert.throws(() => upd({ webhookUrl: 'ftp://x/y' }), (e) => e.status === 400);
  assert.throws(() => upd({ webhookUrl: 'http://user:pw@host/x' }), (e) => e.status === 400);
  assert.throws(() => upd({ webhookScope: 'everything' }), (e) => e.status === 400);
  assert.equal(upd({ webhookUrl: '' }).webhook.enabled, false);
});

test('only a site admin may point a webhook at a private address', () => {
  const owner = mkUser('own14');
  const sid = mkServer(owner);
  const bot = botStore.createBot({ serverId: sid, actorId: owner, body: { displayName: 'Priv' }, siteAuthority: false });
  const asServerAdmin = botStore.updateBot(bot.id, { actorId: owner, body: { webhookUrl: 'http://192.168.1.5/hook' }, siteAuthority: false });
  assert.equal(asServerAdmin.webhook.allowPrivate, false);
  const asSite = botStore.updateBot(bot.id, { actorId: owner, body: { webhookUrl: 'http://192.168.1.5/hook' }, siteAuthority: true });
  assert.equal(asSite.webhook.allowPrivate, true);
});

test('removing the AI keeps the bot as an API-only bot, and a provider can be added later', () => {
  const owner = mkUser('own15');
  const sid = mkServer(owner);
  const providerId = Number(db.prepare("INSERT INTO ai_providers (name, kind, base_url, models, server_admin_usable, enabled) VALUES (?, 'ollama', 'http://127.0.0.1:11434', ?, 1, 1)").run(`p${Math.random()}`, JSON.stringify(['m1'])).lastInsertRowid);
  const bot = botStore.createBot({ serverId: sid, actorId: owner, body: { displayName: 'Both', providerId, model: 'm1' }, siteAuthority: true });
  assert.equal(bot.hasAi, true);
  const off = botStore.updateBot(bot.id, { actorId: owner, body: { providerId: null }, siteAuthority: true });
  assert.equal(off.hasAi, false);
  assert.equal(off.model, null);
  const on = botStore.updateBot(bot.id, { actorId: owner, body: { providerId, model: 'm1' }, siteAuthority: true });
  assert.equal(on.hasAi, true);
});

test('a server admin re-saving an unchanged URL keeps the private-address grant, changing it drops it', () => {
  const owner = mkUser('own16');
  const sid = mkServer(owner);
  const bot = botStore.createBot({ serverId: sid, actorId: owner, body: { displayName: 'Keep' }, siteAuthority: true });
  botStore.updateBot(bot.id, { actorId: owner, body: { webhookUrl: 'http://192.168.1.5/hook' }, siteAuthority: true });
  const same = botStore.updateBot(bot.id, { actorId: owner, body: { webhookUrl: 'http://192.168.1.5/hook' }, siteAuthority: false });
  assert.equal(same.webhook.allowPrivate, true);
  const changed = botStore.updateBot(bot.id, { actorId: owner, body: { webhookUrl: 'http://192.168.1.6/hook' }, siteAuthority: false });
  assert.equal(changed.webhook.allowPrivate, false);
});
