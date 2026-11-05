import test from 'node:test';
import assert from 'node:assert/strict';
import { gridAllows } from './notifyGrid.mjs';

const grid = {
  online: { dmMessage: { sound: true, popup: true, tray: true, android: true } },
  dnd: { dmMessage: { sound: false, popup: true, tray: false, android: true } },
};

test('allowed when the server sent no grid (older server)', () => {
  assert.equal(gridAllows({ status: 'dnd' }, 'dmMessage', 'sound'), true);
  assert.equal(gridAllows(null, 'dmMessage', 'sound'), true);
});

test('each surface follows its own cell for the current status', () => {
  const me = { status: 'dnd', notifyGrid: grid };
  assert.equal(gridAllows(me, 'dmMessage', 'sound'), false);
  assert.equal(gridAllows(me, 'dmMessage', 'popup'), true);
  assert.equal(gridAllows(me, 'dmMessage', 'tray'), false);
});

test('a missing status counts as online', () => {
  assert.equal(gridAllows({ notifyGrid: grid }, 'dmMessage', 'sound'), true);
});

test('an unknown event or status never silences anything', () => {
  assert.equal(gridAllows({ status: 'dnd', notifyGrid: grid }, 'somethingNew', 'sound'), true);
  assert.equal(gridAllows({ status: 'weird', notifyGrid: grid }, 'dmMessage', 'sound'), true);
  assert.equal(gridAllows({ status: 'dnd', notifyGrid: grid }, undefined, 'sound'), true);
});
