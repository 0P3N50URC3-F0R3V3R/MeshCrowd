'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const { db } = require('../db');
const { serializeMessage } = require('../lib/messages');
const botStore = require('../lib/ai/botStore');

let dispatcher; let cleanReply; let buildMessages; let ProviderQueue;
let fake; let fakePort; let mode = 'ok'; let requests = []; let delayMs = 0;
test.before(async () => {
  fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      requests.push(JSON.parse(body));
      if (mode === 'fail') { res.writeHead(500); res.end('nope'); return; }
      const reply = mode === 'inject' ? '@everyone look @alice <script>x</script>' : mode === 'empty' ? '' : 'Hello from the bot';
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      const send = () => {
        if (reply) res.write(`${JSON.stringify({ message: { content: reply }, done: false })}\n`);
        res.end(`${JSON.stringify({ message: { content: '' }, done: true })}\n`);
      };
      delayMs ? setTimeout(send, delayMs) : send();
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  fakePort = fake.address().port;
  dispatcher = require('../lib/ai/dispatcher');
  ({ cleanReply } = require('../lib/ai/sanitize'));
  ({ buildMessages } = require('../lib/ai/context'));
  ({ ProviderQueue } = require('../lib/ai/queue'));
});
test.beforeEach(() => {
  mode = 'ok'; requests = []; delayMs = 0;
  dispatcher._resetState();
  dispatcher._settings.cooldownMs = 0;
  dispatcher._settings.editIntervalMs = 20;
  dispatcher._queue.maxWaiting = 5;
});
test.after(async () => {
  fake.closeAllConnections?.(); fake.close(); db.close();
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const mkUser = (n, isBot = 0) => Number(db.prepare('INSERT INTO users (username, email, password_hash, display_name, is_bot) VALUES (?, ?, ?, ?, ?)')
  .run(n, `${n}@t.local`, 'h', n, isBot).lastInsertRowid);

function world(opts = {}) {
  const owner = mkUser(`own${Math.random().toString(36).slice(2, 8)}`);
  const alice = mkUser(`alice${Math.random().toString(36).slice(2, 8)}`);
  const serverId = Number(db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)').run('Srv', owner, `i${Math.random()}`).lastInsertRowid);
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(serverId, owner);
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(serverId, alice);
  db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 0, 1)').run(serverId, '@everyone', 3);
  const channel = Number(db.prepare("INSERT INTO channels (server_id, name, type) VALUES (?, 'general', ?)").run(serverId, opts.channelType || 'public').lastInsertRowid);
  const provider = Number(db.prepare('INSERT INTO ai_providers (name, kind, base_url, concurrency, server_admin_usable) VALUES (?, ?, ?, ?, 1)')
    .run(`p${Math.random()}`, 'ollama', `http://127.0.0.1:${fakePort}`, opts.concurrency || 1).lastInsertRowid);
  const bot = botStore.createBot({
    serverId, actorId: owner, siteAuthority: true,
    body: { displayName: 'Helper', providerId: provider, model: 'm', persona: 'Be brief', dmEnabled: true, ...(opts.bot || {}) },
  });
  return { owner, alice, serverId, channel, provider, bot };
}

function post(scopeType, scopeId, authorId, content, replyTo = null) {
  const id = Number(db.prepare('INSERT INTO messages (scope_type, scope_id, author_id, content, reply_to_message_id) VALUES (?, ?, ?, ?, ?)')
    .run(scopeType, scopeId, authorId, content, replyTo).lastInsertRowid);
  return serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(id));
}
const botMessages = (w, scopeType = 'channel', scopeId = w.channel) => db.prepare(
  'SELECT * FROM messages WHERE scope_type = ? AND scope_id = ? AND author_id = ? ORDER BY id ASC'
).all(scopeType, scopeId, w.bot.userId);

