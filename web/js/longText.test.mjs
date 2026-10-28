import test from 'node:test';
import assert from 'node:assert/strict';
import { safeTextFileName, textByteLength, MAX_TEXT_FILE_BYTES } from './longText.js';

test('safeTextFileName generates a name when none given', () => {
  assert.equal(safeTextFileName('', () => 'abc123'), 'message-abc123.txt');
  assert.equal(safeTextFileName('   ', () => 'zz'), 'message-zz.txt');
});

test('safeTextFileName strips paths and odd characters and forces a text extension', () => {
  assert.equal(safeTextFileName('readme'), 'readme.txt');
  assert.equal(safeTextFileName('README.md'), 'README.md');
  assert.equal(safeTextFileName('../../etc/passwd'), 'passwd.txt');
  assert.equal(safeTextFileName('evil.html'), 'evil.html.txt');
  assert.equal(safeTextFileName('a b<c>.exe'), 'a_b_c_.exe.txt');
  assert.equal(safeTextFileName('.hidden'), 'hidden.txt');
});

test('textByteLength counts UTF-8 bytes', () => {
  assert.equal(textByteLength('aé'), 3);
  assert.equal(MAX_TEXT_FILE_BYTES, 307200);
});
