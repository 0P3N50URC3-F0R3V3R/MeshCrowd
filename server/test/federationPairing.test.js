'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const http = require('node:http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;
const { db } = require('../db');
const { router: adminRouter } = require('../routes/federationAdmin');
const federationApiRouter = require('../routes/federationApi');
const { setFederationAdminPassword, createFederationAdminSession } = require('../lib/federationAdminAuth');
const { canonicalize } = require('../lib/federationCrypto');
const { enqueueEvent } = require('../lib/federationOutbox');
const { drainOnce } = require('../lib/federationOutboxWorker');

test.after(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

setFederationAdminPassword('super-secret-federation-pass');
const { token: adminToken } = createFederationAdminSession();
const adminHeaders = { cookie: `dismesh_federation_admin=${adminToken}`, 'content-type': 'application/json' };

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/federation/admin', adminRouter);
  app.use('/federation/api', federationApiRouter);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}

function makePeer(domain, { status, direction }) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const id = db.prepare(`INSERT INTO federation_peers (domain, public_url, their_pubkey, status, direction) VALUES (?, 'https://93.184.216.34/', ?, ?, ?)`)
    .run(domain, publicKey.export({ type: 'spki', format: 'pem' }), status, direction).lastInsertRowid;
  const send = (base, type, payload = {}) => {
    const event = { event_id: crypto.randomUUID(), type, origin_domain: domain, created_at: new Date().toISOString(), payload };
    const signature = crypto.sign(null, Buffer.from(canonicalize(event)), privateKey).toString('base64');
    return fetch(`${base}/federation/api/inbox`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...event, signature }) });
  };
  return { id, send };
}

const statusOf = (id) => db.prepare('SELECT status FROM federation_peers WHERE id = ?').get(id).status;

