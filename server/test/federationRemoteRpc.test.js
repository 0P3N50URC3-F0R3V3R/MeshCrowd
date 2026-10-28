'use strict';
const test = require('node:test');
process.env.DISMESH_FEDERATION_ALLOW_LOOPBACK = '1'; // these tests talk to peers on 127.0.0.1
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;
const { db } = require('../db');

// Wrapped before federationApi.js is first required so its destructured notifyUser is the recorder.
const hub = require('../socket/hub');
const pushed = [];
hub.notifyUser = (userId, payload) => { pushed.push({ userId, payload }); };

const { inboxHandlers } = require('../routes/federationApi');
const federationApiRouter = require('../routes/federationApi');
const remoteRouter = require('../routes/remote');
const { handleRpc } = require('../lib/remoteChannelRpc');
const { relayRemoteChannelEvent } = require('../lib/remoteChannelEvents');
const { PERMISSIONS, DEFAULT_EVERYONE_PERMISSIONS } = require('../lib/permissions');
const { signPayload, getOrCreateKeypair } = require('../lib/federationCrypto');
const { ownDomain } = require('../lib/federationOutboxWorker');

test.after(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

let uid = 0;
function makeUser(username) {
  uid += 1;
  return db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run(`${username}${uid}`, `${username}${uid}@test.local`, 'hash', username).lastInsertRowid;
}
function makePeer(domain, status = 'active', publicUrl = `https://${domain}`, pubkey = 'PEM') {
  return db.prepare('INSERT INTO federation_peers (domain, public_url, their_pubkey, status) VALUES (?, ?, ?, ?)')
    .run(domain, publicUrl, pubkey, status).lastInsertRowid;
}
function makeRemoteMember(peerId, username, domain, serverId) {
  const id = db.prepare(
    `INSERT INTO users (username, email, password_hash, display_name, home_instance_id, federated_uid) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(`remote_${username}_${++uid}`, `${username}${uid}@remote.invalid`, 'x', username, peerId, `${username}@${domain}`).lastInsertRowid;
  if (serverId) db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(serverId, id);
  return id;
}

let serverCounter = 0;
// Owner O hosts a server with: public #general, private #secret (only 'alice' has a user override
// granting VIEW), announcement #news (read-only for non-mods), voice #talk. Peer p.example has
// members alice, bob; peer q.example has carol.
function setUp() {
  serverCounter += 1;
  const owner = makeUser('owner');
  const serverId = db.prepare(`INSERT INTO servers (name, owner_id, invite_code, visibility) VALUES (?, ?, ?, 'public')`).run(`S${serverCounter}`, owner, `code-${serverCounter}`).lastInsertRowid;
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(serverId, owner);
  db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 0, 1)').run(serverId, '@everyone', DEFAULT_EVERYONE_PERMISSIONS);
  const ch = (name, type) => db.prepare('INSERT INTO channels (server_id, name, type, position) VALUES (?, ?, ?, ?)').run(serverId, name, type, 0).lastInsertRowid;
  const general = ch('general', 'public');
  const secret = ch('secret', 'private');
  const news = ch('news', 'announcement');
  const talk = ch('talk', 'voice');
  const domainP = `p${serverCounter}.example`;
  const domainQ = `q${serverCounter}.example`;
  const peerP = makePeer(domainP);
  const peerQ = makePeer(domainQ);
  const alice = makeRemoteMember(peerP, 'alice', domainP, serverId);
  const bob = makeRemoteMember(peerP, 'bob', domainP, serverId);
  const carol = makeRemoteMember(peerQ, 'carol', domainQ, serverId);
  db.prepare('INSERT INTO channel_user_overrides (channel_id, user_id, allow, deny) VALUES (?, ?, ?, 0)').run(secret, alice, PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.SEND_MESSAGES);
  return {
    owner, serverId, general, secret, news, talk, alice, bob, carol,
    peerP: { id: peerP, domain: domainP }, peerQ: { id: peerQ, domain: domainQ },
  };
}

const call = (peer, type, username, payload) => handleRpc(peer, type, { username, ...payload });

test('server_info lists only viewable text channels and reports the caller\'s own id', () => {
  const s = setUp();
  const asAlice = call(s.peerP, 'server_info', 'alice', { serverId: s.serverId });
  assert.equal(asAlice.ok, true);
  assert.deepEqual(asAlice.channels.map((c) => c.name), ['general', 'secret', 'news']);
  assert.equal(asAlice.selfUserId, s.alice);
  assert.equal(asAlice.channels.find((c) => c.name === 'news').canSend, false);
  assert.equal(asAlice.channels.find((c) => c.name === 'general').canSend, true);

  const asBob = call(s.peerP, 'server_info', 'bob', { serverId: s.serverId });
  assert.deepEqual(asBob.channels.map((c) => c.name), ['general', 'news'], 'a private channel must not even be named to a member who cannot view it');
});

test('a caller who is not a member, unknown, or asserts a malformed username learns only not_member', () => {
  const s = setUp();
  assert.equal(call(s.peerP, 'server_info', 'ghost', { serverId: s.serverId }).error, 'not_member');
  assert.equal(call(s.peerP, 'server_info', 'alice@evil.example', { serverId: s.serverId }).error, 'not_member');
  assert.equal(call(s.peerP, 'server_info', 42, { serverId: s.serverId }).error, 'not_member');
  assert.equal(call(s.peerP, 'server_info', 'alice', { serverId: 999999 }).error, 'not_member');
  assert.equal(call(s.peerP, 'server_info', 'alice', { serverId: String(s.serverId) }).error, 'not_member');
  // alice's identity asserted through the WRONG peer must not resolve to her cached user
  assert.equal(call(s.peerQ, 'server_info', 'alice', { serverId: s.serverId }).error, 'not_member');
  const left = call(s.peerP, 'leave_server', 'bob', { serverId: s.serverId });
  assert.equal(left.ok, true);
  assert.equal(call(s.peerP, 'server_info', 'bob', { serverId: s.serverId }).error, 'not_member');
});

test('reading a channel needs VIEW_CHANNEL; a hidden or non-text channel looks nonexistent', () => {
  const s = setUp();
  db.prepare(`INSERT INTO messages (scope_type, scope_id, author_id, content) VALUES ('channel', ?, ?, 'top secret')`).run(s.secret, s.owner);
  assert.equal(call(s.peerP, 'list_messages', 'bob', { serverId: s.serverId, channelId: s.secret }).error, 'channel not found');
  assert.equal(call(s.peerP, 'list_messages', 'alice', { serverId: s.serverId, channelId: s.secret }).messages[0].content, 'top secret');
  assert.equal(call(s.peerP, 'list_messages', 'alice', { serverId: s.serverId, channelId: s.talk }).error, 'channel not found');
  const other = setUp();
  assert.equal(call(s.peerP, 'list_messages', 'alice', { serverId: s.serverId, channelId: other.general }).error, 'channel not found', 'a channel of another server');
});

test('list_messages bounds limit and before, pages backwards, and hides system messages', () => {
  const s = setUp();
  for (let i = 1; i <= 7; i += 1) {
    db.prepare(`INSERT INTO messages (scope_type, scope_id, author_id, content) VALUES ('channel', ?, ?, ?)`).run(s.general, s.owner, `m${i}`);
  }
  db.prepare(`INSERT INTO messages (scope_type, scope_id, author_id, content, event_type) VALUES ('channel', ?, ?, 'joined', 'member_join')`).run(s.general, s.owner);
  const base = { serverId: s.serverId, channelId: s.general };
  const page1 = call(s.peerP, 'list_messages', 'bob', { ...base, limit: 3 });
  assert.deepEqual(page1.messages.map((m) => m.content), ['m5', 'm6', 'm7']);
  assert.equal(page1.hasMore, true);
  const page2 = call(s.peerP, 'list_messages', 'bob', { ...base, limit: 3, before: page1.messages[0].id });
  assert.deepEqual(page2.messages.map((m) => m.content), ['m2', 'm3', 'm4']);
  assert.equal(call(s.peerP, 'list_messages', 'bob', { ...base, limit: 100000 }).messages.length, 7, 'limit is clamped and event rows excluded');
  assert.equal(call(s.peerP, 'list_messages', 'bob', { ...base, limit: -5, before: 'x' }).ok, true, 'garbage limit/before fall back to defaults');
  const shape = page1.messages[0];
  assert.deepEqual(Object.keys(shape).sort(), ['attachments', 'author', 'channelId', 'content', 'createdAt', 'editedAt', 'id', 'reactions', 'threadId', 'unsupported']);
  assert.equal(shape.author.domain, ownDomain());
});

test('posting enforces SEND_MESSAGES, channel type rules, timeouts, slowmode and content bounds', () => {
  const s = setUp();
  const post = (username, channelId, content) => call(s.peerP, 'channel_message_create', username, { serverId: s.serverId, channelId, content });

  assert.equal(post('bob', s.news, 'hi').error, 'missing permission', 'announcement channels are read-only for non-mods');
  assert.equal(post('bob', s.secret, 'hi').error, 'channel not found');
  assert.equal(post('bob', s.general, '   ').error, 'content required');
  const ok = post('bob', s.general, 'x'.repeat(20000));
  assert.equal(ok.ok, true);
  assert.equal(ok.message.content.length, 15000);
  assert.equal(ok.message.author.username, 'bob');
  assert.equal(ok.message.author.domain, s.peerP.domain);

  db.prepare('UPDATE server_members SET timeout_until = ? WHERE server_id = ? AND user_id = ?').run(new Date(Date.now() + 60_000).toISOString(), s.serverId, s.bob);
  assert.equal(post('bob', s.general, 'hi').error, 'timed_out');
  db.prepare('UPDATE server_members SET timeout_until = NULL WHERE server_id = ? AND user_id = ?').run(s.serverId, s.bob);

  db.prepare('UPDATE channels SET slowmode_seconds = 600 WHERE id = ?').run(s.general);
  const slow = post('bob', s.general, 'again');
  assert.equal(slow.error, 'slowmode');
  assert.equal(slow.status, 429);
  assert.ok(slow.retryAfter > 0);
  db.prepare('UPDATE channels SET slowmode_seconds = 0 WHERE id = ?').run(s.general);

  db.prepare('UPDATE roles SET permissions = ? WHERE server_id = ?').run(PERMISSIONS.VIEW_CHANNEL, s.serverId);
  assert.equal(post('bob', s.general, 'hi').error, 'missing permission');
});

test('edit and delete are author-only, and channel scoped', () => {
  const s = setUp();
  const mk = (username) => call(s.peerP, 'channel_message_create', username, { serverId: s.serverId, channelId: s.general, content: `by ${username}` }).message;
  const aliceMsg = mk('alice');
  const bobMsg = mk('bob');
  const ownerMsgId = db.prepare(`INSERT INTO messages (scope_type, scope_id, author_id, content) VALUES ('channel', ?, ?, 'owner msg')`).run(s.general, s.owner).lastInsertRowid;
  const base = { serverId: s.serverId, channelId: s.general };

  assert.equal(call(s.peerP, 'channel_message_edit', 'bob', { ...base, messageId: aliceMsg.id, content: 'hijack' }).error, 'not your message');
  assert.equal(call(s.peerP, 'channel_message_edit', 'bob', { ...base, messageId: ownerMsgId, content: 'hijack' }).error, 'not your message');
  assert.equal(call(s.peerP, 'channel_message_delete', 'bob', { ...base, messageId: aliceMsg.id }).error, 'not your message');
  assert.equal(call(s.peerP, 'channel_message_delete', 'bob', { ...base, messageId: ownerMsgId }).error, 'not your message');
  assert.equal(db.prepare('SELECT content FROM messages WHERE id = ?').get(aliceMsg.id).content, 'by alice');

  assert.equal(call(s.peerP, 'channel_message_edit', 'bob', { ...base, messageId: bobMsg.id, content: '   ' }).error, 'content required');
  const edited = call(s.peerP, 'channel_message_edit', 'bob', { ...base, messageId: bobMsg.id, content: 'edited' });
  assert.equal(edited.message.content, 'edited');
  assert.ok(edited.message.editedAt);
  assert.equal(call(s.peerP, 'channel_message_edit', 'bob', { ...base, messageId: 'abc', content: 'x' }).error, 'message not found');
  assert.equal(call(s.peerP, 'channel_message_edit', 'bob', { serverId: s.serverId, channelId: s.secret, messageId: bobMsg.id, content: 'x' }).error, 'channel not found');

  assert.equal(call(s.peerP, 'channel_message_delete', 'bob', { ...base, messageId: bobMsg.id }).ok, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE id = ?').get(bobMsg.id).n, 0);
});

test('reactions: any viewer may react, bounded emoji, timed-out members may only remove', () => {
  const s = setUp();
  const msg = call(s.peerP, 'channel_message_create', 'alice', { serverId: s.serverId, channelId: s.general, content: 'react to me' }).message;
  const base = { serverId: s.serverId, channelId: s.general, messageId: msg.id };

  const added = call(s.peerQ, 'channel_reaction_add', 'carol', { ...base, emoji: '\u{1F44D}' });
  assert.equal(added.ok, true);
  assert.deepEqual(added.message.reactions, [{ emoji: '\u{1F44D}', userIds: [s.carol] }]);
  assert.equal(call(s.peerQ, 'channel_reaction_add', 'carol', { ...base, emoji: '' }).error, 'emoji required');
  const long = call(s.peerQ, 'channel_reaction_add', 'carol', { ...base, emoji: 'z'.repeat(100) });
  assert.equal(long.message.reactions.find((r) => r.emoji.startsWith('z')).emoji.length, 34);

  db.prepare('UPDATE server_members SET timeout_until = ? WHERE server_id = ? AND user_id = ?').run(new Date(Date.now() + 60_000).toISOString(), s.serverId, s.carol);
  assert.equal(call(s.peerQ, 'channel_reaction_add', 'carol', { ...base, emoji: 'x' }).error, 'timed_out');
  const removed = call(s.peerQ, 'channel_reaction_remove', 'carol', { ...base, emoji: '\u{1F44D}' });
  assert.equal(removed.message.reactions.some((r) => r.emoji === '\u{1F44D}'), false);

  assert.equal(call(s.peerP, 'channel_reaction_add', 'bob', { serverId: s.serverId, channelId: s.secret, messageId: msg.id, emoji: 'x' }).error, 'channel not found', 'cannot react in a channel you cannot view');
});

test('unknown rpc types and prototype keys are refused', () => {
  const s = setUp();
  assert.equal(call(s.peerP, 'drop_tables', 'alice', { serverId: s.serverId }).error, 'unknown rpc type');
  assert.equal(handleRpc(s.peerP, 'constructor', { username: 'alice', serverId: s.serverId }).error, 'unknown rpc type');
  assert.equal(handleRpc(s.peerP, '__proto__', {}).error, 'unknown rpc type');
});

test('leave_server removes only the caller\'s member row', () => {
  const s = setUp();
  assert.equal(call(s.peerP, 'leave_server', 'alice', { serverId: s.serverId }).ok, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM server_members WHERE server_id = ? AND user_id = ?').get(s.serverId, s.alice).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM server_members WHERE server_id = ? AND user_id = ?').get(s.serverId, s.bob).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM server_members WHERE server_id = ? AND user_id = ?').get(s.serverId, s.owner).n, 1);
});

test('fan-out: one event per peer, only peers with a member who can VIEW the channel, naming those viewers', () => {
  const s = setUp();
  db.prepare('DELETE FROM federation_outbox').run();
  const channel = (id) => db.prepare('SELECT * FROM channels WHERE id = ?').get(id);
  const rows = () => db.prepare(`SELECT peer_id, payload_json FROM federation_outbox WHERE type = 'remote_channel_event' ORDER BY id`).all()
    .map((r) => ({ peerId: r.peer_id, ...JSON.parse(r.payload_json) }));

  relayRemoteChannelEvent(channel(s.general), 'message_delete', { messageId: 5 });
  let out = rows();
  assert.equal(out.length, 2);
  assert.deepEqual(out.find((e) => e.peerId === s.peerP.id).viewers.sort(), ['alice', 'bob']);
  assert.deepEqual(out.find((e) => e.peerId === s.peerQ.id).viewers, ['carol']);
  assert.equal(out[0].messageId, 5);
  assert.equal(out[0].kind, 'message_delete');

  db.prepare('DELETE FROM federation_outbox').run();
  relayRemoteChannelEvent(channel(s.secret), 'message_delete', { messageId: 6 });
  out = rows();
  assert.equal(out.length, 1, 'peer q has no member who may view the private channel, so it gets nothing');
  assert.equal(out[0].peerId, s.peerP.id);
  assert.deepEqual(out[0].viewers, ['alice'], 'bob shares the peer but cannot view, so he is not named');

  db.prepare('DELETE FROM federation_outbox').run();
  db.prepare(`UPDATE federation_peers SET status = 'revoked' WHERE id = ?`).run(s.peerQ.id);
  relayRemoteChannelEvent(channel(s.general), 'message_delete', { messageId: 7 });
  assert.equal(rows().length, 1, 'a revoked peer is never sent anything');
});

test('inbound remote_channel_event pushes only to local users with a ledger row AND named as a viewer; junk is dropped', () => {
  const peerId = makePeer(`home${serverCounter}.example`);
  const stranger = makePeer(`stranger${serverCounter}.example`);
  const bobL = makeUser('bobl');
  const carolL = makeUser('caroll');
  const daveL = makeUser('davel');
  const username = (id) => db.prepare('SELECT username FROM users WHERE id = ?').get(id).username;
  const join = (userId, peer, serverId) => db.prepare('INSERT INTO remote_memberships (user_id, peer_id, remote_server_id, name) VALUES (?, ?, ?, ?)').run(userId, peer, serverId, 'S');
  join(bobL, peerId, 42);
  join(carolL, peerId, 42);
  join(daveL, peerId, 43);

  const message = { id: 9, channelId: 7, author: { id: 3, username: 'x', displayName: 'X', domain: 'o.example' }, content: 'c'.repeat(20000), createdAt: 't', editedAt: null, reactions: [], unsupported: false };
  const peer = { id: peerId };
  pushed.length = 0;
  inboxHandlers.remote_channel_event(peer, { serverId: 42, channelId: 7, kind: 'message_create', viewers: [username(bobL), 'nobody'], message });
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].userId, bobL, 'carol joined too but the owner did not name her as a viewer');
  assert.equal(pushed[0].payload.type, 'remote_channel_event');
  assert.equal(pushed[0].payload.peerId, peerId);
  assert.equal(pushed[0].payload.message.content.length, 15000, 'remote text is length-capped');

  pushed.length = 0;
  inboxHandlers.remote_channel_event({ id: stranger }, { serverId: 42, channelId: 7, kind: 'message_create', viewers: [username(bobL)], message });
  assert.equal(pushed.length, 0, 'an event from a peer the user never joined through is dropped');
  inboxHandlers.remote_channel_event(peer, { serverId: 99, channelId: 7, kind: 'message_create', viewers: [username(bobL)], message });
  assert.equal(pushed.length, 0, 'unknown server');
  inboxHandlers.remote_channel_event(peer, { serverId: 42, channelId: 7, kind: 'drop_everything', viewers: [username(bobL)], message });
  inboxHandlers.remote_channel_event(peer, { serverId: 42, channelId: 7, kind: 'message_create', viewers: 'bob', message });
  inboxHandlers.remote_channel_event(peer, { serverId: 42, channelId: 7, kind: 'message_create', viewers: [username(bobL)], message: { ...message, channelId: 8 } });
  inboxHandlers.remote_channel_event(peer, { serverId: 42, channelId: 7, kind: 'message_create', viewers: [username(bobL)], message: 'nope' });
  inboxHandlers.remote_channel_event(peer, { serverId: 42, channelId: 7, kind: 'message_delete', viewers: [username(bobL)], messageId: 'x' });
  assert.equal(pushed.length, 0, 'malformed events are dropped silently');

  inboxHandlers.remote_channel_event(peer, { serverId: 42, channelId: 7, kind: 'message_delete', viewers: [username(bobL)], messageId: 9 });
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].payload.messageId, 9);
});

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

test('POST /federation/api/rpc: pending peers refused, bad signature refused, mutating replays refused', async (t) => {
  const { publicKeyPem } = getOrCreateKeypair();
  const domain = ownDomain();
  db.prepare('DELETE FROM federation_peers WHERE domain = ?').run(domain);
  const peerId = makePeer(domain, 'pending', 'https://self.example', publicKeyPem);
  const s = setUp();
  const aliceCached = makeRemoteMember(peerId, 'zed', domain, s.serverId);

  const app = express();
  app.use(express.json());
  app.use('/federation/api', federationApiRouter);
  const { server, base } = await listen(app);
  t.after(() => server.close());

  const signed = (type, payload, overrides = {}) => {
    const env = { event_id: crypto.randomUUID(), type, origin_domain: domain, created_at: new Date().toISOString(), payload, ...overrides };
    return { ...env, signature: signPayload(env) };
  };
  const post = (body) => fetch(`${base}/federation/api/rpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const info = { username: 'zed', serverId: s.serverId };

  assert.equal((await post(signed('server_info', info))).status, 401, 'a pending peer cannot read anything');
  db.prepare(`UPDATE federation_peers SET status = 'revoked' WHERE id = ?`).run(peerId);
  assert.equal((await post(signed('server_info', info))).status, 401, 'a revoked peer cannot read anything');
  db.prepare(`UPDATE federation_peers SET status = 'active' WHERE id = ?`).run(peerId);

  const res = await post(signed('server_info', info));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);

  const tampered = signed('server_info', info);
  tampered.payload = { ...info, username: 'alice' };
  assert.equal((await post(tampered)).status, 401, 'payload changed after signing');

  const stale = signed('server_info', info, { created_at: new Date(Date.now() - 10 * 60_000).toISOString() });
  assert.equal((await post(stale)).status, 401);

  assert.equal((await post(signed('server_info', [1, 2]))).status, 400);

  const create = signed('channel_message_create', { ...info, channelId: s.general, content: 'once' });
  assert.equal((await (await post(create)).json()).ok, true);
  const replay = await (await post(create)).json();
  assert.equal(replay.ok, false);
  assert.equal(replay.error, 'replay');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE scope_type = 'channel' AND scope_id = ? AND author_id = ?`).get(s.general, aliceCached).n, 1);
});

test('/api/remote: every route is scoped to the requesting user\'s own ledger rows and active peers', async (t) => {
  const rpcCalls = [];
  const stub = express();
  stub.use(express.json());
  let reply = { ok: true, messages: [], hasMore: false };
  stub.post('/federation/api/rpc', (req, res) => { rpcCalls.push(req.body); res.json(reply); });
  const { server: stubServer, base: stubBase } = await listen(stub);
  t.after(() => stubServer.close());

  const peerId = makePeer(`ledger${serverCounter}.example`, 'active', stubBase);
  const mine = db.prepare('SELECT * FROM users WHERE id = ?').get(makeUser('mine'));
  const theirs = db.prepare('SELECT * FROM users WHERE id = ?').get(makeUser('theirs'));
  db.prepare('INSERT INTO remote_memberships (user_id, peer_id, remote_server_id, name) VALUES (?, ?, 5, ?)').run(mine.id, peerId, 'Mine');
  db.prepare('INSERT INTO remote_memberships (user_id, peer_id, remote_server_id, name) VALUES (?, ?, 6, ?)').run(theirs.id, peerId, 'Theirs');

  let current = mine;
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = current; next(); });
  app.use('/api/remote', remoteRouter);
  const { server, base } = await listen(app);
  t.after(() => server.close());
  const api = (method, url, body) => fetch(`${base}/api/remote${url}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

  const list = await (await api('GET', '/servers')).json();
  assert.deepEqual(list.servers.map((x) => x.name), ['Mine']);

  assert.equal((await api('GET', `/${peerId}/6/channels/1/messages`)).status, 404, 'a server only someone else joined');
  assert.equal(rpcCalls.length, 0, 'ownership is checked before any RPC leaves this instance');
  assert.equal((await api('POST', `/${peerId}/6/channels/1/messages`, { content: 'x' })).status, 404);
  assert.equal((await api('DELETE', `/${peerId}/6`)).status, 404);
  assert.equal((await api('GET', `/abc/5`)).status, 404);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM remote_memberships WHERE user_id = ?').get(theirs.id).n, 1);

  const ok = await api('GET', `/${peerId}/5/channels/3/messages?before=10&limit=20`);
  assert.equal(ok.status, 200);
  assert.deepEqual(rpcCalls[0].payload, { serverId: 5, username: mine.username, displayName: mine.display_name, remoteId: mine.id, channelId: 3, before: 10, limit: 20 });
  assert.equal(rpcCalls[0].type, 'list_messages');

  assert.equal((await api('POST', `/${peerId}/5/channels/3/messages`, { content: '   ' })).status, 400);
  assert.equal(rpcCalls.length, 1, 'blank content is refused before reaching the peer');

  reply = { ok: false, status: 403, error: 'missing permission' };
  const denied = await api('POST', `/${peerId}/5/channels/3/messages`, { content: 'hi' });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error, 'missing permission');

  reply = { ok: false, status: 500, error: '<script>' };
  const odd = await api('GET', `/${peerId}/5/channels/3/messages`);
  assert.equal(odd.status, 502, 'unexpected statuses from a peer are never passed through');
  assert.equal((await odd.json()).error, 'unreachable');

  db.prepare(`UPDATE federation_peers SET public_url = 'http://127.0.0.1:1' WHERE id = ?`).run(peerId);
  const down = await api('GET', `/${peerId}/5`);
  assert.equal(down.status, 502);
  assert.equal((await down.json()).error, 'unreachable');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM remote_memberships WHERE user_id = ?').get(mine.id).n, 1, 'an unreachable owner does not drop the membership');
  db.prepare('UPDATE federation_peers SET public_url = ? WHERE id = ?').run(stubBase, peerId);

  reply = { ok: false, status: 403, error: 'not_member' };
  assert.equal((await api('GET', `/${peerId}/5`)).status, 404);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM remote_memberships WHERE user_id = ?').get(mine.id).n, 0, 'owner says we are not a member: the stale ledger row is dropped');

  db.prepare('INSERT INTO remote_memberships (user_id, peer_id, remote_server_id, name) VALUES (?, ?, 5, ?)').run(mine.id, peerId, 'Mine');
  db.prepare(`UPDATE federation_peers SET status = 'revoked' WHERE id = ?`).run(peerId);
  assert.equal((await api('GET', `/${peerId}/5`)).status, 404, 'a revoked peer is unusable');
  assert.deepEqual((await (await api('GET', '/servers')).json()).servers, []);
});

