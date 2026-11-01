'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const { db } = require('../db');
const logger = require('../lib/logger');
const metrics = require('../lib/metrics');

test.before(() => { for (const m of ['log', 'warn', 'error']) console[m] = () => {}; metrics.start(); });
test.after(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

function walk(obj, prefix, out) {
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, `${prefix}${k}.`, out);
    else if (!Array.isArray(v)) out.push([`${prefix}${k}`, v]);
  }
  return out;
}

test('snapshot has every field as a finite number', () => {
  const snap = metrics.snapshot();
  const fields = walk(snap, '', []);
  const names = fields.map(([k]) => k);
  for (const k of ['cpuPercent', 'eventLoopLagMs', 'uptimeSeconds', 'memory.rssMb', 'memory.heapUsedMb', 'memory.heapTotalMb', 'memory.systemFreeMb', 'memory.systemTotalMb',
    'online.users', 'online.connections', 'http.requestsPerMinute', 'http.errors5xxPerMinute', 'db.sizeMb', 'db.walSizeMb', 'turn.allocations', 'logs.warnLastHour', 'logs.errorLastHour']) {
    assert.ok(names.includes(k), k);
  }
  assert.ok(Array.isArray(snap.loadAvg) && snap.loadAvg.length === 3);
  for (const [k, v] of fields) assert.ok(typeof v === 'number' && Number.isFinite(v), `${k}=${v}`);
  for (const v of snap.loadAvg) assert.ok(Number.isFinite(v));
  assert.ok(snap.cpuPercent >= 0);
  assert.ok(snap.eventLoopLagMs >= 0);
});

test('request counter increments, 5xx counted separately', () => {
  const before = metrics.snapshot().http;
  for (const status of [200, 404, 500]) {
    const res = new EventEmitter();
    res.statusCode = status;
    metrics.middleware({}, res, () => {});
    res.emit('finish');
  }
  const after = metrics.snapshot().http;
  assert.equal(after.requestsPerMinute - before.requestsPerMinute, 3);
  assert.equal(after.errors5xxPerMinute - before.errors5xxPerMinute, 1);
});

test('warn and error log lines are counted', () => {
  logger.setLevel('warn');
  const before = metrics.snapshot().logs;
  logger.scoped('t').warn('w');
  logger.scoped('t').error('e');
  const after = metrics.snapshot().logs;
  assert.equal(after.warnLastHour - before.warnLastHour, 1);
  assert.equal(after.errorLastHour - before.errorLastHour, 1);
});

test('online counts follow presence', () => {
  const presence = require('../lib/presence');
  const a = {}; const b = {};
  presence.registerConnection(424242, a);
  presence.registerConnection(424242, b);
  const online = metrics.snapshot().online;
  presence.unregisterConnection(424242, a);
  presence.unregisterConnection(424242, b);
  assert.ok(online.users >= 1 && online.connections >= 2);
});
