'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { singleLine, statusEmoji } = require('../lib/textSanitize');

test('singleLine strips embedded newlines/control chars so a name cannot fake a second UI line', () => {
  assert.equal(singleLine('evil\nline two'), 'evil line two');
  assert.equal(singleLine('a\r\nb\tc'), 'a b c');
  assert.equal(singleLine('a\x00b\x1fc\x7fd'), 'a b c d');
});

test('singleLine collapses runs of whitespace left by stripped control chars', () => {
  assert.equal(singleLine('a\n\n\nb'), 'a b');
});

test('singleLine trims and truncates like the plain-text fields it replaces', () => {
  assert.equal(singleLine('  padded  '), 'padded');
  assert.equal(singleLine('x'.repeat(100), 10), 'x'.repeat(10));
});

test('singleLine reduces a control-characters-only value to empty, same as an all-whitespace one', () => {
  assert.equal(singleLine('\x01\x02\x03'), '');
  assert.equal(singleLine('   '), '');
});

test('singleLine handles null/undefined/non-string input without throwing', () => {
  assert.equal(singleLine(undefined), '');
  assert.equal(singleLine(null), '');
  assert.equal(singleLine(42), '42');
});

test('statusEmoji keeps one standard emoji, including ZWJ/flag/keycap sequences', () => {
  assert.equal(statusEmoji('🎮'), '🎮');
  assert.equal(statusEmoji('👨‍👩‍👧‍👦'), '👨‍👩‍👧‍👦');
  assert.equal(statusEmoji('🇭🇺'), '🇭🇺');
  assert.equal(statusEmoji('👍🏽'), '👍🏽');
  assert.equal(statusEmoji('1️⃣'), '1️⃣');
});

test('statusEmoji rejects custom-emoji shortcodes, text and multiple emoji', () => {
  assert.equal(statusEmoji(':party_parrot:'), '');
  assert.equal(statusEmoji('hi'), '');
  assert.equal(statusEmoji('🎮🎧'), '');
  assert.equal(statusEmoji(''), '');
  assert.equal(statusEmoji(undefined), '');
});
