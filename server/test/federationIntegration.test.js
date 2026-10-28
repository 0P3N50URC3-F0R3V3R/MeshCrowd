'use strict';

// Two full, separate `node server/index.js` processes (two ports, two DISMESH_DATA_DIRs, two
// sqlite databases) talking real HTTPS to each other — the first genuine end-to-end exercise of
// the whole federation feature set built in Tasks 1-18. No mocking of the thing under test: real
// routes, real signatures, real outbox worker, real TLS.
//
// Must be set before ANY child is spawned, not after: `spawn()`'s `env: { ...process.env, ... }`
// snapshots process.env at call time, so setting this only in the parent process *after* calling
// startInstance() (as an earlier draft of this test did) would never reach the children — and the
// children are exactly the processes that need it, since each instance's own outbox worker makes
// a REAL `fetch()` to the other instance's self-signed cert for real delivery. Scoped to this test
// file's own process tree only; must never leak into a real deployment's test run.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  startInstance, killAndWait, rmDirWithRetry, waitForPort, pollUntil, json, cookieFrom, registerAndLogin,
  federationAdminSetup, listPeers, waitForPeer, redeemInvite, acceptPeer,
} = require('./fixtures/federationInstances');

// Two fresh, unpaired instances with federation admin configured on each.
async function startTwoInstances(t, ports) {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-fed-a-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-fed-b-'));
  let a = startInstance(dirA, ports.a);
  let b = startInstance(dirB, ports.b);
  t.after(async () => {
    await Promise.all([killAndWait(a), killAndWait(b)]);
    await Promise.all([rmDirWithRetry(dirA), rmDirWithRetry(dirB)]);
  });

  await waitForPort(ports.a.httpsPort);
  await waitForPort(ports.b.httpsPort);

  const A = `https://127.0.0.1:${ports.a.httpsPort}`;
  const B = `https://127.0.0.1:${ports.b.httpsPort}`;
  const fedCookieA = await federationAdminSetup(A, 'fed-admin-pass-instance-a');
  const fedCookieB = await federationAdminSetup(B, 'fed-admin-pass-instance-b');

  return { dirA, dirB, a: () => a, b: () => b, setB: (child) => { b = child; }, A, B, fedCookieA, fedCookieB };
}

// Shared by the DM tests: two instances, registered users, a fully accepted pairing, and an
// accepted friendship between the two users.
async function setUpPairedInstances(t, ports) {
  const { dirA, dirB, a, b, setB, A, B, fedCookieA, fedCookieB } = await startTwoInstances(t, ports);
  const domainB = `127.0.0.1:${ports.b.httpsPort}`;

  const cookieA = await registerAndLogin(A, { username: 'alice', email: 'alice@a.test', password: 'password123' });
  const cookieB = await registerAndLogin(B, { username: 'bob', email: 'bob@b.test', password: 'password123' });

  const { peerOnInviter } = await redeemInvite(A, fedCookieA, B, fedCookieB);
  await acceptPeer(A, fedCookieA, B, fedCookieB, peerOnInviter.id);

  const friendReq = await fetch(`${A}/api/friends/request`, json('POST', { username: `bob@${domainB}` }, cookieA));
  assert.equal(friendReq.status, 202);

  const pendingOnB = await pollUntil(async () => {
    const list = await (await fetch(`${B}/api/friends`, { headers: { cookie: cookieB } })).json();
    return list.pending[0];
  });
  assert.ok(pendingOnB, 'friend request never arrived on B');

  const acceptRes = await fetch(`${B}/api/friends/${pendingOnB.user.id}/accept`, json('POST', {}, cookieB));
  assert.equal(acceptRes.status, 200);

  const acceptedOnA = await pollUntil(async () => {
    const list = await (await fetch(`${A}/api/friends`, { headers: { cookie: cookieA } })).json();
    return list.friends[0];
  });
  assert.ok(acceptedOnA, 'friend_accept never synced back to A');

  return { dirA, dirB, a, b, setB, A, B, cookieA, cookieB, acceptedOnA };
}

