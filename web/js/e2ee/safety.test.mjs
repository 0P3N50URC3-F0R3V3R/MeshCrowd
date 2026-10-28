import test from 'node:test';
import assert from 'node:assert/strict';
import { safetyNumber } from './safety.mjs';

const key = (fill) => new Uint8Array(32).fill(fill);

test('known-answer vector', async () => {
  assert.equal(await safetyNumber(1, key(1), 2, key(2)), '63886 94611 87887 60642 05658 82596 34398 40020 07603 78705 54572 28705');
});

test('format is 12 groups of 5 digits', async () => {
  const n = await safetyNumber(7, key(3), 9, key(4));
  assert.match(n, /^\d{5}( \d{5}){11}$/);
});

test('identical on both sides regardless of argument order', async () => {
  const a = await safetyNumber(10, key(5), 3, key(6));
  const b = await safetyNumber(3, key(6), 10, key(5));
  assert.equal(a, b);
});

test('changes when either key or either id changes', async () => {
  const base = await safetyNumber(1, key(1), 2, key(2));
  const flipped = key(2);
  flipped[31] ^= 1;
  assert.notEqual(await safetyNumber(1, key(1), 2, flipped), base);
  assert.notEqual(await safetyNumber(1, flipped, 2, key(2)), base);
  assert.notEqual(await safetyNumber(1, key(1), 3, key(2)), base);
  assert.notEqual(await safetyNumber(4, key(1), 2, key(2)), base);
});

test('binding of ids to keys: swapping keys between users changes the number', async () => {
  assert.notEqual(await safetyNumber(1, key(1), 2, key(2)), await safetyNumber(1, key(2), 2, key(1)));
});

test('id boundaries are unambiguous', async () => {
  assert.notEqual(await safetyNumber(1, key(1), 23, key(2)), await safetyNumber(12, key(1), 3, key(2)));
});

test('digits are not visibly skewed', async () => {
  const counts = new Array(10).fill(0);
  for (let i = 1; i <= 40; i += 1) {
    for (const ch of (await safetyNumber(1, key(i), 2, key(200 - i))).replaceAll(' ', '')) counts[Number(ch)] += 1;
  }
  for (const c of counts) assert.ok(c > 140 && c < 340, `digit count ${c} out of range`);
});
