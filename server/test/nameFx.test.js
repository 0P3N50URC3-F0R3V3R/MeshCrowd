'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanFx, validEffect, parseStored, EFFECTS } = require('../lib/nameFx');

test('cleanFx keeps valid colors (lower-cased) and speed', () => {
  assert.deepEqual(cleanFx({ colors: ['#FF0000', '#00ff00'], speed: 2.5 }), { colors: ['#ff0000', '#00ff00'], speed: 2.5 });
  assert.deepEqual(cleanFx(null), { colors: [], speed: 4 });
  assert.deepEqual(cleanFx({}), { colors: [], speed: 4 });
});

test('cleanFx rejects bad input', () => {
  assert.equal(cleanFx({ colors: ['red'] }), null);
  assert.equal(cleanFx({ colors: Array(6).fill('#ffffff') }), null);
  assert.equal(cleanFx({ speed: 0 }), null);
  assert.equal(cleanFx({ speed: 99 }), null);
  assert.equal(cleanFx([]), null);
  assert.equal(cleanFx('x'), null);
});

test('validEffect accepts the list and blank, nothing else', () => {
  for (const e of EFFECTS) assert.equal(validEffect(e), true);
  assert.equal(validEffect(''), true);
  assert.equal(validEffect('blink'), false);
});

test('parseStored survives garbage', () => {
  assert.deepEqual(parseStored('not json'), { colors: [], speed: 4 });
  assert.deepEqual(parseStored(JSON.stringify({ colors: ['#123456'], speed: 3 })), { colors: ['#123456'], speed: 3 });
});
