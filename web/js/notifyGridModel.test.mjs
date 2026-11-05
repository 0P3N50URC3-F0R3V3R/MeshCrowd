import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { STATUSES, EVENTS, SURFACES, NOT_APPLICABLE, defaultsGrid, isStatusModified, copyStatusPatch } from './notifyGridModel.mjs';

const server = createRequire(import.meta.url)('../../server/lib/notifyGrid.js');

test('the editor and the server agree on statuses, events, surfaces, n/a cells and defaults', () => {
  assert.deepEqual(STATUSES, server.STATUSES);
  assert.deepEqual(EVENTS, server.EVENTS);
  assert.deepEqual(SURFACES, server.SURFACES);
  assert.deepEqual(NOT_APPLICABLE, server.NOT_APPLICABLE);
  assert.deepEqual(defaultsGrid(), server.defaults());
});

test('a status counts as modified only when a cell differs from its defaults', () => {
  const grid = defaultsGrid();
  assert.equal(isStatusModified(grid, 'online'), false);
  grid.online.call.sound = false;
  assert.equal(isStatusModified(grid, 'online'), true);
  assert.equal(isStatusModified(grid, 'idle'), false);
});

test('copying a status builds a patch of every applicable cell and leaves the source alone', () => {
  const grid = defaultsGrid();
  grid.dnd.dmMention.sound = true;
  const patch = copyStatusPatch(grid, 'dnd', 'idle');
  assert.deepEqual(Object.keys(patch), ['idle']);
  assert.equal(patch.idle.dmMention.sound, true);
  assert.equal(patch.idle.call.android, undefined, 'not applicable cells are never sent');
  assert.equal(patch.idle.dmMessage.sound, false);
  assert.doesNotThrow(() => server.validate(patch));
});