test('cleanReply neutralizes mentions, caps length, and optionally defuses html', () => {
  const out = cleanReply('@everyone @here @alice mail a@b.cd');
  assert.ok(!/@[a-zA-Z0-9_.]/.test(out), out);
  assert.equal(cleanReply('x'.repeat(5000)).length, 4000);
  assert.ok(!/<script/i.test(cleanReply('<script>x</script>', { rawHtml: true })));
  assert.ok(/<script/i.test(cleanReply('<script>x</script>')));
});

test('buildMessages: roles, persona, budget, skips system and encrypted messages', () => {
  const bot = { displayName: 'Helper', persona: 'Be brief', userId: 7 };
  const h = (id, authorId, name, content, extra = {}) => ({ id, author: { id: authorId, displayName: name }, content, eventType: null, isEncrypted: false, ...extra });
  const out = buildMessages({
    bot, serverName: 'Srv', channelName: 'general', dmWith: null,
    history: [h(1, 1, 'Alice', 'hi bot'), h(2, 7, 'Helper', 'hello'), h(3, 1, 'Alice', 'sys', { eventType: 'member_join' }), h(4, 1, 'Alice', 'cipher', { isEncrypted: true }), h(5, 2, 'Bob', 'and me'), h(6, 1, 'Alice', '   ')],
  });
  assert.equal(out[0].role, 'system');
  assert.match(out[0].content, /Be brief/);
  assert.match(out[0].content, /Srv/);
  assert.match(out[0].content, /AI/);
  assert.deepEqual(out.slice(1), [
    { role: 'user', content: 'Alice: hi bot' },
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: 'Bob: and me' },
  ]);
  const long = Array.from({ length: 40 }, (_, i) => h(i + 1, 1, 'Alice', 'z'.repeat(500)));
  const trimmed = buildMessages({ bot, serverName: 'S', channelName: 'c', history: long });
  const total = trimmed.slice(1).reduce((n, m) => n + m.content.length, 0);
  assert.ok(total <= 6600, `history too long: ${total}`);
  assert.equal(trimmed[trimmed.length - 1].content.startsWith('Alice: '), true);
  const dm = buildMessages({ bot, dmWith: 'Alice', history: [h(1, 1, 'Alice', 'hey')] });
  assert.match(dm[0].content, /private conversation with Alice/);
});

test('ProviderQueue: concurrency, FIFO, and a full queue returns null', async () => {
  const q = new ProviderQueue({ maxWaiting: 1 });
  const order = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const a = q.submit(1, 1, async () => { order.push('a'); await gate; });
  const b = q.submit(1, 1, async () => { order.push('b'); });
  assert.equal(q.submit(1, 1, async () => order.push('c')), null);
  assert.deepEqual(order, ['a']);
  release();
  await Promise.all([a, b]);
  assert.deepEqual(order, ['a', 'b']);
  const q2 = new ProviderQueue({ maxWaiting: 0 });
  const running = [];
  const t1 = q2.submit(2, 2, async () => { running.push(1); await gate; });
  const t2 = q2.submit(2, 2, async () => { running.push(2); await gate; });
  assert.deepEqual(running, [1, 2]);
  await Promise.all([t1, t2]);
});

test('ProviderQueue: a failing task does not wedge the queue', async () => {
  const q = new ProviderQueue({ maxWaiting: 3 });
  await assert.rejects(q.submit(1, 1, async () => { throw new Error('x'); }), /x/);
  assert.equal(await q.submit(1, 1, async () => 'ok'), 'ok');
});

test('mention in a channel gets a streamed reply from the bot, as a reply to the trigger', async () => {
  const w = world();
  const msg = post('channel', w.channel, w.alice, `hey @${w.bot.user.username} how are you`);
  await dispatcher.maybeRespond(msg);
  const replies = botMessages(w);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].content, 'Hello from the bot');
  assert.equal(replies[0].reply_to_message_id, msg.id);
  assert.equal(replies[0].edited_at, null);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].model, 'm');
  assert.equal(requests[0].messages[0].role, 'system');
  assert.match(requests[0].messages[0].content, /Be brief/);
  assert.ok(requests[0].messages.some((m) => m.role === 'user' && m.content.includes('how are you')));
});

