'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { displayName } = require('../lib/textSanitize');

const ch = (...cps) => String.fromCodePoint(...cps);

test('keeps every script, emoji and symbol', () => {
  for (const name of ['Zoë', ch(0x65e5, 0x672c, 0x8a9e), ch(0x1f600, 0x200d, 0x1f525), 'Ünï', 'a-b_c.d', ch(0x2764, 0xfe0f) + ' ok']) {
    assert.equal(displayName(name), name);
  }
});

test('drops control, invisible and direction-changing characters', () => {
  assert.equal(displayName('a' + ch(0x200b) + 'b'), 'a b');
  assert.equal(displayName('x' + ch(0x202e) + 'y'), 'x y');
  assert.equal(displayName(ch(0, 1, 0x7f) + 'name'), 'name');
  assert.equal(displayName('line1\nline2\tx'), 'line1 line2 x');
  assert.equal(displayName(ch(0x2800, 0x3164)), '');
  assert.equal(displayName(ch(0xfeff) + 'bom'), 'bom');
  assert.equal(displayName(ch(0xe0067) + 'tag'), 'tag');
  assert.equal(displayName('pua' + ch(0xe000)), 'pua');
});

test('lone surrogates are removed, pairs kept', () => {
  assert.equal(displayName('a' + ch(0xd83d) + 'b'), 'a b');
  assert.equal(displayName(ch(0x1f600)), ch(0x1f600));
});

test('stacked combining marks are capped', () => {
  assert.equal(displayName('x' + ch(0x300, 0x301, 0x302, 0x303, 0x304) + 'y'), 'x' + ch(0x300, 0x301, 0x302) + 'y');
});

test('length counts characters, never splitting an emoji', () => {
  assert.equal(Array.from(displayName('a'.repeat(50))).length, 32);
  const smileys = ch(0x1f600).repeat(40);
  assert.equal(displayName(smileys), ch(0x1f600).repeat(32));
});

test('blank input stays blank so callers can reject it', () => {
  assert.equal(displayName('   '), '');
  assert.equal(displayName(null), '');
});
