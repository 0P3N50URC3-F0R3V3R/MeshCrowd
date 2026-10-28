import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMessageContent } from './utils.js';
import { SHRUG } from './builtinSlash.js';

test('shrug renders with its underscores intact', () => {
  assert.equal(renderMessageContent(SHRUG), '¯\\_(ツ)_/¯');
});

test('backslash makes markdown characters literal', () => {
  assert.equal(renderMessageContent('\\*not bold\\*'), '*not bold*');
  assert.equal(renderMessageContent('\\_a\\_'), '_a_');
});

test('unescaped markdown and plain backslashes are unchanged', () => {
  assert.equal(renderMessageContent('_a_'), '<em>a</em>');
  assert.equal(renderMessageContent('C:\\dir\\file'), 'C:\\dir\\file');
});