test('no mention, no reply; replying to a bot message triggers; bot-authored messages never trigger', async () => {
  const w = world();
  await dispatcher.maybeRespond(post('channel', w.channel, w.alice, 'just chatting'));
  assert.equal(botMessages(w).length, 0);
  await dispatcher.maybeRespond(post('channel', w.channel, w.alice, `hey @${w.bot.user.username}x not me`));
  assert.equal(botMessages(w).length, 0);
  const first = post('channel', w.channel, w.alice, `@${w.bot.user.username} hi`);
  await dispatcher.maybeRespond(first);
  const botReply = db.prepare('SELECT id FROM messages WHERE author_id = ?').get(w.bot.userId);
  const followUp = post('channel', w.channel, w.alice, 'and then?', botReply.id);
  await dispatcher.maybeRespond(followUp);
  assert.equal(botMessages(w).length, 2);
  const before = requests.length;
  await dispatcher.maybeRespond(post('channel', w.channel, w.bot.userId, `@${w.bot.user.username} loop`));
  assert.equal(requests.length, before);
});

test('mention mode off means no reply in channels', async () => {
  const w = world({ bot: { mentionEnabled: false } });
  await dispatcher.maybeRespond(post('channel', w.channel, w.alice, `@${w.bot.user.username} hi`));
  assert.equal(botMessages(w).length, 0);
});

test('thread messages work like channel messages', async () => {
  const w = world();
  const threadId = Number(db.prepare('INSERT INTO threads (channel_id, title, created_by) VALUES (?, ?, ?)').run(w.channel, 'T', w.alice).lastInsertRowid);
  await dispatcher.maybeRespond(post('thread', threadId, w.alice, `@${w.bot.user.username} in a thread`));
  assert.equal(botMessages(w, 'thread', threadId).length, 1);
});

test('DM mode answers every message in a 1:1 DM, and not when dm is off, in groups, or E2EE', async () => {
  const w = world();
  const dm = Number(db.prepare('INSERT INTO dm_channels (is_group, created_by) VALUES (0, ?)').run(w.alice).lastInsertRowid);
  db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?), (?, ?)').run(dm, w.alice, dm, w.bot.userId);
  await dispatcher.maybeRespond(post('dm', dm, w.alice, 'no mention needed'));
  assert.equal(botMessages(w, 'dm', dm).length, 1);
  assert.equal(botMessages(w, 'dm', dm)[0].reply_to_message_id, null);

  const off = world({ bot: { dmEnabled: false } });
  const dm2 = Number(db.prepare('INSERT INTO dm_channels (is_group, created_by) VALUES (0, ?)').run(off.alice).lastInsertRowid);
  db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?), (?, ?)').run(dm2, off.alice, dm2, off.bot.userId);
  await dispatcher.maybeRespond(post('dm', dm2, off.alice, 'hello?'));
  assert.equal(botMessages(off, 'dm', dm2).length, 0);

  const grp = world();
  const dm3 = Number(db.prepare('INSERT INTO dm_channels (is_group, created_by) VALUES (1, ?)').run(grp.alice).lastInsertRowid);
  db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?), (?, ?)').run(dm3, grp.alice, dm3, grp.bot.userId);
  await dispatcher.maybeRespond(post('dm', dm3, grp.alice, 'group'));
  assert.equal(botMessages(grp, 'dm', dm3).length, 0);

  const enc = world();
  const dm4 = Number(db.prepare('INSERT INTO dm_channels (is_group, created_by, e2ee_enabled) VALUES (0, ?, 1)').run(enc.alice).lastInsertRowid);
  db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?), (?, ?)').run(dm4, enc.alice, dm4, enc.bot.userId);
  await dispatcher.maybeRespond(post('dm', dm4, enc.alice, 'secret'));
  assert.equal(botMessages(enc, 'dm', dm4).length, 0);
});

test('a bot cannot answer in a channel it cannot view', async () => {
  const w = world({ channelType: 'private' });
  await dispatcher.maybeRespond(post('channel', w.channel, w.alice, `@${w.bot.user.username} secret room`));
  assert.equal(botMessages(w).length, 0);
  assert.equal(requests.length, 0);
});