test('revoking a peer deletes its membership ledger', () => {
  const peerId = makePeer(`revoke${serverCounter}.example`);
  const u = makeUser('revokee');
  db.prepare('INSERT INTO remote_memberships (user_id, peer_id, remote_server_id, name) VALUES (?, ?, 1, ?)').run(u, peerId, 'S');
  inboxHandlers.peer_revoke({ id: peerId });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM remote_memberships WHERE peer_id = ?').get(peerId).n, 0);

  const other = makePeer(`cascade${serverCounter}.example`);
  db.prepare('INSERT INTO remote_memberships (user_id, peer_id, remote_server_id, name) VALUES (?, ?, 1, ?)').run(u, other, 'S');
  db.prepare('DELETE FROM federation_peers WHERE id = ?').run(other);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM remote_memberships WHERE peer_id = ?').get(other).n, 0, 'row deletion cascades');
});

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

test('list_members: members only, public-safe fields, home identity per member', () => {
  const s = setUp();
  db.prepare(`UPDATE users SET bio = 'secret bio', avatar_path = '/uploads/avatars/x.png' WHERE id = ?`).run(s.owner);
  const res = call(s.peerP, 'list_members', 'bob', { serverId: s.serverId });
  assert.equal(res.ok, true);
  assert.equal(res.members.length, 4);
  for (const m of res.members) assert.deepEqual(Object.keys(m).sort(), ['displayName', 'domain', 'hasAvatar', 'id', 'isOwner', 'status', 'username']);
  const owner = res.members.find((m) => m.id === s.owner);
  assert.equal(owner.isOwner, true);
  assert.equal(owner.hasAvatar, true);
  assert.equal(owner.domain, ownDomain());
  assert.equal(owner.status, 'offline');
  const carol = res.members.find((m) => m.id === s.carol);
  assert.deepEqual([carol.username, carol.domain], ['carol', s.peerQ.domain]);
  assert.equal(call(s.peerP, 'list_members', 'ghost', { serverId: s.serverId }).error, 'not_member');
  assert.equal(call(s.peerQ, 'list_members', 'alice', { serverId: s.serverId }).error, 'not_member');
});