test('two instances handshake, friend, and exchange a DM', { timeout: 90_000 }, async (t) => {
  const ports = { a: { port: 18080, httpsPort: 18443 }, b: { port: 18081, httpsPort: 18444 } };
  const { a, b, A, B, cookieA, cookieB, acceptedOnA } = await setUpPairedInstances(t, ports);
  try {
    const dmRes = await fetch(`${A}/api/dms`, json('POST', { userId: acceptedOnA.user.id }, cookieA));
    assert.equal(dmRes.status, 201);
    const { dmId } = await dmRes.json();
    const msgRes = await fetch(`${A}/api/dms/${dmId}/messages`, json('POST', { content: 'hello from A' }, cookieA));
    assert.equal(msgRes.status, 201);

    const deliveredOnB = await pollUntil(async () => {
      const dms = await (await fetch(`${B}/api/dms`, { headers: { cookie: cookieB } })).json();
      return dms.dms.find((d) => d.lastMessage && d.lastMessage.content === 'hello from A');
    });
    assert.ok(deliveredOnB, 'DM never arrived on B');
  } catch (err) {
    console.error('--- instance A output ---\n', a().dump());
    console.error('--- instance B output ---\n', b().dump());
    throw err;
  }
});

// Kill-mid-delivery (Task 19 brief, Step 4) — downgraded to a behavior-level assertion rather
// than inspecting the outbox row's attempt_count directly. There is no existing route anywhere
// in this codebase that exposes an instance's own outbox table over HTTP (grepped for it —
// nothing), and the two instances here are separate processes with separate databases, so the
// test has no way to observe that counter short of adding a new debug route. More importantly,
// even a debug route wouldn't make the growth observable quickly: federationOutboxWorker.js's
// real backoffMs(1) is 60_000 * 2 = 120_000ms — the first retry after a failure is scheduled a
// full 2 minutes out, by design (not a test artifact). Asserting "attempt_count grows" would
// either have to wait out that real 2-minute window anyway (which the eventual-delivery
// assertion below already does, for real) or fake a faster schedule that production doesn't use.
// So this test asserts the behavior that actually matters to an operator: sending while the peer
// is down doesn't error or crash the sender, and the message is neither lost nor duplicated once
// the peer comes back — verified by waiting out that same real backoff window and then fetching
// the message list twice a few seconds apart.
test('outbox survives a peer outage and redelivers exactly once after restart', { timeout: 220_000 }, async (t) => {
  const ports = { a: { port: 18090, httpsPort: 18453 }, b: { port: 18091, httpsPort: 18454 } };
  const { dirB, a, b, setB, A, B, cookieA, cookieB, acceptedOnA } = await setUpPairedInstances(t, ports);

  b().kill();
  await new Promise((r) => setTimeout(r, 500)); // let the OS actually tear down the listening socket

  const dmRes = await fetch(`${A}/api/dms`, json('POST', { userId: acceptedOnA.user.id }, cookieA));
  assert.equal(dmRes.status, 201, 'opening a DM must succeed locally even though the peer is unreachable');
  const { dmId } = await dmRes.json();
  const msgRes = await fetch(`${A}/api/dms/${dmId}/messages`, json('POST', { content: 'hello during outage' }, cookieA));
  assert.equal(msgRes.status, 201, 'sending must succeed locally — relay to a dead peer is fire-and-forget via the outbox');

  // Let at least one real outbox tick (every 5s) fail against the dead peer, and confirm A is
  // still alive and serving afterward — the thing the brief's Step 4 actually cares about.
  await new Promise((r) => setTimeout(r, 7_000));
  const stillUp = await fetch(`${A}/api/config`);
  assert.equal(stillUp.status, 200, 'instance A must stay healthy through a failed delivery attempt, not crash or hang');

  // Restart B against the SAME data dir: its db, federation keypair, and peer row for A all
  // persist across the restart, exactly like a real second-instance owner restarting their server.
  setB(startInstance(dirB, ports.b));
  await waitForPort(ports.b.httpsPort);

  // The failed attempt above already pushed next_attempt_at out by the real exponential backoff
  // (backoffMs(1) = 120s) — waiting it out for real is what makes this an honest test of the
  // actual retry schedule, not an assumption the production code doesn't make.
  const deliveredDm = await pollUntil(async () => {
    const dms = await (await fetch(`${B}/api/dms`, { headers: { cookie: cookieB } })).json();
    return dms.dms.find((d) => d.lastMessage && d.lastMessage.content === 'hello during outage');
  }, { attempts: 70, intervalMs: 3_000 }); // up to 210s, comfortably past the 120s backoff window
  assert.ok(deliveredDm, 'message sent during the outage never arrived after B restarted');

  const messagesOnce = await (await fetch(`${B}/api/dms/${deliveredDm.id}/messages`, { headers: { cookie: cookieB } })).json();
  const idsOnce = messagesOnce.messages.filter((m) => m.content === 'hello during outage').map((m) => m.id);
  assert.equal(idsOnce.length, 1, 'exactly one copy should exist right after delivery');

  await new Promise((r) => setTimeout(r, 4_000));
  const messagesTwice = await (await fetch(`${B}/api/dms/${deliveredDm.id}/messages`, { headers: { cookie: cookieB } })).json();
  const idsTwice = messagesTwice.messages.filter((m) => m.content === 'hello during outage').map((m) => m.id);
  assert.deepEqual(idsTwice, idsOnce, 'redelivery after restart must not duplicate the message');
});

