'use strict';

// Three real instances (A, B, C) with real pairings, to pin down how federation behaves beyond two
// peers: each instance keeps several active peers at once, traffic is routed to the right peer, and
// revoking one pairing leaves the others alone. It also documents what is NOT there yet: pairing
// is pairwise and not transitive, so A and C stay strangers until their admins pair them directly.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  startInstance, killAndWait, rmDirWithRetry, waitForPort, pollUntil, json, registerAndLogin,
  federationAdminSetup, listPeers, redeemInvite, acceptPeer,
} = require('./fixtures/federationInstances');

const PORTS = {
  a: { port: 18200, httpsPort: 18503 },
  b: { port: 18201, httpsPort: 18504 },
  c: { port: 18202, httpsPort: 18505 },
};
const domainOf = (n) => `127.0.0.1:${PORTS[n].httpsPort}`;

async function startThree(t) {
  const names = ['a', 'b', 'c'];
  const dirs = {}; const children = {};
  for (const n of names) {
    dirs[n] = fs.mkdtempSync(path.join(os.tmpdir(), `dismesh-fed3-${n}-`));
    children[n] = startInstance(dirs[n], PORTS[n]);
  }
  t.after(async () => {
    await Promise.all(names.map((n) => killAndWait(children[n])));
    await Promise.all(names.map((n) => rmDirWithRetry(dirs[n])));
  });
  const nodes = {};
  for (const n of names) {
    await waitForPort(PORTS[n].httpsPort);
    const base = `https://127.0.0.1:${PORTS[n].httpsPort}`;
    nodes[n] = {
      base,
      fed: await federationAdminSetup(base, `fed-admin-pass-${n}-instance`),
      user: { a: 'alice', b: 'bob', c: 'carol' }[n],
    };
    nodes[n].cookie = await registerAndLogin(base, { username: nodes[n].user, email: `${nodes[n].user}@${n}.test`, password: 'password123' });
  }
  return { nodes, dump: () => names.map((n) => `--- instance ${n} ---\n${children[n].dump()}`).join('\n') };
}

// inviter mints, joiner redeems, inviter accepts: one fully active pairing.
async function pair(inviter, joiner, inviterDomain) {
  const { peerOnInviter } = await redeemInvite(inviter.base, inviter.fed, joiner.base, joiner.fed);
  await acceptPeer(inviter.base, inviter.fed, joiner.base, joiner.fed, peerOnInviter.id, inviterDomain);
}

const friendsOf = async (node) => (await (await fetch(`${node.base}/api/friends`, { headers: { cookie: node.cookie } })).json());

// Remote users are stored under a placeholder username, so the new friend is identified as "the
// friend that was not there before".
async function befriend(from, to, toDomain) {
  const before = new Set((await friendsOf(from)).friends.map((f) => f.user.id));
  const res = await fetch(`${from.base}/api/friends/request`, json('POST', { username: `${to.user}@${toDomain}` }, from.cookie));
  assert.equal(res.status, 202, `${from.user} -> ${to.user}: ${await res.text()}`);
  const pending = await pollUntil(async () => (await friendsOf(to)).pending[0]);
  assert.ok(pending, `friend request never reached ${to.user}`);
  assert.equal((await fetch(`${to.base}/api/friends/${pending.user.id}/accept`, json('POST', {}, to.cookie))).status, 200);
  const friend = await pollUntil(async () => (await friendsOf(from)).friends.find((f) => !before.has(f.user.id)));
  assert.ok(friend, `${to.user}'s accept never synced back to ${from.user}`);
  return friend;
}

async function sendDm(from, friend, content) {
  const dm = await fetch(`${from.base}/api/dms`, json('POST', { userId: friend.user.id }, from.cookie));
  assert.ok([200, 201].includes(dm.status), `create DM: ${dm.status}`); // 200 when the DM already exists
  const { dmId } = await dm.json();
  const msg = await fetch(`${from.base}/api/dms/${dmId}/messages`, json('POST', { content }, from.cookie));
  assert.equal(msg.status, 201, await msg.text());
}

const hasDm = async (node, content) => {
  const list = await (await fetch(`${node.base}/api/dms`, { headers: { cookie: node.cookie } })).json();
  return list.dms.some((d) => d.lastMessage && d.lastMessage.content === content);
};
const waitForDm = (node, content) => pollUntil(() => hasDm(node, content), { attempts: 60 });

