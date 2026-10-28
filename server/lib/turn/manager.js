'use strict';

// Owns the built-in TURN server's lifecycle (start, live reload when the admin changes settings,
// status) and builds the ICE server list handed to signed-in users.

const os = require('node:os');
const { TurnServer, isPrivate } = require('./server');
const { TurnClient } = require('./client');
const credentials = require('./credentials');
const { load } = require('../config');

let server = null;
let lastError = null;
let log = null;

const isIpv4 = (s) => /^(\d{1,3})(\.\d{1,3}){3}$/.test(s) && s.split('.').every((n) => Number(n) <= 255);

function optionsFrom(cfg) {
  const t = cfg.turn;
  return {
    realm: t.realm, secret: t.secret, listenAddress: t.listenAddress, port: t.port, tcp: t.tcp, externalIp: t.externalIp,
    relayPortMin: t.relayPortMin, relayPortMax: t.relayPortMax, allowPrivatePeers: t.allowPrivatePeers,
    maxAllocations: t.maxAllocations, maxAllocationsPerUser: t.maxAllocationsPerUser, maxKbps: t.maxKbps, logger: log,
  };
}

async function start(logger) {
  if (logger) log = logger;
  lastError = null;
  const cfg = load();
  if (!cfg.turn.enabled || server) return;
  const s = new TurnServer(optionsFrom(cfg));
  try {
    await s.start();
    server = s;
  } catch (err) {
    lastError = err.code === 'EADDRINUSE' ? `port ${cfg.turn.port} is already in use` : err.message;
    log?.error?.('[turn] could not start:', lastError);
    try { await s.stop(); } catch { /* never started */ }
  }
}

async function stop() {
  if (!server) return;
  const s = server;
  server = null;
  await s.stop();
}

async function reload() {
  await stop();
  await start();
}

function localAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

function status() {
  const cfg = load();
  const t = cfg.turn;
  const locals = localAddresses();
  const publicLocal = locals.find((a) => !isPrivate(a));
  const warnings = [];
  if (t.enabled && !t.externalIp && !publicLocal) warnings.push('noExternalIp');
  if (t.enabled && t.allowPrivatePeers) warnings.push('privatePeers');
  return {
    enabled: !!t.enabled,
    running: !!server?.running,
    error: lastError,
    ...(server ? server.status() : { port: t.port, tcp: t.tcp, allocations: 0, bytesRelayed: 0, allocationsTotal: 0, relayPorts: [t.relayPortMin, t.relayPortMax] }),
    localAddresses: locals,
    warnings,
  };
}

function hostFor(cfg, reqHost) {
  const t = cfg.turn;
  const publicHost = cfg.publicHost && cfg.publicHost !== 'localhost' ? cfg.publicHost : '';
  return t.advertisedHost || t.externalIp || publicHost || reqHost;
}

// The list a signed-in user's browser feeds to RTCPeerConnection. Operator-defined external
// servers come first, then this server's own STUN + TURN with a short-lived credential.
function iceServersFor(user, reqHost) {
  const cfg = load();
  const list = [...(cfg.iceServers || [])];
  let ttl = 0;
  let builtIn = false;
  if (cfg.turn.enabled && server?.running) {
    const host = hostFor(cfg, reqHost);
    const port = cfg.turn.port;
    const c = credentials.issue(cfg.turn.secret, `u${user.id}`, cfg.turn.credentialTtlSeconds);
    const urls = [`turn:${host}:${port}?transport=udp`];
    if (cfg.turn.tcp) urls.push(`turn:${host}:${port}?transport=tcp`);
    list.push({ urls: [`stun:${host}:${port}`] }, { urls, username: c.username, credential: c.credential });
    ttl = c.expiresAt * 1000 - Date.now();
    builtIn = true;
  }
  return { iceServers: list, ttlMs: ttl, builtIn };
}

// What a browser that is not signed in may see: only entries without credentials.
function publicIceServers() {
  return (load().iceServers || []).filter((s) => !s.username && !s.credential);
}

// Allocates against the running server like a browser would. Returns one entry per check.
async function selfTest() {
  const cfg = load();
  const checks = [];
  if (!cfg.turn.enabled) return { ok: false, checks: [{ name: 'enabled', ok: false }] };
  if (!server?.running) return { ok: false, checks: [{ name: 'running', ok: false, detail: lastError || 'not running' }] };
  const host = cfg.turn.listenAddress === '0.0.0.0' ? '127.0.0.1' : cfg.turn.listenAddress;
  const c = credentials.issue(cfg.turn.secret, 'selftest', 120);
  const cl = new TurnClient({ host, port: cfg.turn.port, username: c.username, credential: c.credential });
  try {
    const me = await cl.binding();
    checks.push({ name: 'stun', ok: !!me });
    const a = await cl.allocate();
    checks.push({ name: 'allocate', ok: a.ok, detail: a.ok ? `${a.relayed.ip}:${a.relayed.port}` : `error ${a.code}` });
    if (a.ok) {
      // The allocation above came from loopback, so its relayed address is a LAN one; what matters to
      // people outside is the address the server tells them about.
      const reachable = cfg.turn.externalIp || localAddresses().find((x) => !isPrivate(x)) || '';
      checks.push({ name: 'relayAddress', ok: !!reachable || cfg.turn.allowPrivatePeers, detail: reachable || 'not set' });
      await cl.refresh(0);
    }
  } catch (err) {
    checks.push({ name: 'allocate', ok: false, detail: err.message });
  } finally { cl.close(); }
  return { ok: checks.every((x) => x.ok), checks };
}

// Asks a public STUN server what address this machine appears from. Only runs when an admin presses the button.
async function detectExternalIp() {
  for (const [host, port] of [['stun.l.google.com', 19302], ['stun.cloudflare.com', 3478]]) {
    const cl = new TurnClient({ host, port, timeoutMs: 2500 });
    try {
      const me = await cl.binding();
      if (me?.ip && isIpv4(me.ip)) return me.ip;
    } catch { /* try the next one */ } finally { cl.close(); }
  }
  return null;
}

module.exports = { start, stop, reload, status, iceServersFor, publicIceServers, selfTest, detectExternalIp, isIpv4 };