test('member_avatar serves only a raster avatar of a member of that server, never a path outside avatars/', () => {
  const s = setUp();
  const dir = path.join(tmpDir, 'avatars');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `a${s.serverId}.png`), PNG);
  db.prepare('UPDATE users SET avatar_path = ? WHERE id = ?').run(`/uploads/avatars/a${s.serverId}.png`, s.owner);
  const got = call(s.peerP, 'member_avatar', 'alice', { serverId: s.serverId, userId: s.owner });
  assert.equal(got.ok, true);
  assert.deepEqual(Buffer.from(got.dataBase64, 'base64'), PNG);

  const outsider = makeUser('outsider');
  db.prepare('UPDATE users SET avatar_path = ? WHERE id = ?').run(`/uploads/avatars/a${s.serverId}.png`, outsider);
  assert.equal(call(s.peerP, 'member_avatar', 'alice', { serverId: s.serverId, userId: outsider }).error, 'avatar not found', 'not a member of this server');
  for (const bad of ['/uploads/avatars/../dismesh.db', '/uploads/attachments/x.png', '/uploads/../../etc/x.png']) {
    db.prepare('UPDATE users SET avatar_path = ? WHERE id = ?').run(bad, s.owner);
    assert.equal(call(s.peerP, 'member_avatar', 'alice', { serverId: s.serverId, userId: s.owner }).error, 'avatar not found', bad);
  }
  assert.equal(call(s.peerP, 'member_avatar', 'ghost', { serverId: s.serverId, userId: s.owner }).error, 'not_member');
});

