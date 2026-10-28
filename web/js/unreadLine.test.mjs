import test from 'node:test';
import assert from 'node:assert/strict';
import { unreadPrefs, firstUnreadIndex, anchorIndex, UNREAD_DEFAULTS } from './unreadLine.mjs';

const m = (id, author = 2, extra = {}) => ({ id, author: { id: author }, ...extra });
const own = (msg) => msg.author.id === 1;

test('unreadPrefs fills defaults and lets stored values win', () => {
  assert.deepEqual(unreadPrefs(undefined), UNREAD_DEFAULTS);
  assert.equal(unreadPrefs({ unreadContext: 0 }).unreadContext, 0);
  assert.equal(unreadPrefs({ unreadContext: 0 }).initialMessages, 50);
});

test('firstUnreadIndex finds the first foreign message after the pointer', () => {
  const list = [m(1), m(2), m(3, 1), m(4), m(5)];
  assert.equal(firstUnreadIndex(list, 2, own), 3);
  assert.equal(firstUnreadIndex(list, 5, own), -1);
});

test('firstUnreadIndex ignores a never-read scope, own, pending and event messages', () => {
  assert.equal(firstUnreadIndex([m(1), m(2)], 0, own), -1);
  assert.equal(firstUnreadIndex([m(3, 1), m(4, 2, { pending: true }), m(5, 2, { eventType: 'member_join' })], 2, own), -1);
});

test('anchorIndex keeps context messages above the line and never goes negative', () => {
  assert.equal(anchorIndex(10, 5), 5);
  assert.equal(anchorIndex(2, 5), 0);
  assert.equal(anchorIndex(10, 0), 10);
});