test('a pending peer is authenticated but may only send pairing-control events', async () => {
  const peer = makePeer('pend1.example', { status: 'pending', direction: 'inbound' });
  await withServer(async (base) => {
    const blocked = await peer.send(base, 'user_update', { remoteId: 1, username: 'mallory', displayName: 'M' });
    assert.equal(blocked.status, 403);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM users WHERE federated_uid = 'mallory@pend1.example'`).get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM federation_inbox_seen WHERE peer_id = ?').get(peer.id).n, 0);

    const allowed = await peer.send(base, 'peer_revoke');
    assert.equal(allowed.status, 200);
  });
});

test('a pending inbound peer cannot activate itself with peer_accept', async () => {
  const peer = makePeer('pend2.example', { status: 'pending', direction: 'inbound' });
  await withServer(async (base) => {
    assert.equal((await peer.send(base, 'peer_accept')).status, 200);
    assert.equal(statusOf(peer.id), 'pending');
    assert.equal((await peer.send(base, 'peer_reject')).status, 200);
    assert.equal(statusOf(peer.id), 'pending');
  });
});

test('peer_accept / peer_reject / peer_revoke update a row we originated or hold', async () => {
  const acc = makePeer('out1.example', { status: 'pending', direction: 'outbound' });
  const rej = makePeer('out2.example', { status: 'pending', direction: 'outbound' });
  const rev = makePeer('act1.example', { status: 'active', direction: 'inbound' });
  await withServer(async (base) => {
    await acc.send(base, 'peer_accept');
    await rej.send(base, 'peer_reject');
    await rev.send(base, 'peer_revoke');
    assert.equal(statusOf(acc.id), 'active');
    assert.equal(statusOf(rej.id), 'revoked');
    assert.equal(statusOf(rev.id), 'revoked');
  });
});

test('a revoked peer can no longer authenticate', async () => {
  const peer = makePeer('gone.example', { status: 'revoked', direction: 'inbound' });
  await withServer(async (base) => {
    assert.equal((await peer.send(base, 'peer_accept')).status, 401);
  });
});

test('admin accept activates an incoming request and queues peer_accept; reject revokes and queues peer_reject', async () => {
  const a = makePeer('in1.example', { status: 'pending', direction: 'inbound' });
  const r = makePeer('in2.example', { status: 'pending', direction: 'inbound' });
  const out = makePeer('out3.example', { status: 'pending', direction: 'outbound' });
  await withServer(async (base) => {
    const post = (p) => fetch(`${base}/federation/admin/peers/${p}`, { method: 'POST', headers: adminHeaders, body: '{}' });
    assert.equal((await post(`${a.id}/accept`)).status, 200);
    assert.equal((await post(`${r.id}/reject`)).status, 200);
    assert.equal(statusOf(a.id), 'active');
    assert.equal(statusOf(r.id), 'revoked');
    const queued = (id) => db.prepare('SELECT type FROM federation_outbox WHERE peer_id = ?').all(id).map((x) => x.type);
    assert.deepEqual(queued(a.id), ['peer_accept']);
    assert.deepEqual(queued(r.id), ['peer_reject']);

    assert.equal((await post(`${a.id}/accept`)).status, 409);
    assert.equal((await post(`${out.id}/accept`)).status, 409);
    assert.equal((await post('99999/accept')).status, 404);
    assert.equal(statusOf(out.id), 'pending');
  });
});

test('revoking an active peer queues peer_revoke, and the worker delivers it despite the peer being revoked', async () => {
  const peer = makePeer('act2.example', { status: 'active', direction: 'inbound' });
  enqueueEvent(peer.id, 'ping', { n: 1 });
  await withServer(async (base) => {
    const res = await fetch(`${base}/federation/admin/peers/${peer.id}`, { method: 'DELETE', headers: adminHeaders });
    assert.equal(res.status, 200);
  });
  assert.equal(statusOf(peer.id), 'revoked');

  const delivered = [];
  await drainOnce(async (url, opts) => {
    if (url.startsWith('https://93.184.216.34')) delivered.push(JSON.parse(opts.body).type);
    return { ok: true, status: 200 };
  });
  assert.ok(delivered.includes('peer_revoke'));
  assert.ok(!delivered.includes('ping'), 'ordinary events must never go to a revoked peer');
});

test('redeem-invite validates its input', async () => {
  await withServer(async (base) => {
    const post = (body) => fetch(`${base}/federation/admin/redeem-invite`, { method: 'POST', headers: adminHeaders, body: JSON.stringify(body) });
    assert.equal((await post({})).status, 400);
    assert.equal((await post({ invite: 'abc123' })).status, 400);
    assert.equal((await fetch(`${base}/federation/admin/redeem-invite`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
  });
});

test('peer status changes push federation_peer_update to online site admins only', async () => {
  const { registerConnection, unregisterConnection } = require('../lib/presence');
  const { SITE_PERMISSIONS } = require('../lib/permissions');
  const mkUser = (name) => db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)').run(name, `${name}@t.local`, 'h', name).lastInsertRowid;
  const adminId = mkUser('fedadmin');
  const plainId = mkUser('fedplain');
  const roleId = db.prepare('INSERT INTO site_roles (name, color, permissions, position) VALUES (?, ?, ?, ?)').run('Staff', '#fff', SITE_PERMISSIONS.VIEW_ADMIN_PANEL, 1).lastInsertRowid;
  db.prepare('INSERT INTO user_site_roles (user_id, role_id) VALUES (?, ?)').run(adminId, roleId);
  const inbox = { [adminId]: [], [plainId]: [] };
  const sock = (uid) => ({ readyState: 1, OPEN: 1, send: (m) => inbox[uid].push(JSON.parse(m).type) });
  const wsA = sock(adminId);
  const wsP = sock(plainId);
  registerConnection(adminId, wsA);
  registerConnection(plainId, wsP);
  try {
    const out = makePeer('live1.example', { status: 'pending', direction: 'outbound' });
    const inb = makePeer('live2.example', { status: 'pending', direction: 'inbound' });
    await withServer(async (base) => {
      await out.send(base, 'peer_accept');
      await out.send(base, 'peer_accept');
      await fetch(`${base}/federation/admin/peers/${inb.id}/accept`, { method: 'POST', headers: adminHeaders, body: '{}' });
      await fetch(`${base}/federation/admin/peers/${inb.id}`, { method: 'DELETE', headers: adminHeaders });
    });
    assert.deepEqual(inbox[adminId], ['federation_peer_update', 'federation_peer_update', 'federation_peer_update']);
    assert.deepEqual(inbox[plainId], []);
  } finally {
    unregisterConnection(adminId, wsA);
    unregisterConnection(plainId, wsP);
  }
});
