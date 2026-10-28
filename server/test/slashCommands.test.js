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
const webhooks = require('../lib/bots/webhooks');
const commands = require('../lib/bots/commands');

const mkUser = (n) => Number(db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)').run(n, `${n}@t.local`, 'h', n).lastInsertRowid);
const mkServer = (owner) => {
  const id = Number(db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)').run('Srv', owner, `i${Math.random()}`).lastInsertRowid);
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(id, owner);
  db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 0, 1)').run(id, '@everyone', 3);
  return id;
};
const join = (sid, uid) => db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(sid, uid);
const mkChannel = (serverId, name, type = 'public') => Number(db.prepare('INSERT INTO channels (server_id, name, type) VALUES (?, ?, ?)').run(serverId, name, type).lastInsertRowid);

let receiver; let hookUrl; let hits;
let app; let base; let httpServer;
test.before(async () => {
  receiver = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { hits.push({ headers: req.headers, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); res.writeHead(200).end('ok'); });
  });
  await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
  hookUrl = `http://127.0.0.1:${receiver.address().port}/hook`;
  webhooks.settings.backoffMs = [0, 20, 20];

  app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const uid = Number(req.headers['x-uid']);
    if (uid) { req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid); req.sitePermissions = 0; }
    next();
  });
  app.use('/api/bot', require('../routes/botApi'));
  app.use('/api/servers/:id/commands', require('../routes/botCommands'));
  httpServer = http.createServer(app);
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${httpServer.address().port}`;
});
test.beforeEach(() => { hits = []; webhooks._reset(); });
test.after(() => { receiver.close(); httpServer.close(); db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

const waitFor = async (cond, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await new Promise((r) => setTimeout(r, 15)); }
  return cond();
};
const bot$ = async (method, url, token, body) => {
  const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', authorization: `Bot ${token}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const user$ = async (method, url, uid, body) => {
  const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'x-uid': String(uid) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

function world({ webhook = true } = {}) {
  const owner = mkUser(`o${Math.random().toString(36).slice(2, 8)}`);
  const member = mkUser(`m${Math.random().toString(36).slice(2, 8)}`);
  const sid = mkServer(owner);
  join(sid, member);
  const ch = mkChannel(sid, 'talk');
  const bot = botStore.createBot({ serverId: sid, actorId: owner, body: { displayName: 'Cmd' }, siteAuthority: true });
  const { token } = botStore.issueApiToken(bot.id, owner);
  botStore.rotateWebhookSecret(bot.id, owner);
  if (webhook) botStore.updateBot(bot.id, { actorId: owner, body: { webhookUrl: hookUrl, webhookEnabled: true }, siteAuthority: true });
  return { owner, member, sid, ch, bot, token };
}

const ROLL = [{ name: 'roll', description: 'Roll a die', options: [{ name: 'sides', type: 'integer', required: true, description: 'Faces' }, { name: 'note', type: 'string' }, { name: 'secret', type: 'boolean' }] }];

test('registration validates names, duplicates, option types and required order', () => {
  assert.throws(() => commands.normalizeCommands([{ name: 'Bad Name' }]), /name must be/);
  assert.throws(() => commands.normalizeCommands([{ name: 'a' }, { name: 'a' }]), /twice/);
  assert.throws(() => commands.normalizeCommands([{ name: 'a', options: [{ name: 'x', type: 'float' }] }]), /option type/);
  assert.throws(() => commands.normalizeCommands([{ name: 'a', options: [{ name: 'x' }, { name: 'y', required: true }] }]), /required options must come first/);
  assert.throws(() => commands.normalizeCommands('nope'), /array/);
  const ok = commands.normalizeCommands([{ name: 'Ping', description: '  hi  ' }]);
  assert.deepEqual(ok, [{ name: 'ping', description: 'hi', options: [] }]);
});

test('a bot registers its commands and replaces them wholesale', async () => {
  const w = world();
  let res = await bot$('PUT', '/api/bot/commands', w.token, { commands: ROLL });
  assert.equal(res.status, 200);
  assert.equal(res.json.commands[0].options[0].required, true);
  res = await bot$('PUT', '/api/bot/commands', w.token, { commands: [{ name: 'ping' }] });
  const list = (await bot$('GET', '/api/bot/commands', w.token)).json.commands;
  assert.deepEqual(list.map((c) => c.name), ['ping']);
  assert.equal((await bot$('PUT', '/api/bot/commands', w.token, { commands: [{ name: 'BAD NAME' }] })).status, 400);
});

test('members see only the commands of bots that have a working webhook', async () => {
  const w = world();
  const quiet = world({ webhook: false });
  await bot$('PUT', '/api/bot/commands', w.token, { commands: ROLL });
  await bot$('PUT', '/api/bot/commands', quiet.token, { commands: [{ name: 'quiet' }] });
  const res = await user$('GET', `/api/servers/${w.sid}/commands`, w.member);
  assert.deepEqual(res.json.commands.map((c) => c.name), ['roll']);
  assert.equal(res.json.commands[0].botId, w.bot.id);
  assert.equal((await user$('GET', `/api/servers/${quiet.sid}/commands`, quiet.member)).json.commands.length, 0);
  const outsider = mkUser(`x${Math.random().toString(36).slice(2, 8)}`);
  assert.equal((await user$('GET', `/api/servers/${w.sid}/commands`, outsider)).status, 403);
});

test('invoking a command sends a signed, typed "command" webhook', async () => {
  const w = world();
  await bot$('PUT', '/api/bot/commands', w.token, { commands: ROLL });
  const res = await user$('POST', `/api/servers/${w.sid}/commands/invoke`, w.member, { channelId: w.ch, botId: w.bot.id, command: 'roll', options: { sides: '20', note: 'hi there', secret: 'yes' } });
  assert.equal(res.status, 202);
  assert.match(res.json.interactionId, /^[0-9a-f]{32}$/);
  assert.ok(await waitFor(() => hits.length === 1));
  const p = hits[0].json;
  assert.equal(p.type, 'command');
  assert.equal(p.command, 'roll');
  assert.deepEqual(p.options, { sides: 20, note: 'hi there', secret: true });
  assert.equal(p.user.id, w.member);
  assert.equal(p.channel.id, w.ch);
  assert.equal(p.interaction.id, res.json.interactionId);
  assert.equal(hits[0].headers['x-meshcrowd-event'], 'command');
  assert.match(hits[0].headers['x-meshcrowd-signature'], /^sha256=[0-9a-f]{64}$/);
});

test('bad invocations are refused with a reason', async () => {
  const w = world();
  await bot$('PUT', '/api/bot/commands', w.token, { commands: ROLL });
  const inv = (body, uid = w.member) => user$('POST', `/api/servers/${w.sid}/commands/invoke`, uid, { channelId: w.ch, botId: w.bot.id, command: 'roll', ...body });
  assert.match((await inv({ options: {} })).json.error, /sides.*required/);
  assert.match((await inv({ options: { sides: 'abc' } })).json.error, /whole number/);
  assert.match((await inv({ options: { sides: 1, extra: 1 } })).json.error, /unknown option/);
  assert.match((await inv({ options: { sides: 1, secret: 'maybe' } })).json.error, /true or false/);
  assert.equal((await inv({ command: 'nope', options: { sides: 1 } })).status, 404);
  assert.equal((await inv({ channelId: 999999, options: { sides: 1 } })).status, 400);
  const outsider = mkUser(`x${Math.random().toString(36).slice(2, 8)}`);
  assert.equal((await inv({ options: { sides: 1 } }, outsider)).status, 403);
  assert.equal(hits.length, 0);
});

test('a member who cannot send in the channel cannot run commands there', async () => {
  const w = world();
  await bot$('PUT', '/api/bot/commands', w.token, { commands: [{ name: 'ping' }] });
  db.prepare('INSERT INTO channel_role_overrides (channel_id, role_id, allow, deny) SELECT ?, id, 0, 2 FROM roles WHERE server_id = ? AND is_default = 1').run(w.ch, w.sid);
  const res = await user$('POST', `/api/servers/${w.sid}/commands/invoke`, w.member, { channelId: w.ch, botId: w.bot.id, command: 'ping' });
  assert.equal(res.status, 403);
});

test('a normal answer is posted as the bot and remembers who ran what', async () => {
  const w = world();
  await bot$('PUT', '/api/bot/commands', w.token, { commands: [{ name: 'ping' }] });
  const { json: { interactionId } } = await user$('POST', `/api/servers/${w.sid}/commands/invoke`, w.member, { channelId: w.ch, botId: w.bot.id, command: 'ping' });
  const res = await bot$('POST', `/api/bot/interactions/${interactionId}/respond`, w.token, { content: 'pong' });
  assert.equal(res.status, 201);
  assert.equal(res.json.message.content, 'pong');
  assert.equal(res.json.message.author.id, w.bot.userId);
  assert.equal(res.json.message.interaction.command, 'ping');
  assert.equal(res.json.message.interaction.user.id, w.member);
  assert.equal(db.prepare('SELECT interaction_command FROM messages WHERE id = ?').get(res.json.message.id).interaction_command, 'ping');
});

test('an ephemeral answer is never stored', async () => {
  const w = world();
  await bot$('PUT', '/api/bot/commands', w.token, { commands: [{ name: 'ping' }] });
  const { json: { interactionId } } = await user$('POST', `/api/servers/${w.sid}/commands/invoke`, w.member, { channelId: w.ch, botId: w.bot.id, command: 'ping' });
  const before = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
  const res = await bot$('POST', `/api/bot/interactions/${interactionId}/respond`, w.token, { content: 'psst', ephemeral: true });
  assert.equal(res.status, 201);
  assert.equal(res.json.ephemeral, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, before);
  assert.equal((await bot$('POST', `/api/bot/interactions/${interactionId}/respond`, w.token, { content: '', ephemeral: true })).status, 400);
});

test('an interaction takes five answers, expires after 15 minutes and belongs to its bot', async () => {
  const w = world();
  const other = world();
  await bot$('PUT', '/api/bot/commands', w.token, { commands: [{ name: 'ping' }] });
  const { json: { interactionId } } = await user$('POST', `/api/servers/${w.sid}/commands/invoke`, w.member, { channelId: w.ch, botId: w.bot.id, command: 'ping' });
  assert.equal((await bot$('POST', `/api/bot/interactions/${interactionId}/respond`, other.token, { content: 'steal' })).status, 404);
  for (let i = 0; i < 5; i++) assert.equal((await bot$('POST', `/api/bot/interactions/${interactionId}/respond`, w.token, { content: `r${i}`, ephemeral: true })).status, 201);
  assert.equal((await bot$('POST', `/api/bot/interactions/${interactionId}/respond`, w.token, { content: 'six', ephemeral: true })).status, 429);
  const { json: { interactionId: old } } = await user$('POST', `/api/servers/${w.sid}/commands/invoke`, w.member, { channelId: w.ch, botId: w.bot.id, command: 'ping' });
  db.prepare("UPDATE bot_interactions SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-16 minutes') WHERE id = ?").run(old);
  assert.equal((await bot$('POST', `/api/bot/interactions/${old}/respond`, w.token, { content: 'late' })).status, 410);
});
