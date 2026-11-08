'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { safeName, uniquePath, normalizeDir } = require('./downloads');

test('safeName strips path parts and illegal characters', () => {
  assert.strictEqual(safeName('../../evil.exe'), 'evil.exe');
  assert.strictEqual(safeName('a<b?c.txt'), 'a_b_c.txt');
  assert.strictEqual(safeName(''), 'download');
  assert.strictEqual(safeName('name. '), 'name');
});

test('uniquePath appends a counter before the extension', () => {
  const taken = new Set([path.join('d', 'a.txt'), path.join('d', 'a (1).txt')]);
  assert.strictEqual(uniquePath('d', 'a.txt', (p) => taken.has(p)), path.join('d', 'a (2).txt'));
  assert.strictEqual(uniquePath('d', 'b.txt', () => false), path.join('d', 'b.txt'));
});

test('normalizeDir only accepts absolute paths', () => {
  assert.strictEqual(normalizeDir('relative/dir'), null);
  assert.strictEqual(normalizeDir(5), null);
  assert.strictEqual(normalizeDir('   '), null);
  const abs = path.resolve('some', 'dir');
  assert.strictEqual(normalizeDir(`  ${abs}  `), abs);
});