test('three instances: several active peers, correct routing, independent revokes, no transitive trust', { timeout: 280_000 }, async (t) => {
  const { nodes, dump } = await startThree(t);
  const { a, b, c } = nodes;
  try {
    // A-B and B-C are paired. A and C have never been paired with each other.
    await pair(a, b, domainOf('a'));
    await pair(b, c, domainOf('b'));
    assert.deepEqual((await listPeers(a.base, a.fed)).map((p) => p.domain), [domainOf('b')]);
    assert.deepEqual((await listPeers(c.base, c.fed)).map((p) => p.domain), [domainOf('b')]);
    assert.equal((await listPeers(b.base, b.fed)).filter((p) => p.status === 'active').length, 2, 'B holds two active peers at once');

    // Not transitive: B knowing both does not let A reach C.
    const stranger = await fetch(`${a.base}/api/friends/request`, json('POST', { username: `carol@${domainOf('c')}` }, a.cookie));
    assert.equal(stranger.status, 404, 'A cannot friend carol through B');

    // Pair A-C directly (C invites, A redeems): now every instance has two active peers.
    await pair(c, a, domainOf('c'));
    for (const n of [a, b, c]) {
      assert.equal((await listPeers(n.base, n.fed)).filter((p) => p.status === 'active').length, 2);
    }

    // Friendships over all three links, then DMs that must land only at their addressee.
    const aliceBob = await befriend(a, b, domainOf('b'));
    const aliceCarol = await befriend(a, c, domainOf('c'));
    const bobCarol = await befriend(b, c, domainOf('c'));

    await sendDm(a, aliceBob, 'alice to bob');
    await sendDm(a, aliceCarol, 'alice to carol');
    await sendDm(b, bobCarol, 'bob to carol');
    assert.ok(await waitForDm(b, 'alice to bob'), 'A->B never arrived');
    assert.ok(await waitForDm(c, 'alice to carol'), 'A->C never arrived');
    assert.ok(await waitForDm(c, 'bob to carol'), 'B->C never arrived');
    assert.equal(await hasDm(b, 'alice to carol'), false, 'a DM for carol must not leak to bob');
    assert.equal(await hasDm(c, 'alice to bob'), false, 'a DM for bob must not leak to carol');

    // Revoke only A-C (from A). C must follow; A-B and B-C keep working.
    const peerCOnA = (await listPeers(a.base, a.fed)).find((p) => p.domain === domainOf('c'));
    assert.equal((await fetch(`${a.base}/federation/admin/peers/${peerCOnA.id}`, json('DELETE', undefined, a.fed))).status, 200);
    const revokedOnC = await pollUntil(async () => (await listPeers(c.base, c.fed)).find((p) => p.domain === domainOf('a') && p.status === 'revoked'));
    assert.ok(revokedOnC, 'peer_revoke never reached C');
    assert.equal((await listPeers(c.base, c.fed)).find((p) => p.domain === domainOf('b')).status, 'active', 'C-B untouched');
    assert.equal((await listPeers(b.base, b.fed)).filter((p) => p.status === 'active').length, 2, 'B still has both peers');

    await sendDm(a, aliceBob, 'alice to bob after revoke');
    await sendDm(b, bobCarol, 'bob to carol after revoke');
    assert.ok(await waitForDm(b, 'alice to bob after revoke'), 'A-B broke when A-C was revoked');
    assert.ok(await waitForDm(c, 'bob to carol after revoke'), 'B-C broke when A-C was revoked');

    // A can no longer reach C: the DM is not delivered.
    await fetch(`${a.base}/api/dms/${(await (await fetch(`${a.base}/api/dms`, json('POST', { userId: aliceCarol.user.id }, a.cookie))).json()).dmId}/messages`, json('POST', { content: 'alice to carol after revoke' }, a.cookie)).catch(() => {});
    await new Promise((r) => setTimeout(r, 6_000));
    assert.equal(await hasDm(c, 'alice to carol after revoke'), false, 'a revoked pairing must not deliver');
  } catch (err) {
    console.error(dump());
    throw err;
  }
});
