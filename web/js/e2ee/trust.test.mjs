import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePeerKey, acceptNewKey, setVerified, isVerified } from './trust.mjs';

const memoryStorage = () => {
  const map = new Map();
  return { get: async (k) => map.get(k), set: async (k, v) => { map.set(k, v); }, map };
};

test('first sight pins the key and starts unverified', async () => {
  const s = memoryStorage();
  const r = await evaluatePeerKey(s, 1, 2, 'KEY-A');
  assert.equal(r.status, 'pinned');
  assert.equal(isVerified(r.record), false);
  assert.equal((await evaluatePeerKey(s, 1, 2, 'KEY-A')).status, 'ok');
});

test('a different key is reported as changed and does not modify the pin', async () => {
  const s = memoryStorage();
  await evaluatePeerKey(s, 1, 2, 'KEY-A');
  const r = await evaluatePeerKey(s, 1, 2, 'KEY-B');
  assert.equal(r.status, 'changed');
  assert.equal(s.map.get('1:2').pinned, 'KEY-A');
  assert.equal((await evaluatePeerKey(s, 1, 2, 'KEY-B')).status, 'changed');
});

test('verification is recorded for the pinned key and can be cleared', async () => {
  const s = memoryStorage();
  await evaluatePeerKey(s, 1, 2, 'KEY-A');
  assert.equal(isVerified(await setVerified(s, 1, 2, true)), true);
  assert.equal(isVerified((await evaluatePeerKey(s, 1, 2, 'KEY-A')).record), true);
  assert.equal(isVerified(await setVerified(s, 1, 2, false)), false);
});

test('setVerified without a pin is a no-op', async () => {
  const s = memoryStorage();
  assert.equal(await setVerified(s, 1, 2, true), null);
  assert.equal(s.map.size, 0);
});

test('accepting a new key re-pins and resets verification', async () => {
  const s = memoryStorage();
  await evaluatePeerKey(s, 1, 2, 'KEY-A');
  await setVerified(s, 1, 2, true);
  assert.equal((await evaluatePeerKey(s, 1, 2, 'KEY-B')).status, 'changed');
  const rec = await acceptNewKey(s, 1, 2, 'KEY-B');
  assert.equal(isVerified(rec), false);
  const r = await evaluatePeerKey(s, 1, 2, 'KEY-B');
  assert.equal(r.status, 'ok');
  assert.equal(isVerified(r.record), false);
});

test('a stale verifiedKey never counts as verified', () => {
  assert.equal(isVerified({ pinned: 'KEY-B', verifiedKey: 'KEY-A' }), false);
});

test('records are per user and per peer', async () => {
  const s = memoryStorage();
  await evaluatePeerKey(s, 1, 2, 'KEY-A');
  assert.equal((await evaluatePeerKey(s, 3, 2, 'KEY-X')).status, 'pinned');
  assert.equal((await evaluatePeerKey(s, 1, 4, 'KEY-Y')).status, 'pinned');
});
