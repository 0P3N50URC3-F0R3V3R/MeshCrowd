'use strict';

const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const siteFiles = require('./siteFiles');
const phpRuntime = require('./phpRuntime');
const { DATA_DIR } = require('../db');

class SiteUnavailableError extends Error {
  constructor(message, retryAfter) { super(message); this.status = 503; this.retryAfter = retryAfter; }
}

function defaultLauncher({ siteId, port, docroot }) {
  const spec = phpRuntime.launchSpec({ siteId, port, docroot });
  const logDir = path.join(DATA_DIR, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const fd = fs.openSync(path.join(logDir, `php-${siteId}.log`), 'a');
  const closeFd = () => { try { fs.closeSync(fd); } catch { /* already closed */ } };
  const child = spawn(spec.bin, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ['ignore', fd, fd], windowsHide: true });
  child.once('exit', closeFd);
  child.once('error', closeFd);
  return child;
}

const opts = {
  idleMs: 10 * 60_000, extraIdleMs: 60_000, sweepMs: 60_000, readyTimeoutMs: 8000, maxWorkers: 4, launcher: defaultLauncher,
};
const pools = new Map();    // siteId -> { workers: Worker[], pending: number }
const starting = new Map(); // siteId -> Promise<pool>; dedupes simultaneous cold starts
const crashes = new Map();  // siteId -> { times, notBefore, blocked }
let sweeper = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function canConnect(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

async function waitReady(port, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('process exited');
    if (await canConnect(port)) return;
    await sleep(50);
  }
  throw new Error('timed out waiting for the process');
}

function recordCrash(siteId) {
  const c = crashes.get(siteId) || { times: [], notBefore: 0, blocked: false };
  const now = Date.now();
  c.times = c.times.filter((t) => now - t < 60_000);
  c.times.push(now);
  c.notBefore = now + Math.min(30_000, 500 * 2 ** (c.times.length - 1));
  if (c.times.length >= 5) c.blocked = true;
  crashes.set(siteId, c);
}

const resetCrashes = (siteId) => { crashes.delete(siteId); };
const kill = (child) => { try { child.kill(); } catch { /* already gone */ } };
const backoffActive = (siteId) => { const c = crashes.get(siteId); return !!c && (c.blocked || Date.now() < c.notBefore); };

function assertStartable(siteId) {
  const c = crashes.get(siteId);
  const now = Date.now();
  if (c && c.blocked) throw new SiteUnavailableError('this site keeps crashing; edit a file or restart the server', 60);
  if (c && now < c.notBefore) throw new SiteUnavailableError('this site is restarting', Math.ceil((c.notBefore - now) / 1000));
}

// Starts one php process and resolves when it accepts connections. The caller adds it to the pool.
async function startWorker(siteId) {
  const docroot = siteFiles.ensureSiteDir(siteId);
  const port = await freePort();
  const child = opts.launcher({ siteId, port, docroot });
  const worker = { siteId, child, port, inflight: 0, lastUsed: Date.now(), stopping: false, dead: false };
  const onDead = () => {
    if (worker.dead) return;
    worker.dead = true;
    const pool = pools.get(siteId);
    if (pool) {
      pool.workers = pool.workers.filter((w) => w !== worker);
      if (!pool.workers.length && !pool.pending) pools.delete(siteId);
    }
    if (!worker.stopping) recordCrash(siteId);
  };
  child.once('exit', onDead);
  child.once('error', onDead);
  try {
    await waitReady(port, opts.readyTimeoutMs, child);
  } catch {
    worker.stopping = true;
    kill(child);
    throw new SiteUnavailableError('this site failed to start', 5);
  }
  return worker;
}

async function coldStart(siteId) {
  assertStartable(siteId);
  const worker = await startWorker(siteId);
  const pool = { workers: [worker], pending: 0 };
  pools.set(siteId, pool);
  startSweeper();
  return pool;
}

function lease(worker) {
  worker.inflight++;
  worker.lastUsed = Date.now();
  let released = false;
  return {
    port: worker.port,
    release() {
      if (released) return;
      released = true;
      worker.inflight = Math.max(0, worker.inflight - 1);
      worker.lastUsed = Date.now();
    },
  };
}

async function acquire(siteId) {
  for (;;) {
    let pool = pools.get(siteId);
    if (!pool || !pool.workers.length) {
      let p = starting.get(siteId);
      if (!p) { p = coldStart(siteId).finally(() => starting.delete(siteId)); starting.set(siteId, p); }
      pool = await p;
    }
    if (!pool.workers.length) continue; // died while we waited; try again (assertStartable will gate it)

    const idle = pool.workers.find((w) => w.inflight === 0);
    if (idle) return lease(idle);

    if (pool.workers.length + pool.pending < opts.maxWorkers && !backoffActive(siteId)) {
      pool.pending++;
      try {
        const worker = await startWorker(siteId);
        const taken = lease(worker); // claim it before anyone else can
        pool.workers.push(worker);
        if (!pools.has(siteId)) pools.set(siteId, pool);
        return taken;
      } catch { /* could not grow; fall through to the least busy worker */ } finally { pool.pending--; }
    }

    const least = pool.workers.reduce((a, b) => (b.inflight < a.inflight ? b : a), pool.workers[0]);
    if (least) return lease(least);
  }
}

function stopWorker(worker) {
  worker.stopping = true;
  kill(worker.child);
}

function stop(siteId) {
  const pool = pools.get(siteId);
  if (!pool) return;
  pools.delete(siteId);
  for (const w of pool.workers) stopWorker(w);
  pool.workers = [];
}

const stopAll = () => { for (const id of [...pools.keys()]) stop(id); };

function startSweeper() {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, pool] of pools) {
      pool.workers.forEach((w, i) => {
        const limit = i === 0 ? opts.idleMs : opts.extraIdleMs;
        if (w.inflight === 0 && now - w.lastUsed > limit) {
          pool.workers = pool.workers.filter((x) => x !== w);
          stopWorker(w);
        }
      });
      if (!pool.workers.length && !pool.pending) pools.delete(id);
    }
  }, opts.sweepMs);
  sweeper.unref();
}

function configure(o) {
  Object.assign(opts, o);
  if (sweeper) { clearInterval(sweeper); sweeper = null; if (pools.size) startSweeper(); }
}

process.on('exit', stopAll);

module.exports = {
  acquire, stop, stopAll, resetCrashes, configure, SiteUnavailableError,
  activeCount: () => [...pools.values()].reduce((n, p) => n + p.workers.length, 0),
  workerCount: (siteId) => pools.get(siteId)?.workers.length || 0,
  _recordCrash: recordCrash,
};
