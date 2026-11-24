'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { verifyAdvert, loadList } = require('./swarm');

const VECTOR = 'eyJ2IjoxLCJ1cmwiOiJodHRwczovL3ZlY3Rvci5leGFtcGxlLmNvbTo4NDQzIiwibmFtZSI6IlZlY3RvciIsImRlc2NyaXB0aW9uIjoiaW50ZXJvcCB0ZXN0IiwiaWNvbiI6bnVsbCwicmVnaXN0cmF0aW9uIjoiaW52aXRlIiwidXBkYXRlZCI6MTcwMDAwMDAwMDAwMCwicHViIjoicTh1OGFRRW1NXzVORDZ1LXM1bVdWcEltWk11SFFEanh0eHItVFlMT09fOCJ9.QZrmQkps9mznKHd0XYlqrMbW1sSWE2QEKhGrm4YVSCdeLCcG8koKIVheDIEOInQ1I0l864yDRueyjCDSicnKBw';

function make(over = {}, keys = crypto.generateKeyPairSync('ed25519')) {
  const pub = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ v: 1, url: 'https://a.example.com', name: 'A', description: '', icon: null, registration: 'open', updated: 1000, pub, ...over }));
  return `${payload.toString('base64url')}.${crypto.sign(null, payload, keys.privateKey).toString('base64url')}`;
}
const edit = (str, from, to) => {
  const [p, s] = str.split('.');
  return `${Buffer.from(Buffer.from(p, 'base64url').toString().replace(from, to)).toString('base64url')}.${s}`;
};
const fakeFetch = (byTracker) => async (url) => {
  const t = Object.keys(byTracker).find((k) => url.startsWith(k));
  const v = byTracker[t];
  if (v instanceof Error) throw v;
  return { ok: true, status: 200, json: async () => ({ servers: v }) };
};
const T1 = 'https://t1.example.com'; const T2 = 'https://t2.example.com'; const T3 = 'https://t3.example.com';

test('an advert built by a MeshCrowd server verifies', async () => {
  const r = await verifyAdvert(VECTOR);
  assert.equal(r.ok, true);
  assert.equal(r.advert.name, 'Vector');
});

test('tampering, a swapped key and bad shapes are refused', async () => {
  assert.equal((await verifyAdvert(edit(VECTOR, 'Vector', 'Vecxor'))).ok, false);
  const good = make();
  const pub = JSON.parse(Buffer.from(good.split('.')[0], 'base64url')).pub;
  const other = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  assert.equal((await verifyAdvert(edit(good, pub, other))).ok, false);
  assert.equal((await verifyAdvert(make({ url: 'http://a.example.com' }))).ok, false);
  assert.equal((await verifyAdvert(make({ url: ['https://a.example.com'] }))).ok, false);
  assert.equal((await verifyAdvert(make({ description: 'x'.repeat(40000) }))).ok, false);
  assert.equal((await verifyAdvert('nonsense')).ok, false);
});

test('a failing tracker only adds to errors; the others are still merged', async () => {
  const adv = make({ url: 'https://s.example.com', name: 'S' });
  const r = await loadList({ trackers: [T1, T2], fetchImpl: fakeFetch({ [T1]: new Error('down'), [T2]: [{ advert: adv, lastSeen: 5 }] }) });
  assert.equal(r.servers.length, 1);
  assert.equal(r.servers[0].name, 'S');
  assert.deepEqual(r.errors.map((e) => e.tracker), [T1]);
});

test('a tracker list is capped at 500 and future-dated entries are dropped', async () => {
  const many = Array.from({ length: 700 }, (_, i) => ({ advert: make({ url: `https://s${i}.example.com` }), lastSeen: 1 }));
  const r = await loadList({ trackers: [T1], fetchImpl: fakeFetch({ [T1]: many }) });
  assert.equal(r.servers.length, 500);
  const future = make({ url: 'https://f.example.com', updated: 1_000_000 + 10 * 60_000 });
  const r2 = await loadList({ trackers: [T1], now: () => 1_000_000, fetchImpl: fakeFetch({ [T1]: [{ advert: future, lastSeen: 1 }] }) });
  assert.equal(r2.servers.length, 0);
});

test('the key most trackers agree on wins and lastSeen is the maximum', async () => {
  const legit = make({ name: 'Legit', updated: 1000 });
  const evil = make({ name: 'Evil', updated: 9000 });
  const r = await loadList({ trackers: [T1, T2, T3], fetchImpl: fakeFetch({ [T1]: [{ advert: evil, lastSeen: 3 }], [T2]: [{ advert: legit, lastSeen: 7 }], [T3]: [{ advert: legit, lastSeen: 9 }] }) });
  assert.equal(r.servers.length, 1);
  assert.equal(r.servers[0].name, 'Legit');
  assert.equal(r.servers[0].lastSeen, 9);
});
