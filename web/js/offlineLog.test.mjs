import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyLog, heartbeat, connected, wasOffline, GRACE_MS, KEEP_MS } from './offlineLog.mjs';

test('first ever connect records no window', () => {
  assert.deepEqual(connected(emptyLog(), 1000), { alive: 1000, windows: [] });
});

test('a reconnect after a long gap records the offline window', () => {
  const log = connected(heartbeat(connected(emptyLog(), 1000), 5000), 100000);
  assert.deepEqual(log.windows, [[5000, 100000]]);
  assert.equal(log.alive, 100000);
});

test('a short blip is not offline', () => {
  const log = connected(heartbeat(emptyLog(), 5000), 5000 + GRACE_MS);
  assert.deepEqual(log.windows, []);
});

test('wasOffline is true only inside a window', () => {
  const w = [[100, 200]];
  assert.equal(wasOffline(w, 150), true);
  assert.equal(wasOffline(w, 100), false);
  assert.equal(wasOffline(w, 200), true);
  assert.equal(wasOffline(w, 250), false);
  assert.equal(wasOffline([], 150), false);
});

test('old windows are pruned', () => {
  const log = connected({ alive: 0, windows: [[1, 2]] }, KEEP_MS + 10);
  assert.deepEqual(log.windows, []);
});
