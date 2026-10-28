'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const { TurnServer } = require('../lib/turn/server');
const { TurnClient } = require('../lib/turn/client');
const credentials = require('../lib/turn/credentials');
const stun = require('../lib/turn/stun');

const SECRET = 'test-secret-test-secret-test-secret';

async function startServer(extra = {}) {
  const s = new TurnServer({ secret: SECRET, listenAddress: '127.0.0.1', port: 0, relayPortMin: 53000, relayPortMax: 53200, allowPrivatePeers: true, ...extra });
  await s.start();
  return s;
}
const client = (s, label = 'u1', ttl = 600) => {
  const c = credentials.issue(SECRET, label, ttl);
  return new TurnClient({ host: '127.0.0.1', port: s.port, username: c.username, credential: c.credential });
};
const once = (c) => new Promise((resolve) => c.once('data', resolve));

test('stun codec round-trips attributes, integrity and fingerprint', () => {
  const key = Buffer.from('k'.repeat(16));
  const tid = stun.newTid();
  const buf = stun.build(stun.typeOf(stun.METHOD.BINDING, stun.CLASS.SUCCESS), tid, [
    { type: stun.ATTR.XOR_MAPPED_ADDRESS, value: stun.encodeXorAddress('203.0.113.7', 40000) },
  ], { key });
  const msg = stun.parse(buf);
  assert.equal(msg.method, stun.METHOD.BINDING);
  assert.equal(msg.cls, stun.CLASS.SUCCESS);
  assert.deepEqual(stun.decodeXorAddress(msg.attrs.get(stun.ATTR.XOR_MAPPED_ADDRESS)), { family: 4, ip: '203.0.113.7', port: 40000 });
  assert.ok(stun.checkIntegrity(msg, key));
  assert.ok(!stun.checkIntegrity(msg, Buffer.from('x'.repeat(16))));
  assert.equal(stun.parse(buf.subarray(0, buf.length - 1)), null);
});

test('credentials expire and bind to the secret', () => {
  const c = credentials.issue(SECRET, 'alice', 60, Date.now());
  assert.equal(credentials.labelOf(c.username), 'alice');
  assert.equal(credentials.passwordFor(SECRET, c.username), c.credential);
  assert.equal(credentials.labelOf(c.username, Date.now() + 3600_000), null);
  assert.notEqual(credentials.passwordFor('another', c.username), c.credential);
});

test('binding request returns the sender address without credentials', async () => {
  const s = await startServer();
  const c = new TurnClient({ host: '127.0.0.1', port: s.port });
  const me = await c.binding();
  assert.equal(me.ip, '127.0.0.1');
  assert.equal(me.port, c.sock.address().port);
  c.close(); await s.stop();
});

test('allocate needs valid, unexpired credentials', async () => {
  const s = await startServer();
  const good = client(s);
  const a = await good.allocate();
  assert.ok(a.ok);
  assert.equal(a.relayed.ip, '127.0.0.1');
  assert.ok(a.relayed.port >= 53000 && a.relayed.port <= 53200);
  assert.equal(a.lifetime, 600);
  assert.equal(s.status().allocations, 1);

  const wrong = new TurnClient({ host: '127.0.0.1', port: s.port, username: credentials.issue(SECRET, 'x', 600).username, credential: 'nope' });
  assert.deepEqual(await wrong.allocate(), { ok: false, code: 401 });

  const expired = credentials.issue(SECRET, 'old', 600, Date.now() - 7200_000);
  const exp = new TurnClient({ host: '127.0.0.1', port: s.port, username: expired.username, credential: expired.credential });
  assert.equal((await exp.allocate()).code, 401);

  const other = credentials.issue('different-secret', 'evil', 600);
  const forged = new TurnClient({ host: '127.0.0.1', port: s.port, username: other.username, credential: other.credential });
  assert.equal((await forged.allocate()).code, 401);
  for (const c of [good, wrong, exp, forged]) c.close();
  await s.stop();
});

