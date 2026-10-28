'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const { db } = require('../db');
const botStore = require('../lib/ai/botStore');
const secretBox = require('../lib/ai/secretBox');
const webhooks = require('../lib/bots/webhooks');
const events = require('../lib/bots/events');
const { serializeMessage } = require('../lib/messages');

const mkUser = (n) => Number(db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)').run(n, `${n}@t.local`, 'h', n).lastInsertRowid);
const mkServer = (owner) => {
  const id = Number(db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)').run('Srv', owner, `i${Math.random()}`).lastInsertRowid);
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(id, owner);
  db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 0, 1)').run(id, '@everyone', 3);
  return id;
};
const mkChannel = (serverId, name, type = 'public') => Number(db.prepare('INSERT INTO channels (server_id, name, type) VALUES (?, ?, ?)').run(serverId, name, type).lastInsertRowid);
const say = (scopeType, scopeId, authorId, content, replyTo = null) => serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(
  Number(db.prepare('INSERT INTO messages (scope_type, scope_id, author_id, content, reply_to_message_id) VALUES (?, ?, ?, ?, ?)').run(scopeType, scopeId, authorId, content, replyTo).lastInsertRowid)));

let receiver; let url; let hits; let respond;
test.before(async () => {
  receiver = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      hits.push({ headers: req.headers, body, json: JSON.parse(body) });
      const status = respond(hits.length);
      res.writeHead(status).end('ignored');
    });
  });
  await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${receiver.address().port}/hook`;
  webhooks.settings.backoffMs = [0, 20, 20];
});
test.beforeEach(() => { hits = []; respond = () => 200; webhooks._reset(); });
test.after(() => { receiver.close(); db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

const waitFor = async (cond, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await new Promise((r) => setTimeout(r, 15)); }
  return cond();
};

function setup({ scope = 'mention', dm = false, enabled = true, siteAuthority = true, name = 'Hooky' } = {}) {
  const owner = mkUser(`o${Math.random().toString(36).slice(2, 8)}`);
  const sid = mkServer(owner);
  const ch = mkChannel(sid, 'talk');
  const bot = botStore.createBot({ serverId: sid, actorId: owner, body: { displayName: name, dmEnabled: dm }, siteAuthority });
  const { secret } = botStore.rotateWebhookSecret(bot.id, owner);
  botStore.updateBot(bot.id, { actorId: owner, body: { webhookUrl: url, webhookScope: scope, webhookEnabled: enabled }, siteAuthority });
  return { owner, sid, ch, bot, secret, username: bot.user.username };
}

test('a mention is delivered with a valid HMAC signature and the documented payload', async () => {
  const s = setup();
  const msg = say('channel', s.ch, s.owner, `@${s.username} what's up?`);
  events.deliverWebhooks(msg);
  assert.ok(await waitFor(() => hits.length === 1));
  const h = hits[0];
  assert.equal(h.headers['x-meshcrowd-event'], 'message_create');
  assert.ok(h.headers['x-meshcrowd-delivery']);
  const expected = `sha256=${crypto.createHmac('sha256', s.secret).update(`${h.headers['x-meshcrowd-timestamp']}.${h.body}`).digest('hex')}`;
  assert.equal(h.headers['x-meshcrowd-signature'], expected);
  assert.ok(Math.abs(Number(h.headers['x-meshcrowd-timestamp']) - Date.now() / 1000) < 30);
  assert.equal(h.json.trigger, 'mention');
  assert.equal(h.json.bot.id, s.bot.id);
  assert.equal(h.json.channel.id, s.ch);
  assert.equal(h.json.server.id, s.sid);
  assert.equal(h.json.message.content, `@${s.username} what's up?`);
  assert.equal(h.json.message.author.id, s.owner);
  assert.equal(botStore.getBotRow(s.bot.id).webhook_last_status, 'ok 200');
});

test('scope "mention" ignores ordinary chatter, scope "all" hears everything in channels it can view', async () => {
  const quiet = setup({ scope: 'mention', name: 'Quiet' });
  events.deliverWebhooks(say('channel', quiet.ch, quiet.owner, 'just talking'));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(hits.length, 0);

  const loud = setup({ scope: 'all', name: 'Loud' });
  events.deliverWebhooks(say('channel', loud.ch, loud.owner, 'just talking'));
  assert.ok(await waitFor(() => hits.length === 1));
  assert.equal(hits[0].json.trigger, 'message');
});

test('a reply to the bot counts as a mention', async () => {
  const s = setup();
  const botMsg = say('channel', s.ch, s.bot.userId, 'my earlier message');
  events.deliverWebhooks(say('channel', s.ch, s.owner, 'thanks', botMsg.id));
  assert.ok(await waitFor(() => hits.length === 1));
  assert.equal(hits[0].json.trigger, 'mention');
});

test('messages written by bots never trigger a webhook (no loops)', async () => {
  const s = setup({ scope: 'all' });
  events.deliverWebhooks(say('channel', s.ch, s.bot.userId, `@${s.username} talking to myself`));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(hits.length, 0);
});

test('a disabled webhook, or one in another server, hears nothing', async () => {
  const off = setup({ enabled: false });
  events.deliverWebhooks(say('channel', off.ch, off.owner, `@${off.username} hi`));
  const elsewhere = setup({ scope: 'all', name: 'Far' });
  const otherServer = mkServer(mkUser(`z${Math.random().toString(36).slice(2, 8)}`));
  const otherCh = mkChannel(otherServer, 'x');
  events.deliverWebhooks(say('channel', otherCh, elsewhere.owner, 'hello'));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(hits.length, 0);
});

