import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  PALETTE, WIDTHS, MAX_POINTS_PER_MESSAGE, MAX_STROKES, toNormalized, createBatcher, createStore, drawPoints, strokePixelWidth, ERASER,
} from './whiteboardMath.mjs';

const server = createRequire(import.meta.url)('../../server/lib/whiteboard.js');

test('client palette, widths and limits match the server', () => {
  assert.deepEqual(PALETTE.map((c) => c.id), server.PALETTE);
  assert.deepEqual(WIDTHS, server.WIDTHS);
  assert.equal(ERASER, server.ERASER);
  assert.equal(MAX_POINTS_PER_MESSAGE, server.MAX_POINTS_PER_MESSAGE);
  assert.equal(MAX_STROKES, server.MAX_STROKES);
});

test('toNormalized maps into 0..1 and clamps', () => {
  const rect = { left: 100, top: 50, width: 200, height: 100 };
  assert.deepEqual(toNormalized(200, 100, rect), [0.5, 0.5]);
  assert.deepEqual(toNormalized(0, 1000, rect), [0, 1]);
  assert.equal(toNormalized(1, 1, { left: 0, top: 0, width: 0, height: 0 }), null);
});

test('batcher drops near-duplicate points and splits into capped chunks', () => {
  const b = createBatcher({ maxPoints: 3, minDist: 0.01 });
  assert.equal(b.add(0.1, 0.1), true);
  assert.equal(b.add(0.1001, 0.1), false);
  for (let i = 1; i <= 6; i++) b.add(0.1 + i * 0.05, 0.1);
  assert.equal(b.take().length, 6);
  assert.equal(b.take().length, 6);
  assert.equal(b.take().length, 2);
  assert.equal(b.take(), null);
  assert.equal(b.hasPending(), false);
});

test('store appends to existing strokes, reports prev point and evicts at the cap', () => {
  const s = createStore();
  let r = s.append({ strokeId: 'a', color: 'red', width: 2, points: [0.1, 0.1, 0.2, 0.2] });
  assert.equal(r.fresh, true);
  assert.equal(r.prev, null);
  r = s.append({ strokeId: 'a', color: 'red', width: 2, points: [0.3, 0.3] });
  assert.equal(r.fresh, false);
  assert.deepEqual(r.prev, [0.2, 0.2]);
  for (let i = 0; i < MAX_STROKES + 5; i++) s.append({ strokeId: `s${i}`, color: 'blue', width: 5, points: [0.5, 0.5] });
  assert.equal(s.size(), MAX_STROKES);
  s.clear();
  assert.equal(s.size(), 0);
});

test('drawPoints draws a dot for a first point, lines after, and erases with destination-out', () => {
  const calls = [];
  const ctx = new Proxy({}, {
    get: (t, k) => (k in t ? t[k] : (...a) => calls.push([k, ...a])),
    set: (t, k, v) => { t[k] = v; calls.push(['set', k, v]); return true; },
  });
  const last = drawPoints(ctx, { color: 'red', width: 2 }, [0.5, 0.5, 1, 1], 200, 100, null);
  assert.deepEqual(last, [1, 1]);
  assert.ok(calls.some((c) => c[0] === 'arc' && c[1] === 100 && c[2] === 50));
  assert.ok(calls.some((c) => c[0] === 'lineTo' && c[1] === 200 && c[2] === 100));
  calls.length = 0;
  drawPoints(ctx, { color: ERASER, width: 2 }, [0.1, 0.1], 200, 100, [0, 0]);
  assert.ok(calls.some((c) => c[0] === 'set' && c[1] === 'globalCompositeOperation' && c[2] === 'destination-out'));
  assert.equal(drawPoints(ctx, { color: 'bogus', width: 2 }, [0.1, 0.1], 200, 100, null), null);
  assert.equal(strokePixelWidth(5, ERASER, 1000), 20);
});
