import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMessageContent, renderCompactSticker, avatarHtml, colorForId } from './utils.js';
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

test('compact sticker renders an escaped image, or nothing', () => {
  assert.equal(renderCompactSticker(null, 'x'), '');
  const html = renderCompactSticker({ name: 'a"b', imagePath: '/uploads/stickers/x.png' }, 'sr-attachments');
  assert.match(html, /^<div class="sr-attachments"><img class="compact-sticker" src="\/uploads\/stickers\/x\.png"/);
  assert.ok(!html.includes('a"b'));
});

test('uploaded avatar picture has no background color unless avatarBackground is on', () => {
  const user = { id: 3, username: 'a', displayName: 'A', avatarPath: '/uploads/avatars/x.png' };
  assert.doesNotMatch(avatarHtml(user, 40), /background/);
  assert.doesNotMatch(avatarHtml({ ...user, avatarBackground: false }, 40), /background/);
  assert.match(avatarHtml({ ...user, avatarBackground: true }, 40), new RegExp(`background:${colorForId(3)}`));
});

test('avatar without a picture keeps the colored initial circle regardless of avatarBackground', () => {
  const user = { id: 3, username: 'a', displayName: 'Anna Bo' };
  for (const avatarBackground of [undefined, false, true]) {
    const html = avatarHtml({ ...user, avatarBackground }, 40);
    assert.match(html, new RegExp(`background:${colorForId(3)}`));
    assert.match(html, />AB</);
  }
});
