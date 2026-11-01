'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { monitorEventLoopDelay } = require('node:perf_hooks');

const logger = require('./logger');
const presence = require('./presence');
const { DATA_DIR } = require('../db');

const SAMPLE_MS = 5000;
const MB = 1024 * 1024;

function makeWindow(bucketMs, buckets) {
  const counts = new Array(buckets).fill(0);
  const stamps = new Array(buckets).fill(-1);
  return {
    add(now = Date.now()) {
      const slot = Math.floor(now / bucketMs);
      const i = slot % buckets;
      if (stamps[i] !== slot) { stamps[i] = slot; counts[i] = 0; }
      counts[i] += 1;
    },
    sum(now = Date.now()) {
      const slot = Math.floor(now / bucketMs);
      let total = 0;
      for (let i = 0; i < buckets; i++) if (stamps[i] > slot - buckets && stamps[i] <= slot) total += counts[i];
      return total;
    },
  };
}

const requests = makeWindow(1000, 60);
const errors5xx = makeWindow(1000, 60);
const warns = makeWindow(60_000, 60);
const errs = makeWindow(60_000, 60);

const loop = monitorEventLoopDelay({ resolution: 20 });
let started = false;
let lastUsage = process.cpuUsage();
let lastTime = process.hrtime.bigint();
let cpuPercent = 0;

function sampleCpu() {
  const now = process.hrtime.bigint();
  const used = process.cpuUsage(lastUsage);
  const elapsedMs = Number(now - lastTime) / 1e6;
  if (elapsedMs > 0) cpuPercent = Math.max(0, ((used.user + used.system) / 1000 / elapsedMs) * 100);
  lastUsage = process.cpuUsage();
  lastTime = now;
}

function start() {
  if (started) return;
  started = true;
  loop.enable();
  sampleCpu();
  setInterval(() => { sampleCpu(); loop.reset(); }, SAMPLE_MS).unref();
  logger.subscribe((entry) => {
    if (entry.level === 'warn') warns.add();
    else if (entry.level === 'error') errs.add();
  });
}

function middleware(req, res, next) {
  res.on('finish', () => {
    requests.add();
    if (res.statusCode >= 500) errors5xx.add();
  });
  next();
}

function fileMb(file) {
  try { return fs.statSync(file).size / MB; } catch { return 0; }
}

function finite(n) {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function round(n) {
  return Math.round(n * 100) / 100;
}

function allocations() {
  try { return Number(require('./turn/manager').status().allocations) || 0; } catch { return 0; }
}

function snapshot() {
  const mem = process.memoryUsage();
  const dbFile = path.join(DATA_DIR, 'dismesh.db');
  return {
    cpuPercent: round(finite(cpuPercent)),
    loadAvg: os.loadavg().map((n) => round(finite(n))),
    memory: {
      rssMb: round(mem.rss / MB),
      heapUsedMb: round(mem.heapUsed / MB),
      heapTotalMb: round(mem.heapTotal / MB),
      systemFreeMb: round(os.freemem() / MB),
      systemTotalMb: round(os.totalmem() / MB),
    },
    eventLoopLagMs: round(finite(loop.percentile(99) / 1e6)),
    uptimeSeconds: Math.floor(process.uptime()),
    online: { users: presence.onlineUserIds().length, connections: presence.totalConnections() },
    http: { requestsPerMinute: requests.sum(), errors5xxPerMinute: errors5xx.sum() },
    db: { sizeMb: round(fileMb(dbFile)), walSizeMb: round(fileMb(`${dbFile}-wal`)) },
    turn: { allocations: allocations() },
    logs: { warnLastHour: warns.sum(), errorLastHour: errs.sum() },
  };
}

module.exports = { start, snapshot, middleware };
