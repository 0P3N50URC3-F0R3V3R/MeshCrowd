import test from 'node:test';
import assert from 'node:assert/strict';
import { emojiFor, emojiForReaction } from './dmEmoji.mjs';

const list = [
  { id: 1, name: 'owl', image_path: '/a', userIds: [1] },
  { id: 2, name: 'OWL', image_path: '/b', userIds: [1, 2] },
  { id: 3, name: 'cat', image_path: '/c', userIds: [2] },
];

test('a message resolves against its author\'s own servers, first name wins', () => {
  assert.deepEqual(emojiFor(list, 1).map((e) => e.id), [1]);
  assert.deepEqual(emojiFor(list, 2).map((e) => e.id), [2, 3]);
  assert.deepEqual(emojiFor(list, 9), []);
});

test('a reaction resolves against the first reactor, then anyone in the conversation', () => {
  assert.deepEqual(emojiForReaction(list, { userIds: [2, 1] }).map((e) => e.id), [2, 3]);
  assert.deepEqual(emojiForReaction(list, { userIds: [9] }).map((e) => e.id), [1, 3]);
});
