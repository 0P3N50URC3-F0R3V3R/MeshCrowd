import test from 'node:test';
import assert from 'node:assert/strict';
import { moveBox, clampBox, fitBox, applyRatio, zoomBox, resizeBox, boxToSource, outputSize, outputType, CROP_SPECS } from './cropMath.mjs';

const img = { w: 1000, h: 600 };
const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} != ${b}`);
const inside = (b) => {
  assert.ok(b.x >= -1e-9 && b.y >= -1e-9 && b.x + b.w <= img.w + 1e-9 && b.y + b.h <= img.h + 1e-9, JSON.stringify(b));
};

test('fitBox is the largest centered box of the ratio', () => {
  assert.deepEqual(fitBox(img, 1), { x: 200, y: 0, w: 600, h: 600 });
  const wide = fitBox(img, 340 / 110);
  near(wide.w, 1000);
  near(wide.w / wide.h, 340 / 110);
  assert.deepEqual(fitBox(img, null), { x: 0, y: 0, w: 1000, h: 600 });
});

test('moveBox keeps the box inside the image', () => {
  const b = { x: 100, y: 100, w: 300, h: 300 };
  assert.deepEqual(moveBox(b, -500, -500, img), { x: 0, y: 0, w: 300, h: 300 });
  assert.deepEqual(moveBox(b, 5000, 5000, img), { x: 700, y: 300, w: 300, h: 300 });
});

test('clampBox enforces image bounds, minimum size and the ratio', () => {
  inside(clampBox({ x: -50, y: 900, w: 5000, h: 5000 }, img));
  const tiny = clampBox({ x: 10, y: 10, w: 2, h: 2 }, img);
  assert.ok(tiny.w >= 24 && tiny.h >= 24);
  const locked = clampBox({ x: 0, y: 0, w: 900, h: 900 }, img, 2);
  near(locked.w / locked.h, 2);
  inside(locked);
});

test('applyRatio keeps the center and shrinks to the ratio', () => {
  const b = applyRatio({ x: 100, y: 100, w: 400, h: 200 }, img, 1);
  near(b.w, 200);
  near(b.h, 200);
  near(b.x + b.w / 2, 300);
  near(b.y + b.h / 2, 200);
  assert.deepEqual(applyRatio({ x: 1, y: 2, w: 30, h: 40 }, img, null), { x: 1, y: 2, w: 30, h: 40 });
});

test('zoomBox scales around the center and never exceeds the image', () => {
  assert.deepEqual(zoomBox({ x: 400, y: 200, w: 200, h: 200 }, 0.5, img, 1), { x: 450, y: 250, w: 100, h: 100 });
  const big = zoomBox({ x: 400, y: 200, w: 200, h: 200 }, 100, img, 1);
  near(big.w, 600);
  near(big.h, 600);
  inside(big);
});

test('free resize moves only the dragged edges and respects bounds', () => {
  const b = { x: 200, y: 100, w: 300, h: 200 };
  assert.deepEqual(resizeBox(b, 'e', 100, 999, img), { x: 200, y: 100, w: 400, h: 200 });
  assert.deepEqual(resizeBox(b, 'nw', -100, -50, img), { x: 100, y: 50, w: 400, h: 250 });
  assert.deepEqual(resizeBox(b, 'w', -999, 0, img), { x: 0, y: 100, w: 500, h: 200 });
  assert.deepEqual(resizeBox(b, 'se', 9999, 9999, img), { x: 200, y: 100, w: 800, h: 500 });
  const shrunk = resizeBox(b, 'e', -9999, 0, img);
  assert.equal(shrunk.w, 24);
  assert.equal(shrunk.x, 200);
});

test('locked resize keeps the ratio and the opposite corner fixed', () => {
  const b = { x: 200, y: 100, w: 300, h: 150 };
  const se = resizeBox(b, 'se', 100, 0, img, 2);
  near(se.w / se.h, 2);
  near(se.x, 200);
  near(se.y, 100);
  near(se.w, 400);
  const nw = resizeBox(b, 'nw', -60, -10, img, 2);
  near(nw.w / nw.h, 2);
  near(nw.x + nw.w, 500);
  near(nw.y + nw.h, 250);
  inside(nw);
});

test('locked edge resize grows around the other axis center', () => {
  const b = { x: 200, y: 150, w: 300, h: 150 };
  const e = resizeBox(b, 'e', 100, 0, img, 2);
  near(e.w, 400);
  near(e.h, 200);
  near(e.y + e.h / 2, 225);
  const s = resizeBox(b, 's', 0, 50, img, 2);
  near(s.h, 200);
  near(s.w, 400);
  near(s.x + s.w / 2, 350);
  inside(s);
});

test('locked resize cannot leave the image whatever the drag', () => {
  for (const handle of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
    for (const [dx, dy] of [[9999, 9999], [-9999, -9999], [9999, -9999], [-9999, 9999]]) {
      for (const ratio of [1, 340 / 110, 0.4]) {
        const r = resizeBox(fitBox(img, ratio), handle, dx, dy, img, ratio);
        inside(r);
        near(r.w / r.h, ratio);
      }
    }
  }
});

test('boxToSource rounds to integer pixels inside the image', () => {
  assert.deepEqual(boxToSource({ x: 10.4, y: 20.6, w: 99.5, h: 50.2 }, img), { x: 10, y: 21, w: 100, h: 50 });
  const edge = boxToSource({ x: 999.9, y: 599.9, w: 500, h: 500 }, img);
  assert.ok(edge.x + edge.w <= img.w && edge.y + edge.h <= img.h && edge.w >= 1);
});

test('outputSize only scales down and keeps the aspect', () => {
  assert.deepEqual(outputSize(2000, 1000, 680, 680), { w: 680, h: 340 });
  assert.deepEqual(outputSize(300, 200, 680, 680), { w: 300, h: 200 });
  assert.deepEqual(outputSize(1024, 1024, 512, 512), { w: 512, h: 512 });
});

test('outputType keeps PNG lossless and defaults others sensibly', () => {
  assert.equal(outputType('image/png').type, 'image/png');
  assert.equal(outputType('image/gif').type, 'image/png');
  assert.equal(outputType('image/webp').ext, 'webp');
  assert.equal(outputType('image/jpeg').ext, 'jpg');
  assert.equal(outputType('image/bmp').type, 'image/jpeg');
});

test('specs carry the displayed ratios', () => {
  assert.equal(CROP_SPECS.avatar.ratio, 1);
  near(CROP_SPECS.banner.ratio, 340 / 110);
  near(CROP_SPECS.card.ratio, 340 / 200);
});