test('pairing lifecycle: redeem, accept, revoke — both sides move together', { timeout: 60_000 }, async (t) => {
  const ports = { a: { port: 18100, httpsPort: 18463 }, b: { port: 18101, httpsPort: 18464 } };
  const { a, b, A, B, fedCookieA, fedCookieB } = await startTwoInstances(t, ports);
  try {
    const { peerOnInviter, peerOnJoiner } = await redeemInvite(A, fedCookieA, B, fedCookieB);
    assert.equal(peerOnInviter.domain, `127.0.0.1:${ports.b.httpsPort}`);
    assert.equal(peerOnJoiner.domain, `127.0.0.1:${ports.a.httpsPort}`);

    const acceptOnJoiner = await fetch(`${B}/federation/admin/peers/${peerOnJoiner.id}/accept`, json('POST', {}, fedCookieB));
    assert.equal(acceptOnJoiner.status, 409, 'the joiner cannot accept its own outgoing request');

    await acceptPeer(A, fedCookieA, B, fedCookieB, peerOnInviter.id);
    assert.equal((await listPeers(A, fedCookieA))[0].status, 'active');

    // The joiner revokes: the inviter must drop to revoked too, not keep believing it is paired.
    const revokeRes = await fetch(`${B}/federation/admin/peers/${peerOnJoiner.id}`, json('DELETE', undefined, fedCookieB));
    assert.equal(revokeRes.status, 200);
    const revokedOnA = await waitForPeer(A, fedCookieA, (p) => p.status === 'revoked');
    assert.ok(revokedOnA, 'peer_revoke never reached the inviter');
    assert.equal((await listPeers(B, fedCookieB))[0].status, 'revoked');
  } catch (err) {
    console.error('--- instance A output ---\n', a().dump());
    console.error('--- instance B output ---\n', b().dump());
    throw err;
  }
});

test('pairing reject: inviter rejects, joiner drops to revoked', { timeout: 60_000 }, async (t) => {
  const ports = { a: { port: 18110, httpsPort: 18473 }, b: { port: 18111, httpsPort: 18474 } };
  const { a, b, A, B, fedCookieA, fedCookieB } = await startTwoInstances(t, ports);
  try {
    const { peerOnInviter } = await redeemInvite(A, fedCookieA, B, fedCookieB);
    const rejectRes = await fetch(`${A}/federation/admin/peers/${peerOnInviter.id}/reject`, json('POST', {}, fedCookieA));
    assert.equal(rejectRes.status, 200);
    assert.equal((await listPeers(A, fedCookieA))[0].status, 'revoked');
    const revokedOnB = await waitForPeer(B, fedCookieB, (p) => p.status === 'revoked');
    assert.ok(revokedOnB, 'peer_reject never reached the joiner');
  } catch (err) {
    console.error('--- instance A output ---\n', a().dump());
    console.error('--- instance B output ---\n', b().dump());
    throw err;
  }
});

