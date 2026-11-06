import test from 'node:test';
import assert from 'node:assert/strict';
import { stickerRef, normalizeSticker, previewText } from './stickers.mjs';

const good = { id: 7, name: 'wave_1', imagePath: '/uploads/stickers/0123456789abcdef0123.gif' };

test('stickerRef accepts picker rows and serialized stickers', () => {
  assert.deepEqual(stickerRef({ id: 7, name: 'wave_1', image_path: good.imagePath, description: 'x', server_id: 1 }), good);
  assert.deepEqual(stickerRef(good), good);
  assert.equal(stickerRef(null), null);
});

test('normalizeSticker keeps only well-formed references from a peer', () => {
  assert.deepEqual(normalizeSticker({ ...good, extra: 1 }), good);
  assert.equal(normalizeSticker(null), null);
  assert.equal(normalizeSticker('x'), null);
  assert.equal(normalizeSticker({ ...good, id: '7' }), null);
  assert.equal(normalizeSticker({ ...good, id: 0 }), null);
  assert.equal(normalizeSticker({ ...good, name: 'a b' }), null);
  assert.equal(normalizeSticker({ ...good, imagePath: 'https://evil.example/x.png' }), null);
  assert.equal(normalizeSticker({ ...good, imagePath: '/uploads/stickers/../../etc.png' }), null);
  assert.equal(normalizeSticker({ ...good, imagePath: '/uploads/stickers/0123456789abcdef0123.svg' }), null);
  assert.equal(normalizeSticker({ ...good, imagePath: '/uploads/avatars/0123456789abcdef0123.png' }), null);
});

test('previewText prefers text, then sticker, then attachment', () => {
  const labels = { sticker: 'Sent a sticker', attachment: 'Sent an attachment' };
  assert.equal(previewText({ text: 'hi', sticker: good, hasAttachments: true }, labels), 'hi');
  assert.equal(previewText({ text: '', sticker: good, hasAttachments: true }, labels), 'Sent a sticker');
  assert.equal(previewText({ text: '', sticker: null, hasAttachments: true }, labels), 'Sent an attachment');
  assert.equal(previewText({ text: '', sticker: null, hasAttachments: false }, labels), '');
});
