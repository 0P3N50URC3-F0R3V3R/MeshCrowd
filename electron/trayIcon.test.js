'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTrayIconPNG, buildBlinkFrames, alertLayout, ICON_SIZE } = require('./trayIcon');

const isPng = (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

test('blink frames run from the plain icon to the full alert icon', () => {
  const frames = buildBlinkFrames({ status: 'online', count: 3 }, null, 8);
  assert.equal(frames.length, 9);
  assert.ok(frames.every(isPng));
  assert.ok(frames[0].equals(buildTrayIconPNG({ status: 'online', count: 0 }, null)));
  assert.ok(!frames[8].equals(frames[0]));
  assert.equal(new Set(frames.map((f) => f.toString('base64'))).size, 9);
});

test('the alert icon changes with the count and the status color', () => {
  const last = (badge) => buildBlinkFrames(badge, null, 2)[2].toString('base64');
  assert.notEqual(last({ status: 'online', count: 3 }), last({ status: 'online', count: 4 }));
  assert.notEqual(last({ status: 'online', count: 3 }), last({ status: 'dnd', count: 3 }));
});

test('the count fills the icon and stays inside it, anything above 9 shows 9+', () => {
  for (const [count, label] of [[5, '5'], [9, '9'], [10, '9+'], [42, '9+'], [4000, '9+']]) {
    const L = alertLayout(count);
    assert.equal(L.label, label);
    assert.ok(L.x >= 0 && L.y >= 0 && L.x <= ICON_SIZE / 2 && L.y <= ICON_SIZE / 2);
    assert.ok(L.scale * 5 >= 20);
  }
});
