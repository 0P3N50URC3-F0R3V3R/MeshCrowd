'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { makeIcon, decode, PngError } = require('../lib/pngResize');
const { makePng, noise, chunk } = require('./pngFixture');

test('a large photo-like PNG is shrunk to fit 128x128 and 16 KB, keeping the aspect ratio', () => {
  const out = makeIcon(makePng(400, 300));
  const img = decode(out);
  assert.equal(img.width, 128);
  assert.equal(img.height, 96);
  assert.ok(out.length <= 16384, String(out.length));
});

test('an already small PNG keeps its size', () => {
  const img = decode(makeIcon(makePng(64, 64)));
  assert.equal(img.width, 64);
  assert.equal(img.height, 64);
});

test('incompressible noise is shrunk further until it fits in 16 KB', () => {
  const out = makeIcon(makePng(1024, 1024, { pixel: noise }));
  const img = decode(out);
  assert.ok(out.length <= 16384, String(out.length));
  assert.ok(img.width <= 128 && img.height <= 128);
});

test('palette, grey-less RGB and 16-bit PNGs are decoded correctly', () => {
  const pal = decode(makePng(4, 2, { color: 3, depth: 4, palette: [[255, 0, 0], [0, 255, 0], [0, 0, 255]], pixel: (x) => [x % 3, 0, 0, 0] }));
  assert.deepEqual([...pal.rgba.subarray(0, 4)], [255, 0, 0, 255]);
  assert.deepEqual([...pal.rgba.subarray(4, 8)], [0, 255, 0, 255]);
  assert.deepEqual([...pal.rgba.subarray(8, 12)], [0, 0, 255, 255]);
  const rgb = decode(makePng(3, 3, { color: 2, pixel: () => [10, 20, 30, 255] }));
  assert.deepEqual([...rgb.rgba.subarray(0, 4)], [10, 20, 30, 255]);
  const deep = decode(makePng(3, 3, { color: 6, depth: 16, pixel: () => [200, 100, 50, 128] }));
  assert.deepEqual([...deep.rgba.subarray(0, 4)], [200, 100, 50, 128]);
});

test('transparency is kept and does not bleed colour', () => {
  const src = makePng(256, 256, { pixel: (x, y) => (x < 128 ? [255, 0, 0, 255] : [0, 255, 0, 0]) });
  const img = decode(makeIcon(src));
  const left = img.rgba.subarray(0, 4);
  const right = img.rgba.subarray((img.width - 1) * 4, img.width * 4);
  assert.deepEqual([...left], [255, 0, 0, 255]);
  assert.equal(right[3], 0);
});

test('metadata chunks are dropped from the result', () => {
  const out = makeIcon(makePng(40, 40, { extra: [['tEXt', Buffer.from('Comment\0secret location 12.34,56.78')]] }));
  assert.equal(out.includes(Buffer.from('secret location')), false);
});

test('interlaced, truncated, corrupt, non-PNG and oversized inputs are refused with a clear status', () => {
  const code = (fn) => { try { fn(); } catch (e) { return e instanceof PngError ? e.status : 'other'; } return 'accepted'; };
  assert.equal(code(() => makeIcon(makePng(10, 10, { interlace: 1 }))), 400);
  assert.equal(code(() => makeIcon(makePng(10, 10).subarray(0, 40))), 400);
  const bad = makePng(10, 10);
  bad[bad.length - 20] ^= 0xff;
  assert.equal(code(() => makeIcon(bad)), 400);
  assert.equal(code(() => makeIcon(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))), 400);
  assert.equal(code(() => makeIcon(Buffer.from('<html>'))), 400);
  const huge = Buffer.from(makePng(10, 10));
  huge.writeUInt32BE(5000, 16);
  const fix = (b) => { b.writeUInt32BE(zlib.crc32(b.subarray(12, 29)) >>> 0, 29); return b; };
  assert.equal(code(() => makeIcon(fix(huge))), 413);
});

test('a decompression bomb is refused instead of expanded', () => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(8, 0); ihdr.writeUInt32BE(8, 4); ihdr[8] = 8; ihdr[9] = 6;
  const bomb = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.alloc(50_000_000), { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
  assert.throws(() => makeIcon(bomb), { status: 400 });
});
