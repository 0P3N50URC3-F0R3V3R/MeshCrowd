'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-swarm-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const config = require('../lib/config');
const advert = require('../lib/swarmAdvert');
const { createWorker } = require('../lib/swarmWorker');

test.after(async () => {
  require('../db').db.close();
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const T1 = 'https://t1.example.com'; const T2 = 'https://t2.example.com';
const other = (over = {}) => advert.build({ url: 'https://other.example.com', name: 'Other', description: 'd', icon: null, registration: 'invite', updated: 1000, ...over });
const reply = (status, json) => ({ ok: status < 400, status, json: async () => json, text: async () => '' });

function setup({ trackers = [T1], advertise = true, lists = {}, fail = new Set() } = {}) {
  config.save({ publicHost: 'me.example.com', httpsPort: 8443, instance: { name: 'Me' }, swarm: { advertise, trackers, intervalSeconds: 300 } });
  const calls = [];
  let clock = 1_000_000;
  const fetchImpl = async (url, opts = {}) => {
    const t = trackers.find((x) => url.startsWith(x)) || url;
    calls.push({ url, method: opts.method || 'GET', body: opts.body, tracker: t });
    if (fail.has(t)) throw new Error('down');
    if ((opts.method || 'GET') === 'GET') return reply(200, { servers: lists[t] || [] });
    return reply(204, null);
  };
  const worker = createWorker({ fetchImpl, now: () => clock, timeoutMs: 30 });
  return { worker, calls, fail, tick: (ms) => { clock += ms; }, lists };
}

test('advertising off: no calls, empty list', async () => {
  const { worker, calls } = setup({ advertise: false });
  await worker.announceNow();
  assert.equal(calls.length, 0);
  assert.deepEqual(worker.getList(), { enabled: false, servers: [] });
});

test('announces to every tracker; one failing does not stop the others', async () => {
  const { worker, calls } = setup({ trackers: [T1, T2], fail: new Set([T1]) });
  await worker.announceNow();
  assert.ok(calls.some((c) => c.tracker === T2 && c.method === 'POST' && c.url === `${T2}/announce`));
  const adv = calls.find((c) => c.method === 'POST' && c.tracker === T2).body;
  const v = advert.verify(adv);
  assert.equal(v.ok, true);
  assert.equal(v.advert.url, 'https://me.example.com:8443');
  const st = worker.getStatus();
  assert.equal(st.find((s) => s.url === T1).ok, false);
  assert.match(st.find((s) => s.url === T1).lastError, /down/);
  assert.equal(st.find((s) => s.url === T2).ok, true);
});

test('all trackers down: no throw, empty list, backoff caps at one hour', async () => {
  const { worker } = setup({ trackers: [T1, T2], fail: new Set([T1, T2]) });
  for (let i = 0; i < 10; i++) await worker.announceNow();
  assert.deepEqual(worker.getList().servers, []);
  assert.equal(worker.getStatus()[0].nextTry - 1_000_000, 3_600_000);
});

test('first failure schedules the retry 60 s out, the second 120 s', async () => {
  const { worker, tick } = setup({ fail: new Set([T1]) });
  await worker.announceNow();
  assert.equal(worker.getStatus()[0].nextTry, 1_000_000 + 60_000);
  tick(60_000);
  await worker.runPass();
  assert.equal(worker.getStatus()[0].nextTry, 1_060_000 + 120_000);
});

test('a tracker still in backoff is skipped by a normal pass but not by announceNow', async () => {
  const { worker, calls, fail } = setup({ fail: new Set([T1]) });
  await worker.announceNow();
  const n = calls.length;
  await worker.runPass();
  assert.equal(calls.length, n);
  fail.delete(T1);
  await worker.announceNow();
  assert.ok(calls.length > n);
  assert.equal(worker.getStatus()[0].ok, true);
});

test('tampered adverts are dropped; the newest valid advert per address wins', async () => {
  const good = other({ updated: 2000, name: 'New' });
  const old = other({ updated: 1000, name: 'Old' });
  const [p, s] = other({ name: 'Real' }).split('.');
  const forged = `${Buffer.from(Buffer.from(p, 'base64url').toString().replace('Real', 'Fake')).toString('base64url')}.${s}`;
  const { worker } = setup({ trackers: [T1, T2], lists: { [T1]: [{ advert: old, lastSeen: 5 }, { advert: forged, lastSeen: 6 }], [T2]: [{ advert: good, lastSeen: 9 }] } });
  await worker.announceNow();
  const list = worker.getList();
  assert.equal(list.enabled, true);
  assert.equal(list.servers.length, 1);
  assert.equal(list.servers[0].name, 'New');
  assert.equal(list.servers[0].lastSeen, 9);
  assert.deepEqual(list.servers[0].trackers.sort(), [T1, T2].sort());
});

test('our own advert is not listed back to us', async () => {
  const mine = advert.build({ url: 'https://me.example.com:8443', name: 'Me', description: '', icon: null, registration: 'open', updated: 1 });
  const { worker } = setup({ lists: { [T1]: [{ advert: mine, lastSeen: 1 }] } });
  await worker.announceNow();
  assert.deepEqual(worker.getList().servers, []);
});

test('turning advertising off sends one DELETE and stops', async () => {
  const { worker, calls } = setup();
  await worker.announceNow();
  config.save({ swarm: { advertise: false } });
  await worker.announceNow();
  assert.equal(calls.filter((c) => c.method === 'DELETE').length, 1);
  const n = calls.length;
  await worker.announceNow();
  assert.equal(calls.length, n);
  assert.deepEqual(worker.getList(), { enabled: false, servers: [] });
});

test('a hanging tracker is abandoned after the timeout', async () => {
  config.save({ swarm: { advertise: true, trackers: [T1] } });
  const worker = createWorker({ fetchImpl: () => new Promise(() => {}), timeoutMs: 20 });
  await worker.announceNow();
  assert.match(worker.getStatus()[0].lastError, /timed out/);
});

const crypto = require('node:crypto');
function foreign(over = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ v: 1, url: 'https://legit.example.com', name: 'Evil', description: '', icon: null, registration: 'open', updated: 1000, pub, ...over }));
  return `${payload.toString('base64url')}.${crypto.sign(null, payload, privateKey).toString('base64url')}`;
}

