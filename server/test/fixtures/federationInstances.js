'use strict';

// Shared by the federation integration tests: spawn real `node server/index.js` instances (own
// ports, own DISMESH_DATA_DIR) and drive the federation admin API the way real admins would.
// Importers must set NODE_TLS_REJECT_UNAUTHORIZED=0 before spawning anything (self-signed certs).

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { DEFAULTS } = require('../../lib/config');

function writeInstanceConfig(dataDir, { port, httpsPort }) {
  fs.mkdirSync(dataDir, { recursive: true });
  // Based on config.js's own DEFAULTS rather than a hand-guessed shape, so this stays correct if
  // DEFAULTS ever grows a new required field — only what must differ per instance is overridden.
  const config = {
    ...DEFAULTS,
    port,
    httpsPort,
    publicHost: '127.0.0.1',
    // Federation routers/workers are only mounted/started at all when this is true
    // (server/index.js) — without it, every /federation/* call in this test would 404.
    federation: { enabled: true },
    // MUST include the port (federationOutboxWorker.js's ownDomain() comment): two instances
    // sharing 127.0.0.1 on different ports need distinct domains, or every peer/outbox lookup
    // keyed on `domain` collides between them.
    federationPublicUrl: `https://127.0.0.1:${httpsPort}`,
  };
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(config, null, 2));
}

function startInstance(dataDir, ports) {
  writeInstanceConfig(dataDir, ports); // idempotent — also used to restart an instance against its existing data dir
  const child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'index.js')], {
    env: {
      ...process.env,
      DISMESH_DATA_DIR: dataDir,
      // Test-only SSRF carve-out (server/lib/federationSsrf.js). Two real processes on one test
      // machine can only ever reach each other over loopback, which the real guard always
      // rejects — this is the one narrow, explicitly-named exception for exactly that. Set only
      // on these spawned child processes, never on the test's own process or anywhere a real
      // deployment would read it.
      DISMESH_FEDERATION_ALLOW_LOOPBACK: '1',
      NODE_ENV: 'test',
    },
    stdio: 'pipe',
  });
  const chunks = [];
  child.stdout.on('data', (d) => chunks.push(d));
  child.stderr.on('data', (d) => chunks.push(d));
  child.dump = () => Buffer.concat(chunks).toString('utf8');
  return child;
}

function killAndWait(child, timeoutMs = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill();
  });
}

// Windows holds the sqlite WAL/SHM files (and sometimes the log file) open for a brief moment
// after the process that owned them has already been signaled to exit — an immediate rmSync
// right after kill() reliably hits EPERM there. Retrying past that short window is the fix, not
// a real permission problem.
async function rmDirWithRetry(dir, attempts = 10, delayMs = 300) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

async function waitForPort(httpsPort, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`https://127.0.0.1:${httpsPort}/api/config`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`instance on port ${httpsPort} never came up`);
}

async function pollUntil(fn, { attempts = 60, intervalMs = 300 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    const result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return undefined;
}

function json(method, body, cookie) {
  return {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  };
}

function cookieFrom(res, name) {
  const raw = res.headers.get('set-cookie') || '';
  const m = raw.match(new RegExp(`${name}=([^;]+)`));
  return m ? `${name}=${m[1]}` : '';
}

async function registerAndLogin(base, { username, email, password }) {
  await fetch(`${base}/api/auth/register`, json('POST', { username, email, password }));
  const loginRes = await fetch(`${base}/api/auth/login`, json('POST', { username, password }));
  return cookieFrom(loginRes, 'dismesh_session');
}

async function federationAdminSetup(base, password) {
  const res = await fetch(`${base}/federation/admin/setup`, json('POST', { password }));
  return cookieFrom(res, 'dismesh_federation_admin');
}

async function listPeers(base, fedCookie) {
  const res = await fetch(`${base}/federation/admin/peers`, { headers: { cookie: fedCookie } });
  return (await res.json()).peers;
}

function waitForPeer(base, fedCookie, match) {
  return pollUntil(async () => (await listPeers(base, fedCookie)).find(match));
}

// Bidirectional pairing, driven the way two real admins would: the inviter mints a link, the
// joiner pastes it into its own redeem-invite endpoint (which performs the signed handshake with
// its own key). Afterwards BOTH sides hold a pending row — inbound on the inviter, outbound on the
// joiner — until the inviter explicitly accepts.
async function redeemInvite(inviterBase, inviterFedCookie, joinerBase, joinerFedCookie) {
  const inviteRes = await fetch(`${inviterBase}/federation/admin/invites`, json('POST', {}, inviterFedCookie));
  assert.equal(inviteRes.status, 201);
  const { fullUrl } = await inviteRes.json();

  const redeemRes = await fetch(`${joinerBase}/federation/admin/redeem-invite`, json('POST', { invite: fullUrl }, joinerFedCookie));
  assert.equal(redeemRes.status, 201, `redeem on ${joinerBase} failed: ${await redeemRes.text()}`);

  const peerOnInviter = await waitForPeer(inviterBase, inviterFedCookie, (p) => p.direction === 'inbound' && p.status === 'pending');
  const peerOnJoiner = await waitForPeer(joinerBase, joinerFedCookie, (p) => p.direction === 'outbound' && p.status === 'pending');
  assert.ok(peerOnInviter, 'inviter never recorded the incoming request');
  assert.ok(peerOnJoiner, 'joiner never recorded the outgoing request');
  return { peerOnInviter, peerOnJoiner };
}

// `inviterDomain` narrows the wait to that one peer on the joiner: with several peers already
// active, "any active peer" would return before this particular accept has arrived.
async function acceptPeer(inviterBase, inviterFedCookie, joinerBase, joinerFedCookie, peerId, inviterDomain) {
  const res = await fetch(`${inviterBase}/federation/admin/peers/${peerId}/accept`, json('POST', {}, inviterFedCookie));
  assert.equal(res.status, 200);
  const active = await waitForPeer(joinerBase, joinerFedCookie, (p) => p.status === 'active' && (!inviterDomain || p.domain === inviterDomain));
  assert.ok(active, 'peer_accept never activated the joiner side');
}

module.exports = { writeInstanceConfig, startInstance, killAndWait, rmDirWithRetry, waitForPort, pollUntil, json, cookieFrom, registerAndLogin, federationAdminSetup, listPeers, waitForPeer, redeemInvite, acceptPeer };