test('a timed-out author is ignored', async () => {
  const w = world();
  db.prepare('UPDATE server_members SET timeout_until = ? WHERE server_id = ? AND user_id = ?')
    .run(new Date(Date.now() + 3_600_000).toISOString(), w.serverId, w.alice);
  await dispatcher.maybeRespond(post('channel', w.channel, w.alice, `@${w.bot.user.username} hi`));
  assert.equal(botMessages(w).length, 0);
});

test('a disabled provider is ignored', async () => {
  const w = world();
  db.prepare('UPDATE ai_providers SET enabled = 0 WHERE id = ?').run(w.provider);
  await dispatcher.maybeRespond(post('channel', w.channel, w.alice, `@${w.bot.user.username} hi`));
  assert.equal(botMessages(w).length, 0);
});

test('cooldown ignores a second message from the same user', async () => {
  const w = world();
  dispatcher._settings.cooldownMs = 60_000;
  await dispatcher.maybeRespond(post('channel', w.channel, w.alice, `@${w.bot.user.username} one`));
  await dispatcher.maybeRespond(post('channel', w.channel, w.alice, `@${w.bot.user.username} two`));
  assert.equal(botMessages(w).length, 1);
});

test('a full queue answers busy without calling the provider', async () => {
  const w = world();
  dispatcher._queue.maxWaiting = 0;
  delayMs = 200;
  const m1 = post('channel', w.channel, w.alice, `@${w.bot.user.username} first`);
  const m2 = post('channel', w.channel, w.owner, `@${w.bot.user.username} second`);
  await Promise.all([dispatcher.maybeRespond(m1), dispatcher.maybeRespond(m2)]);
  assert.equal(requests.length, 1);
  const replies = botMessages(w);
  assert.equal(replies.length, 2);
  assert.ok(replies.some((r) => /busy/i.test(r.content)));
});

test('provider failure posts one short failure reply and leaks no upstream detail', async () => {
  const w = world();
  mode = 'fail';
  await dispatcher.maybeRespond(post('channel', w.channel, w.alice, `@${w.bot.user.username} hi`));
  const replies = botMessages(w);
  assert.equal(replies.length, 1);
  assert.match(replies[0].content, /could not answer/i);
  assert.ok(!replies[0].content.includes('nope'));
});

test('an empty answer posts a no-answer notice', async () => {
  const w = world();
  mode = 'empty';
  await dispatcher.maybeRespond(post('channel', w.channel, w.alice, `@${w.bot.user.username} hi`));
  assert.match(botMessages(w)[0].content, /no answer/i);
});

test('model output cannot ping or inject: mentions are neutralized in storage', async () => {
  const w = world();
  mode = 'inject';
  await dispatcher.maybeRespond(post('channel', w.channel, w.alice, `@${w.bot.user.username} hi`));
  const content = botMessages(w)[0].content;
  assert.ok(!/@[a-zA-Z0-9_.]/.test(content), content);
  assert.ok(content.includes('look'));
});

test('an unrelated bot on the same server is not triggered', async () => {
  const w = world();
  const other = botStore.createBot({ serverId: w.serverId, actorId: w.owner, siteAuthority: true, body: { displayName: 'Other', providerId: w.provider, model: 'm' } });
  await dispatcher.maybeRespond(post('channel', w.channel, w.alice, `@${w.bot.user.username} hi`));
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM messages WHERE author_id = ?').get(other.userId).c, 0);
});

test('a trigger message without text (attachment only) is ignored', async () => {
  const w = world();
  const dm = Number(db.prepare('INSERT INTO dm_channels (is_group, created_by) VALUES (0, ?)').run(w.alice).lastInsertRowid);
  db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?), (?, ?)').run(dm, w.alice, dm, w.bot.userId);
  await dispatcher.maybeRespond(post('dm', dm, w.alice, '   '));
  assert.equal(botMessages(w, 'dm', dm).length, 0);
  assert.equal(requests.length, 0);
});