test('two allocations exchange data through the relay (Send/Data and ChannelData)', async () => {
  const s = await startServer();
  const a = client(s, 'a'); const b = client(s, 'b');
  const ra = (await a.allocate()).relayed; const rb = (await b.allocate()).relayed;
  assert.ok((await a.createPermission('127.0.0.1')).ok);
  assert.ok((await b.createPermission('127.0.0.1')).ok);

  const gotB = once(b);
  a.sendTo(rb.ip, rb.port, Buffer.from('hello via send'));
  const m1 = await gotB;
  assert.equal(m1.data.toString(), 'hello via send');
  assert.equal(m1.peer.port, ra.port);

  assert.ok((await a.channelBind(0x4001, rb.ip, rb.port)).ok);
  assert.ok((await b.channelBind(0x4002, ra.ip, ra.port)).ok);
  const gotB2 = once(b);
  a.sendChannel(0x4001, Buffer.from('hello via channel'));
  const m2 = await gotB2;
  assert.equal(m2.channel, 0x4002);
  assert.equal(m2.data.toString(), 'hello via channel');
  assert.ok(s.status().bytesRelayed > 0);
  a.close(); b.close(); await s.stop();
});

test('traffic from a peer without a permission is dropped', async () => {
  const s = await startServer();
  const a = client(s, 'a');
  const ra = (await a.allocate()).relayed;
  let received = false;
  a.on('data', () => { received = true; });
  const stranger = dgram.createSocket('udp4');
  stranger.send(Buffer.from('knock'), ra.port, '127.0.0.1');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(received, false);
  stranger.close(); a.close(); await s.stop();
});

test('private peers are refused unless the operator allows them', async () => {
  const s = await startServer({ allowPrivatePeers: false });
  const a = client(s, 'a');
  await a.allocate();
  assert.equal((await a.createPermission('192.168.1.10')).code, 403);
  assert.equal((await a.createPermission('127.0.0.1')).code, 403);
  assert.equal((await a.createPermission('224.0.0.1')).code, 403);
  assert.ok((await a.createPermission('8.8.8.8')).ok);
  assert.equal((await a.channelBind(0x4000, '10.0.0.5', 9)).code, 403);
  a.close(); await s.stop();
});

test('per-user and global allocation limits', async () => {
  const s = await startServer({ maxAllocationsPerUser: 2, maxAllocations: 3 });
  const mk = (label) => client(s, label);
  const clients = [mk('same'), mk('same'), mk('same')];
  assert.ok((await clients[0].allocate()).ok);
  assert.ok((await clients[1].allocate()).ok);
  assert.equal((await clients[2].allocate()).code, 486);
  const other = mk('other');
  assert.ok((await other.allocate()).ok);
  const more = mk('more');
  assert.equal((await more.allocate()).code, 486);
  for (const c of [...clients, other, more]) c.close();
  await s.stop();
});

test('refresh with zero lifetime releases the allocation', async () => {
  const s = await startServer();
  const a = client(s);
  await a.allocate();
  assert.equal(s.status().allocations, 1);
  assert.ok((await a.refresh(0)).ok);
  assert.equal(s.status().allocations, 0);
  assert.equal((await a.refresh(60)).code, 437);
  a.close(); await s.stop();
});

test('a second allocation from the same address is a mismatch', async () => {
  const s = await startServer();
  const a = client(s);
  assert.ok((await a.allocate()).ok);
  assert.equal((await a.allocate()).code, 437);
  a.close(); await s.stop();
});

test('relay bandwidth cap drops excess traffic', async () => {
  const s = await startServer({ maxKbps: 8 });
  const a = client(s, 'a'); const b = client(s, 'b');
  await a.allocate(); const rb = (await b.allocate()).relayed;
  await a.createPermission('127.0.0.1'); await b.createPermission('127.0.0.1');
  let count = 0;
  b.on('data', () => { count += 1; });
  for (let i = 0; i < 50; i++) a.sendTo(rb.ip, rb.port, Buffer.alloc(500));
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(count > 0 && count < 50, `delivered ${count}`);
  a.close(); b.close(); await s.stop();
});