test('a tracker list is capped per tracker', async () => {
  const many = Array.from({ length: 700 }, (_, i) => ({ advert: other({ url: `https://s${i}.example.com` }), lastSeen: 1 }));
  const { worker } = setup({ lists: { [T1]: many } });
  await worker.announceNow();
  assert.equal(worker.getList().servers.length, 500);
});

test('adverts dated in the future are dropped', async () => {
  const future = other({ url: 'https://future.example.com', updated: 1_000_000 + 10 * 60_000 });
  const fine = other({ url: 'https://fine.example.com', updated: 1_000_000 + 60_000 });
  const { worker } = setup({ lists: { [T1]: [{ advert: future, lastSeen: 1 }, { advert: fine, lastSeen: 1 }] } });
  await worker.announceNow();
  assert.deepEqual(worker.getList().servers.map((s) => s.url), ['https://fine.example.com']);
});

test('one tracker cannot replace what the majority of trackers say about an address', async () => {
  const legit = advert.build({ url: 'https://legit.example.com', name: 'Legit', description: '', icon: null, registration: 'open', updated: 1000 });
  const evil = foreign({ updated: 5000 });
  const T3 = 'https://t3.example.com';
  const { worker } = setup({ trackers: [T1, T2, T3], lists: { [T1]: [{ advert: evil, lastSeen: 1 }], [T2]: [{ advert: legit, lastSeen: 1 }], [T3]: [{ advert: legit, lastSeen: 1 }] } });
  await worker.announceNow();
  const list = worker.getList().servers;
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'Legit');
});

test('turning advertising off during a running pass still sends the DELETE', async () => {
  const { worker, calls } = setup();
  await worker.announceNow();
  const slow = createWorker({
    fetchImpl: async (url, opts = {}) => { calls.push({ method: opts.method || 'GET' }); await new Promise((r) => setTimeout(r, 40)); return reply(204, null); },
    timeoutMs: 1000,
  });
  config.save({ swarm: { advertise: true, trackers: [T1] } });
  const first = slow.announceNow();
  await new Promise((r) => setTimeout(r, 10));
  config.save({ swarm: { advertise: false } });
  const second = slow.announceNow();
  await Promise.all([first, second]);
  assert.ok(calls.some((c) => c.method === 'DELETE'));
});
