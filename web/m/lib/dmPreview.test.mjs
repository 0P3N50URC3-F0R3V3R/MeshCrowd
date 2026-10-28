import test from 'node:test';
import assert from 'node:assert/strict';
import { dmPreview, dmTitle, messageText } from './dmPreview.mjs';

const labels = { encryptedLabel: 'Encrypted message', attachmentLabel: 'Sent an attachment' };

test('plain messages show their text, attachment-only messages show the attachment label', () => {
  assert.equal(dmPreview({ lastMessage: { id: 1, content: 'hi' } }, { peek: () => null, ...labels }), 'hi');
  assert.equal(dmPreview({ lastMessage: { id: 1, content: '', attachments: [{}] } }, { peek: () => null, ...labels }), 'Sent an attachment');
  assert.equal(dmPreview({ lastMessage: null }, { peek: () => null, ...labels }), '');
});

test('encrypted messages show cached plaintext or the generic label, never the ciphertext', () => {
  const dm = { lastMessage: { id: 7, isEncrypted: true, content: 'v1:AAAA-ciphertext' } };
  assert.equal(dmPreview(dm, { peek: (id) => (id === 7 ? { text: 'secret hello' } : null), ...labels }), 'secret hello');
  assert.equal(dmPreview(dm, { peek: () => null, ...labels }), 'Encrypted message');
});

test('dmTitle: group name, else joined member names; 1:1 uses the other member', () => {
  const nameFor = (u) => u.displayName;
  assert.equal(dmTitle({ isGroup: true, name: 'Crew', members: [] }, nameFor), 'Crew');
  assert.equal(dmTitle({ isGroup: true, name: '', members: [{ displayName: 'A' }, { displayName: 'B' }] }, nameFor), 'A, B');
  assert.equal(dmTitle({ isGroup: false, members: [{ displayName: 'Zed' }] }, nameFor), 'Zed');
});

test('messageText never returns ciphertext: encrypted messages need decryptFailed === false', () => {
  const fail = 'cannot decrypt';
  assert.equal(messageText({ content: 'hi' }, fail), 'hi');
  assert.equal(messageText({ content: '', attachments: [] }, fail), '');
  assert.equal(messageText({ isEncrypted: true, decryptFailed: false, content: 'plain' }, fail), 'plain');
  assert.equal(messageText({ isEncrypted: true, decryptFailed: true, content: 'v1:CIPHER' }, fail), fail);
  assert.equal(messageText({ isEncrypted: true, decryptFailed: undefined, content: 'v1:CIPHER' }, fail), fail);
});