test('attachments: posted through the owner pipeline with its permission, type and size rules', () => {
  const s = setUp();
  const post = (username, channelId, attachments, content = '') => call(s.peerP, 'channel_message_create', username, { serverId: s.serverId, channelId, content, attachments });
  const png = { fileName: '../evil name.png', mimeType: 'image/png', dataBase64: PNG.toString('base64') };

  const ok = post('bob', s.general, [png]);
  assert.equal(ok.ok, true, 'attachment-only message is allowed');
  assert.equal(ok.message.unsupported, false);
  assert.equal(ok.message.attachments.length, 1);
  assert.equal(ok.message.attachments[0].fileName, 'evil_name.png');
  assert.equal(ok.message.attachments[0].sizeBytes, PNG.length);
  assert.equal('url' in ok.message.attachments[0], false, 'no owner URL ever leaves the instance');
  const row = db.prepare('SELECT * FROM attachments WHERE id = ?').get(ok.message.attachments[0].id);
  assert.match(row.file_path, new RegExp(`^/uploads/attachments/channel-${s.general}/[0-9a-f]{16}-evil_name\\.png$`));
  assert.deepEqual(fs.readFileSync(path.join(tmpDir, row.file_path.replace(/^\/uploads\//, ''))), PNG);

  assert.equal(post('bob', s.general, [{ ...png, fileName: 'x.html' }]).error, 'file type not allowed');
  assert.equal(post('bob', s.general, [{ ...png, dataBase64: '' }]).error, 'invalid attachment');
  assert.equal(post('bob', s.general, [{ fileName: 'a.png' }]).error, 'invalid attachment');
  assert.equal(post('bob', s.general, Array(6).fill(png)).error, 'too many attachments');
  assert.equal(post('bob', s.general, 'nope').error, 'too many attachments');
  assert.match(post('bob', s.general, [{ ...png, dataBase64: Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64') }]).error, /too large/);
  assert.equal(post('bob', s.general, [{ ...png, mimeType: 'text/html; x' }]).message.attachments[0].mimeType, 'application/octet-stream');
  assert.equal(post('bob', s.general, []).error, 'content required');
  assert.equal(post('bob', s.secret, [png]).error, 'channel not found');

  db.prepare('UPDATE roles SET permissions = ? WHERE server_id = ?').run(PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.SEND_MESSAGES, s.serverId);
  assert.equal(post('bob', s.general, [png]).error, 'missing permission: Attach Files');
  assert.equal(post('bob', s.general, undefined, 'text still fine').ok, true);
});

test('get_attachment: only from a channel (or its thread) the caller can view, bounded size', () => {
  const s = setUp();
  const attach = (scopeType, scopeId, name) => {
    const msgId = db.prepare('INSERT INTO messages (scope_type, scope_id, author_id, content) VALUES (?, ?, ?, ?)').run(scopeType, scopeId, s.owner, '').lastInsertRowid;
    const dir = path.join(tmpDir, 'attachments', 'probe');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), PNG);
    return db.prepare('INSERT INTO attachments (message_id, file_path, file_name, mime_type, size_bytes) VALUES (?, ?, ?, ?, ?)')
      .run(msgId, `/uploads/attachments/probe/${name}`, name, 'image/png', PNG.length).lastInsertRowid;
  };
  const inGeneral = attach('channel', s.general, `g${s.serverId}.png`);
  const inSecret = attach('channel', s.secret, `s${s.serverId}.png`);
  const threadId = db.prepare('INSERT INTO threads (channel_id, title, created_by) VALUES (?, ?, ?)').run(s.general, 'T', s.owner).lastInsertRowid;
  const inThread = attach('thread', threadId, `t${s.serverId}.png`);
  const get = (username, channelId, attachmentId) => call(s.peerP, 'get_attachment', username, { serverId: s.serverId, channelId, attachmentId });

  const got = get('bob', s.general, inGeneral);
  assert.equal(got.ok, true);
  assert.deepEqual(Buffer.from(got.dataBase64, 'base64'), PNG);
  assert.equal(get('bob', s.general, inThread).ok, true, 'a thread of a viewable channel');
  assert.equal(get('bob', s.secret, inSecret).error, 'channel not found');
  assert.equal(get('bob', s.general, inSecret).error, 'attachment not found', 'naming a viewable channel does not reach another channel\'s file');
  assert.equal(get('alice', s.secret, inSecret).ok, true);
  assert.equal(get('bob', s.general, 'x').error, 'attachment not found');

  db.prepare('UPDATE attachments SET size_bytes = ? WHERE id = ?').run(9 * 1024 * 1024, inGeneral);
  assert.equal(get('bob', s.general, inGeneral).status, 413);
  db.prepare(`UPDATE attachments SET size_bytes = 1, file_path = '/uploads/attachments/../dismesh.db' WHERE id = ?`).run(inGeneral);
  assert.equal(get('bob', s.general, inGeneral).error, 'attachment not found', 'a stored path escaping attachments/ is never read');
});

test('threads are readable (list + messages) with the same VIEW_CHANNEL gate', () => {
  const s = setUp();
  const threadId = db.prepare('INSERT INTO threads (channel_id, title, created_by) VALUES (?, ?, ?)').run(s.general, 'Plans', s.owner).lastInsertRowid;
  for (const c of ['t1', 't2', 't3']) db.prepare(`INSERT INTO messages (scope_type, scope_id, author_id, content) VALUES ('thread', ?, ?, ?)`).run(threadId, s.owner, c);
  const secretThread = db.prepare('INSERT INTO threads (channel_id, title, created_by) VALUES (?, ?, ?)').run(s.secret, 'Hidden', s.owner).lastInsertRowid;

  const list = call(s.peerP, 'list_threads', 'bob', { serverId: s.serverId, channelId: s.general });
  assert.deepEqual(list.threads.map((th) => [th.id, th.title, th.messageCount]), [[threadId, 'Plans', 3]]);
  assert.equal(list.threads[0].createdBy, 'owner');
  assert.equal(call(s.peerP, 'list_threads', 'bob', { serverId: s.serverId, channelId: s.secret }).error, 'channel not found');

  const page = call(s.peerP, 'list_thread_messages', 'bob', { serverId: s.serverId, channelId: s.general, threadId, limit: 2 });
  assert.deepEqual(page.messages.map((m) => m.content), ['t2', 't3']);
  assert.equal(page.hasMore, true);
  assert.equal(page.messages[0].channelId, s.general);
  assert.equal(page.messages[0].threadId, threadId);
  assert.equal(call(s.peerP, 'list_thread_messages', 'bob', { serverId: s.serverId, channelId: s.general, threadId: secretThread }).error, 'thread not found', 'a thread of another channel');
  assert.equal(call(s.peerP, 'list_thread_messages', 'bob', { serverId: s.serverId, channelId: s.secret, threadId: secretThread }).error, 'channel not found');
});

test('/api/remote members, attachments and threads: proxied, sanitized, never handing out peer URLs', async (t) => {
  const rpcCalls = [];
  const replies = {};
  const stub = express();
  stub.use(express.json({ limit: '12mb' }));
  stub.post('/federation/api/rpc', (req, res) => { rpcCalls.push(req.body); res.json(replies[req.body.type] || { ok: false, status: 404, error: 'nope' }); });
  const { server: stubServer, base: stubBase } = await listen(stub);
  t.after(() => stubServer.close());

  const peerId = makePeer(`files${serverCounter}.example`, 'active', stubBase);
  const me = db.prepare('SELECT * FROM users WHERE id = ?').get(makeUser('filer'));
  const other = db.prepare('SELECT * FROM users WHERE id = ?').get(makeUser('other'));
  db.prepare('INSERT INTO remote_memberships (user_id, peer_id, remote_server_id, name) VALUES (?, ?, 5, ?)').run(me.id, peerId, 'S');
  let current = me;
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = current; next(); });
  app.use('/api/remote', remoteRouter);
  const { server, base } = await listen(app);
  t.after(() => server.close());
  const url = (p) => `${base}/api/remote/${peerId}/5${p}`;

  replies.list_members = { ok: true, members: [
    { id: 1, username: 'a', displayName: 'A\nB', domain: 'o.example', status: 'online', hasAvatar: 1, isOwner: true, email: 'leak@x', bio: 'leak' },
    { id: 2, username: 'b', displayName: 'B', domain: 'o.example', status: '<script>' },
    { id: 'x' },
  ] };
  const members = (await (await fetch(url('/members'))).json()).members;
  assert.equal(members.length, 2);
  assert.deepEqual(Object.keys(members[0]).sort(), ['displayName', 'domain', 'hasAvatar', 'id', 'isOwner', 'status', 'username']);
  assert.equal(members[0].displayName.includes('\n'), false);
  assert.equal(members[0].hasAvatar, true);
  assert.equal(members[1].status, 'offline');

  replies.member_avatar = { ok: true, fileName: 'evil.html', dataBase64: Buffer.from('<script>').toString('base64') };
  assert.equal((await fetch(url('/members/1/avatar'))).status, 502, 'a non-image avatar is never served');
  replies.member_avatar = { ok: true, fileName: 'a.png', dataBase64: PNG.toString('base64') };
  const avatar = await fetch(url('/members/1/avatar'));
  assert.equal(avatar.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await avatar.arrayBuffer()), PNG);

  replies.get_attachment = { ok: true, fileName: '../../x".html', mimeType: 'text/html', dataBase64: Buffer.from('<script>alert(1)</script>').toString('base64') };
  const html = await fetch(url('/channels/3/attachments/9'));
  assert.equal(html.status, 200);
  assert.equal(html.headers.get('content-type'), 'application/octet-stream', 'the peer\'s claimed type is ignored');
  assert.equal(html.headers.get('content-disposition'), 'attachment; filename="x_.html"');
  assert.equal(html.headers.get('content-security-policy'), "default-src 'none'; sandbox");
  assert.deepEqual(rpcCalls.at(-1).payload, { serverId: 5, username: me.username, displayName: me.display_name, remoteId: me.id, channelId: 3, attachmentId: 9 });
  replies.get_attachment = { ok: true, fileName: 'p.png', dataBase64: PNG.toString('base64') };
  const img = await fetch(url('/channels/3/attachments/9'));
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal(img.headers.get('content-disposition'), 'inline; filename="p.png"');
  replies.get_attachment = { ok: false, status: 413, error: 'attachment too large to fetch remotely' };
  assert.equal((await fetch(url('/channels/3/attachments/9'))).status, 413);

  replies.list_messages = { ok: true, hasMore: false, messages: [{
    id: 1, channelId: 3, author: { id: 1 }, content: '', createdAt: 't', reactions: [],
    attachments: [{ id: 4, fileName: 'a b.png', mimeType: 'text/html', sizeBytes: 10, url: 'https://o.example/uploads/x' }, { id: 'x' }],
  }] };
  const listed = (await (await fetch(url('/channels/3/messages'))).json()).messages[0];
  assert.deepEqual(listed.attachments, [{ id: 4, fileName: 'a_b.png', mimeType: 'image/png', sizeBytes: 10 }]);

  replies.channel_message_create = { ok: true, message: { id: 2, channelId: 3, author: { id: 1 }, content: '', createdAt: 't', reactions: [], attachments: [] } };
  const form = new FormData();
  form.append('content', '');
  form.append('files', new Blob([PNG], { type: 'image/png' }), 'pic one.png');
  form.append('files', new Blob(['x'], { type: 'text/html' }), 'drop.html');
  const sent = await fetch(url('/channels/3/messages'), { method: 'POST', body: form });
  assert.equal(sent.status, 201);
  assert.deepEqual(rpcCalls.at(-1).payload.attachments, [{ fileName: 'pic_one.png', mimeType: 'image/png', dataBase64: PNG.toString('base64') }], 'blocked types never leave this instance');
  const onlyBlocked = new FormData();
  onlyBlocked.append('files', new Blob(['x']), 'drop.exe');
  const callsBefore = rpcCalls.length;
  assert.equal((await fetch(url('/channels/3/messages'), { method: 'POST', body: onlyBlocked })).status, 400);
  assert.equal(rpcCalls.length, callsBefore);

  replies.list_threads = { ok: true, threads: [{ id: 7, title: 'T\nx', messageCount: 2, createdBy: 'o', extra: 1 }, { id: 'bad' }] };
  const threads = (await (await fetch(url('/channels/3/threads'))).json()).threads;
  assert.equal(threads.length, 1);
  assert.deepEqual(Object.keys(threads[0]).sort(), ['archived', 'createdAt', 'createdBy', 'id', 'lastMessageAt', 'messageCount', 'title']);
  assert.equal(threads[0].title.includes('\n'), false);
  replies.list_thread_messages = { ok: true, hasMore: true, messages: [{ id: 1, channelId: 3, threadId: 7, author: { id: 1 }, content: 'hi', createdAt: 't', reactions: [] }] };
  const tm = await (await fetch(url('/channels/3/threads/7/messages?before=5'))).json();
  assert.equal(tm.messages[0].threadId, 7);
  assert.equal(tm.hasMore, true);
  assert.equal(rpcCalls.at(-1).payload.threadId, 7);
  assert.equal(rpcCalls.at(-1).payload.before, 5);

  current = other;
  const unowned = rpcCalls.length;
  for (const p of ['/members', '/members/1/avatar', '/channels/3/attachments/9', '/channels/3/threads', '/channels/3/threads/7/messages']) {
    assert.equal((await fetch(url(p))).status, 404, p);
  }
  assert.equal(rpcCalls.length, unowned, 'a user without the ledger row never triggers a peer call');
});
