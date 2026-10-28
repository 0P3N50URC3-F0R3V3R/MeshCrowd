'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const { db } = require('../db');
const sp = require('../lib/siteProcesses');
const siteFiles = require('../lib/siteFiles');

const FAKE = path.join(__dirname, 'fixtures', 'fakePhp.js');
let launches = 0;
const launcher = ({ port, docroot }) => {
  launches++;
  return spawn(process.execPath, [FAKE, '-S', `127.0.0.1:${port}`, '-t', docroot], { stdio: 'ignore', windowsHide: true });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hit = async (port, p = '/') => (await fetch(`http://127.0.0.1:${port}${p}`)).text();
const DEFAULTS = { launcher, idleMs: 600_000, extraIdleMs: 600_000, sweepMs: 60_000, readyTimeoutMs: 8000, maxWorkers: 1 };

test.beforeEach(() => { sp.stopAll(); launches = 0; sp.configure({ ...DEFAULTS }); });
test.after(async () => { sp.stopAll(); db.close(); await sleep(200); fs.rmSync(tmpDir, { recursive: true, force: true }); });

test('acquire starts a worker once and reuses it', async () => {
  const a = await sp.acquire(1);
  a.release();
  const b = await sp.acquire(1);
  b.release();
  assert.equal(a.port, b.port);
  assert.equal(launches, 1);
  assert.match(await hit(a.port), /GET \//);
});

test('simultaneous cold requests never start more workers than maxWorkers', async () => {
  const leases = await Promise.all([1, 2, 3, 4, 5, 6].map(() => sp.acquire(2)));
  assert.equal(launches, 1); // maxWorkers is 1: one cold start, the rest queue on it
  assert.equal(new Set(leases.map((l) => l.port)).size, 1);
  leases.forEach((l) => l.release());
  sp.configure({ maxWorkers: 3 });
  sp.stop(2);
  launches = 0;
  const more = await Promise.all([1, 2, 3, 4, 5, 6].map(() => sp.acquire(2)));
  assert.ok(launches <= 3, `launched ${launches}`);
  assert.ok(sp.workerCount(2) <= 3);
  more.forEach((l) => l.release());
});

test('a slow request does not block the others: they run on other workers in parallel', async () => {
  sp.configure({ maxWorkers: 4 });
  const t0 = Date.now();
  await Promise.all([1, 2, 3, 4].map(async () => {
    const lease = await sp.acquire(3);
    try { await hit(lease.port, '/slow'); } finally { lease.release(); }
  }));
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 900, `took ${elapsed}ms; a single worker would need about 1200ms`);
  assert.equal(sp.workerCount(3), 4);
});

test('busy workers are skipped: dispatch goes to an idle worker and reuses released ones', async () => {
  sp.configure({ maxWorkers: 2 });
  const a = await sp.acquire(4);
  const b = await sp.acquire(4);
  assert.notEqual(a.port, b.port);
  const c = await sp.acquire(4); // pool is full: queues on the least busy worker
  assert.ok([a.port, b.port].includes(c.port));
  a.release(); a.release(); // double release is ignored
  b.release(); c.release();
  const d = await sp.acquire(4);
  assert.equal(sp.workerCount(4), 2);
  d.release();
});

test('stop kills every worker and the next acquire starts fresh', async () => {
  sp.configure({ maxWorkers: 2 });
  const a = await sp.acquire(5);
  const b = await sp.acquire(5);
  sp.stop(5);
  assert.equal(sp.activeCount(), 0);
  await assert.rejects(hit(a.port));
  await assert.rejects(hit(b.port));
  const c = await sp.acquire(5);
  c.release();
  assert.equal(launches, 3);
});

test('extra workers are retired quickly while the first one stays', async () => {
  sp.configure({ maxWorkers: 3, idleMs: 600_000, extraIdleMs: 40, sweepMs: 15 });
  const leases = await Promise.all([1, 2, 3].map(() => sp.acquire(6)));
  assert.equal(sp.workerCount(6), 3);
  leases.forEach((l) => l.release());
  await sleep(300);
  assert.equal(sp.workerCount(6), 1);
});

test('an idle site is stopped entirely by the sweeper', async () => {
  sp.configure({ idleMs: 40, extraIdleMs: 40, sweepMs: 15 });
  (await sp.acquire(7)).release();
  assert.equal(sp.activeCount(), 1);
  await sleep(250);
  assert.equal(sp.activeCount(), 0);
});

test('a crashing site answers 503, backs off, and recovers after resetCrashes', async () => {
  siteFiles.ensureSiteDir(8);
  fs.writeFileSync(path.join(siteFiles.siteDir(8), 'crash.flag'), '1');
  await assert.rejects(sp.acquire(8), (e) => e instanceof sp.SiteUnavailableError && e.status === 503);
  await assert.rejects(sp.acquire(8), (e) => e.status === 503 && /restarting/.test(e.message));
  fs.rmSync(path.join(siteFiles.siteDir(8), 'crash.flag'));
  sp.resetCrashes(8);
  const ok = await sp.acquire(8);
  ok.release();
  assert.equal(typeof ok.port, 'number');
});

test('five crashes in a minute block the site until reset', async () => {
  for (let i = 0; i < 5; i++) sp._recordCrash(9);
  await assert.rejects(sp.acquire(9), (e) => e.status === 503 && /keeps crashing/.test(e.message));
  sp.resetCrashes(9);
  (await sp.acquire(9)).release();
});
