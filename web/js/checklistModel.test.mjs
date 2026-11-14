import test from 'node:test';
import assert from 'node:assert/strict';
import { checklistLevel, checklistProgress, moveRow } from './checklistModel.mjs';

const cl = { creatorId: 1, editors: [{ userId: 2, level: 'check' }, { userId: 3, level: 'edit' }], items: [{ checked: true }, { checked: false }] };

test('levels: creator and edit helper edit, check helper ticks, stranger nothing', () => {
  assert.equal(checklistLevel(cl, 1), 'edit');
  assert.equal(checklistLevel(cl, 2), 'check');
  assert.equal(checklistLevel(cl, 3), 'edit');
  assert.equal(checklistLevel(cl, 9), null);
  assert.equal(checklistLevel(null, 1), null);
});

test('progress counts checked items', () => {
  assert.deepEqual(checklistProgress(cl), { done: 1, total: 2 });
});

test('moveRow swaps neighbours and ignores moves off either end', () => {
  assert.deepEqual(moveRow([1, 2, 3], 0, 1), [2, 1, 3]);
  assert.deepEqual(moveRow([1, 2, 3], 0, -1), [1, 2, 3]);
  assert.deepEqual(moveRow([1, 2, 3], 2, 1), [1, 2, 3]);
});