test('a bot cannot hear channels it cannot view', async () => {
  const s = setup({ scope: 'all' });
  const secret = mkChannel(s.sid, 'secret', 'private');
  events.deliverWebhooks(say('channel', secret, s.owner, 'hidden talk'));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(hits.length, 0);
});

test('Notes channels and encrypted or group DMs are never sent out', async () => {
  const s = setup({ scope: 'all', dm: true });
  const notes = mkChannel(s.sid, 'mine', 'notes');
  events.deliverWebhooks(say('channel', notes, s.owner, 'private note'));
  const human = mkUser(`h${Math.random().toString(36).slice(2, 8)}`);
  const mkDm = (e2ee, group) => {
    const id = Number(db.prepare('INSERT INTO dm_channels (is_group, e2ee_enabled, created_by) VALUES (?, ?, ?)').run(group, e2ee, human).lastInsertRowid);
    db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?)').run(id, human);
    db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?)').run(id, s.bot.userId);
    return id;
  };
  events.deliverWebhooks(say('dm', mkDm(1, 0), human, 'secret'));
  events.deliverWebhooks(say('dm', mkDm(0, 1), human, 'group'));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(hits.length, 0);
  events.deliverWebhooks(say('dm', mkDm(0, 0), human, 'hello bot'));
  assert.ok(await waitFor(() => hits.length === 1));
  assert.equal(hits[0].json.trigger, 'dm');
  assert.ok(hits[0].json.dmId);
  assert.equal(hits[0].json.channel, null);
});

test('a 5xx is retried and then succeeds; a 4xx is not retried', async () => {
  const s = setup();
  respond = (n) => (n < 3 ? 503 : 200);
  events.deliverWebhooks(say('channel', s.ch, s.owner, `@${s.username} retry me`));
  assert.ok(await waitFor(() => hits.length === 3));
  assert.ok(await waitFor(() => botStore.getBotRow(s.bot.id).webhook_last_status === 'ok 200'));

  hits = []; webhooks._reset();
  respond = () => 400;
  events.deliverWebhooks(say('channel', s.ch, s.owner, `@${s.username} bad`));
  assert.ok(await waitFor(() => hits.length === 1));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(hits.length, 1);
  assert.equal(botStore.getBotRow(s.bot.id).webhook_last_status, 'failed: HTTP 400');
});

test('a server admin cannot aim a webhook at localhost, a site admin can', async () => {
  const blocked = setup({ siteAuthority: false, name: 'Blocked' });
  const res = await webhooks.sendTest(botStore.getBotRow(blocked.bot.id));
  assert.equal(res.ok, false);
  assert.equal(res.error, 'address is not public');
  assert.equal(hits.length, 0);

  const allowed = setup({ siteAuthority: true, name: 'Allowed' });
  const ok = await webhooks.sendTest(botStore.getBotRow(allowed.bot.id));
  assert.equal(ok.ok, true);
  assert.equal(hits[0].json.type, 'ping');
});

test('redirects are not followed', async () => {
  const redirector = http.createServer((req, res) => res.writeHead(302, { location: `${url}` }).end());
  await new Promise((r) => redirector.listen(0, '127.0.0.1', r));
  const s = setup();
  db.prepare('UPDATE bots SET webhook_url = ? WHERE id = ?').run(`http://127.0.0.1:${redirector.address().port}/r`, s.bot.id);
  const res = await webhooks.sendTest(botStore.getBotRow(s.bot.id));
  assert.equal(res.ok, false);
  assert.equal(hits.length, 0);
  redirector.close();
});

test('the signing secret is stored encrypted and rotating it changes signatures', async () => {
  const s = setup();
  const row = db.prepare('SELECT webhook_secret_enc FROM bots WHERE id = ?').get(s.bot.id);
  assert.notEqual(row.webhook_secret_enc, s.secret);
  assert.equal(secretBox.decrypt(row.webhook_secret_enc), s.secret);
  const next = botStore.rotateWebhookSecret(s.bot.id, s.owner).secret;
  assert.notEqual(next, s.secret);
  await webhooks.sendTest(botStore.getBotRow(s.bot.id));
  const h = hits[0];
  const good = `sha256=${crypto.createHmac('sha256', next).update(`${h.headers['x-meshcrowd-timestamp']}.${h.body}`).digest('hex')}`;
  assert.equal(h.headers['x-meshcrowd-signature'], good);
});

test('a slow receiver cannot grow the queue without bound', () => {
  const s = setup();
  respond = () => 200;
  webhooks.settings.maxPending = 3;
  for (let i = 0; i < 10; i++) webhooks.enqueue(s.bot.id, { type: 'message_create', n: i });
  assert.ok(webhooks._queues.get(s.bot.id).pending.length <= 3);
  webhooks.settings.maxPending = 50;
});

test('a bot without AI never answers, even when mentioned', async () => {
  const s = setup();
  const before = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
  const msg = say('channel', s.ch, s.owner, `@${s.username} are you there?`);
  await require('../lib/ai/dispatcher').maybeRespond(msg);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, before + 1);
});