// Same real-backoff caveat as the DM outage test above: the first failed delivery pushes the retry
// 120s out, so this waits out the real schedule. Only the accept is queued: a second queued event
// would be picked up on the next 5s tick (the worker skips a head-of-line row that is still in
// backoff) and mask whether the accept itself survived the outage.
test('an accept queued while the peer is offline is delivered after it restarts', { timeout: 220_000 }, async (t) => {
  const ports = { a: { port: 18120, httpsPort: 18483 }, b: { port: 18121, httpsPort: 18484 } };
  const { dirB, b, setB, A, B, fedCookieA, fedCookieB } = await startTwoInstances(t, ports);
  const { peerOnInviter } = await redeemInvite(A, fedCookieA, B, fedCookieB);

  b().kill();
  await new Promise((r) => setTimeout(r, 500));

  const acceptRes = await fetch(`${A}/federation/admin/peers/${peerOnInviter.id}/accept`, json('POST', {}, fedCookieA));
  assert.equal(acceptRes.status, 200, 'accepting must succeed locally even though the peer is unreachable');

  await new Promise((r) => setTimeout(r, 7_000));
  assert.equal((await fetch(`${A}/api/config`)).status, 200, 'instance A must stay healthy through failed control deliveries');

  setB(startInstance(dirB, ports.b));
  await waitForPort(ports.b.httpsPort);

  const activeOnB = await pollUntil(async () => (await listPeers(B, fedCookieB))[0]?.status === 'active', { attempts: 70, intervalMs: 3_000 });
  assert.ok(activeOnB, 'queued peer_accept never arrived after B restarted');
});

function openWs(base, cookie) {
  const { WebSocket } = require('ws');
  const events = [];
  const socket = new WebSocket(`${base.replace('https', 'wss')}/ws`, { headers: { cookie } });
  socket.on('message', (data) => { try { events.push(JSON.parse(data)); } catch { /* ignore */ } });
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve({ events, socket }));
    socket.once('error', reject);
  });
}

