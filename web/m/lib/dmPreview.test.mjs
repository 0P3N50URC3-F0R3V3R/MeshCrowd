import test from 'node:test';
import assert from 'node:assert/strict';
import { dmPreview, dmTitle } from './dmPreview.mjs';

const labels = { attachmentLabel: 'Sent an attachment', stickerLabel: 'Sent a sticker' };

test('plain messages show their text, attachment-only messages show the attachment label', () => {
  assert.equal(dmPreview({ lastMessage: { id: 1, content: 'hi' } }, labels), 'hi');
  assert.equal(dmPreview({ lastMessage: { id: 1, content: '', attachments: [{}] } }, labels), 'Sent an attachment');
  assert.equal(dmPreview({ lastMessage: null }, labels), '');
});

test('sticker-only messages show the sticker label', () => {
  assert.equal(dmPreview({ lastMessage: { id: 1, content: '', sticker: { id: 3 }, attachments: [] } }, labels), 'Sent a sticker');
});

test('dmTitle: group name, else joined member names; 1:1 uses the other member', () => {
  const nameFor = (u) => u.displayName;
  assert.equal(dmTitle({ isGroup: true, name: 'Crew', members: [] }, nameFor), 'Crew');
  assert.equal(dmTitle({ isGroup: true, name: '', members: [{ displayName: 'A' }, { displayName: 'B' }] }, nameFor), 'A, B');
  assert.equal(dmTitle({ isGroup: false, members: [{ displayName: 'Zed' }] }, nameFor), 'Zed');
});