// Remote servers (live proxy, no replication): B's user joins a server owned by A with a
// cross-instance invite and then reads/posts through B's own /api/remote routes while A stays the
// only holder of the content.
test('remote server: join, read, post both ways, live push, own-message rules, private channel, leave, outage, revoke', { timeout: 240_000 }, async (t) => {
  const ports = { a: { port: 18130, httpsPort: 18493 }, b: { port: 18131, httpsPort: 18494 } };
  const { a, b, A, B, fedCookieA, fedCookieB } = await startTwoInstances(t, ports);
  const domainA = `127.0.0.1:${ports.a.httpsPort}`;
  try {
    const cookieAlice = await registerAndLogin(A, { username: 'alice', email: 'alice@a.test', password: 'password123' });
    const cookieCarol = await registerAndLogin(A, { username: 'carol', email: 'carol@a.test', password: 'password123' });
    const cookieBob = await registerAndLogin(B, { username: 'bob', email: 'bob@b.test', password: 'password123' });
    const cookieEve = await registerAndLogin(B, { username: 'eve', email: 'eve@b.test', password: 'password123' });

    const { peerOnInviter } = await redeemInvite(A, fedCookieA, B, fedCookieB);
    await acceptPeer(A, fedCookieA, B, fedCookieB, peerOnInviter.id);

    const created = await (await fetch(`${A}/api/servers`, json('POST', { name: 'Hub', visibility: 'public' }, cookieAlice))).json();
    const serverId = created.server.id;
    const inviteCode = created.server.invite_code;
    const detail = await (await fetch(`${A}/api/servers/${serverId}`, { headers: { cookie: cookieAlice } })).json();
    const generalId = detail.channels.find((c) => c.name === 'general').id;
    const privateRes = await fetch(`${A}/api/servers/${serverId}/channels`, json('POST', { name: 'staff', type: 'private' }, cookieAlice));
    const privateId = (await privateRes.json()).channel.id;
    assert.equal((await fetch(`${A}/api/servers/join`, json('POST', { inviteCode }, cookieCarol))).status, 200);

    const aMsgs = (channelId, cookie = cookieAlice) => fetch(`${A}/api/servers/${serverId}/channels/${channelId}/messages`, { headers: { cookie } }).then((r) => r.json());
    const aPost = (channelId, content, cookie = cookieAlice) => fetch(`${A}/api/servers/${serverId}/channels/${channelId}/messages`, json('POST', { content }, cookie)).then((r) => r.json());

    // --- join: ledger row on B, nothing mirrored ---
    const joinRes = await fetch(`${B}/api/servers/join`, json('POST', { inviteCode: `${inviteCode}@${domainA}` }, cookieBob));
    assert.equal(joinRes.status, 200);
    const joined = await joinRes.json();
    assert.equal(joined.federated, true);
    assert.ok(Number.isInteger(joined.peerId));
    assert.equal(joined.server.id, serverId);
    const peerId = joined.peerId;
    const rb = (method, url, body, cookie = cookieBob) => fetch(`${B}/api/remote${url}`, json(method, body, cookie));
    const base = `/${peerId}/${serverId}`;

    const listed = await (await rb('GET', '/servers')).json();
    assert.equal(listed.servers.length, 1);
    assert.equal(listed.servers[0].name, 'Hub');
    assert.equal(listed.servers[0].domain, domainA);
    assert.equal((await (await fetch(`${B}/api/servers`, { headers: { cookie: cookieBob } })).json()).servers.length, 0, 'B stores no local servers row');
    assert.deepEqual((await (await rb('GET', '/servers', undefined, cookieEve)).json()).servers, [], 'another B user has no memberships');

    // --- info: the private channel is neither listed nor readable ---
    const info = await (await rb('GET', base)).json();
    assert.deepEqual(info.channels.map((c) => c.name), ['general']);
    assert.ok(Number.isInteger(info.selfUserId));
    assert.equal((await rb('GET', `${base}/channels/${privateId}/messages`)).status, 404);
    assert.equal((await rb('POST', `${base}/channels/${privateId}/messages`, { content: 'sneak' })).status, 404);

    // --- live push to bob only (eve has no membership) ---
    const bobWs = await openWs(B, cookieBob);
    const eveWs = await openWs(B, cookieEve);
    t.after(() => { bobWs.socket.close(); eveWs.socket.close(); });
    const seen = (ws, pred) => pollUntil(() => ws.events.find(pred));

    const first = (await aPost(generalId, 'hello from alice')).message;
    const pushedCreate = await seen(bobWs, (e) => e.type === 'remote_channel_event' && e.kind === 'message_create' && e.message.id === first.id);
    assert.ok(pushedCreate, 'A -> B live push never arrived');
    assert.equal(pushedCreate.peerId, peerId);
    assert.equal(pushedCreate.serverId, serverId);
    assert.equal(pushedCreate.message.content, 'hello from alice');
    assert.equal(pushedCreate.message.author.username, 'alice');
    assert.equal(pushedCreate.message.author.domain, domainA);

    // --- history through the proxy, then bob posts and A sees it ---
    const history = await (await rb('GET', `${base}/channels/${generalId}/messages`)).json();
    assert.deepEqual(history.messages.map((m) => m.content), ['hello from alice']);
    const posted = await rb('POST', `${base}/channels/${generalId}/messages`, { content: 'hello from bob' });
    assert.equal(posted.status, 201);
    const bobMsg = (await posted.json()).message;
    assert.equal(bobMsg.author.username, 'bob');
    assert.equal(bobMsg.author.id, info.selfUserId);
    const onA = (await aMsgs(generalId)).messages.find((m) => m.id === bobMsg.id);
    assert.equal(onA.content, 'hello from bob');
    assert.equal(onA.author.displayName, 'bob');
    assert.ok(await seen(bobWs, (e) => e.kind === 'message_create' && e.message.id === bobMsg.id), 'the author\'s own instance also hears its post (client dedups by id)');

    // carol (a local A member) is seen by B live as well
    const carolMsg = (await aPost(generalId, 'carol here', cookieCarol)).message;
    assert.ok(await seen(bobWs, (e) => e.kind === 'message_create' && e.message.id === carolMsg.id));

    // --- own-message rules ---
    assert.equal((await rb('PATCH', `${base}/channels/${generalId}/messages/${first.id}`, { content: 'hijack' })).status, 403);
    assert.equal((await rb('DELETE', `${base}/channels/${generalId}/messages/${first.id}`)).status, 403);
    assert.equal((await rb('PATCH', `${base}/channels/${generalId}/messages/${bobMsg.id}`, { content: '  ' })).status, 400);
    const edited = await rb('PATCH', `${base}/channels/${generalId}/messages/${bobMsg.id}`, { content: 'bob edited' });
    assert.equal(edited.status, 200);
    assert.equal((await edited.json()).message.content, 'bob edited');
    assert.equal((await aMsgs(generalId)).messages.find((m) => m.id === bobMsg.id).content, 'bob edited');

    // --- reactions, both from bob on alice's message and visible live ---
    const reacted = await (await rb('PUT', `${base}/channels/${generalId}/messages/${first.id}/reactions/${encodeURIComponent('\u{1F44D}')}`)).json();
    assert.deepEqual(reacted.message.reactions, [{ emoji: '\u{1F44D}', userIds: [info.selfUserId] }]);
    assert.ok(await seen(bobWs, (e) => e.kind === 'reaction_update' && e.message.id === first.id));
    const unreacted = await (await rb('DELETE', `${base}/channels/${generalId}/messages/${first.id}/reactions/${encodeURIComponent('\u{1F44D}')}`)).json();
    assert.deepEqual(unreacted.message.reactions, []);

    // --- alice edits and deletes on A: B hears both ---
    const aliceEdit = await fetch(`${A}/api/messages/${first.id}`, json('PATCH', { content: 'alice edited' }, cookieAlice));
    assert.equal(aliceEdit.status, 200);
    assert.ok(await seen(bobWs, (e) => e.kind === 'message_update' && e.message.id === first.id && e.message.content === 'alice edited'));
    assert.equal((await fetch(`${A}/api/messages/${carolMsg.id}`, json('DELETE', undefined, cookieAlice))).status, 200);
    assert.ok(await seen(bobWs, (e) => e.kind === 'message_delete' && e.messageId === carolMsg.id));

    assert.equal((await rb('DELETE', `${base}/channels/${generalId}/messages/${bobMsg.id}`)).status, 200);
    assert.equal((await aMsgs(generalId)).messages.some((m) => m.id === bobMsg.id), false);

    // --- the private channel's traffic never reaches B; ordering of the single outbox lane proves it ---
    await aPost(privateId, 'staff only');
    const marker = (await aPost(generalId, 'marker after private')).message;
    assert.ok(await seen(bobWs, (e) => e.kind === 'message_create' && e.message.id === marker.id));
    assert.equal(bobWs.events.some((e) => e.type === 'remote_channel_event' && e.channelId === privateId), false);
    assert.equal(eveWs.events.some((e) => e.type === 'remote_channel_event'), false, 'a B user who never joined hears nothing');

    // --- leave removes A's member row and B's ledger row ---
    const leave = await rb('DELETE', base);
    assert.equal(leave.status, 200);
    assert.deepEqual((await (await rb('GET', '/servers')).json()).servers, []);
    const members = (await (await fetch(`${A}/api/servers/${serverId}`, { headers: { cookie: cookieAlice } })).json()).members;
    assert.equal(members.some((m) => m.user.displayName === 'bob'), false, 'A dropped bob\'s member row');
    assert.equal((await rb('GET', `${base}/channels/${generalId}/messages`)).status, 404);

    // --- rejoin, then the owner goes away: unreachable, membership kept ---
    assert.equal((await fetch(`${B}/api/servers/join`, json('POST', { inviteCode: `${inviteCode}@${domainA}` }, cookieBob))).status, 200);
    await killAndWait(a());
    const down = await rb('GET', `${base}/channels/${generalId}/messages`);
    assert.equal(down.status, 502);
    assert.equal((await down.json()).error, 'unreachable');
    assert.equal((await (await rb('GET', '/servers')).json()).servers.length, 1);

    // --- revoking the peer drops the ledger and makes the routes 404 ---
    assert.ok((await listPeers(B, fedCookieB)).find((p) => p.id === peerId));
    assert.equal((await fetch(`${B}/federation/admin/peers/${peerId}`, json('DELETE', undefined, fedCookieB))).status, 200);
    assert.deepEqual((await (await rb('GET', '/servers')).json()).servers, []);
    assert.equal((await rb('GET', base)).status, 404);
  } catch (err) {
    console.error('--- instance A output ---\n', a().dump());
    console.error('--- instance B output ---\n', b().dump());
    throw err;
  }
});
