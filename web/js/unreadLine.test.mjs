import test from 'node:test';
import assert from 'node:assert/strict';
import { unreadPrefs, firstUnreadIndex, anchorIndex, unreadEligible, unreadCount, UNREAD_DEFAULTS } from './unreadLine.mjs';

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

const at = (id, ts) => m(id, 2, { createdAt: new Date(ts).toISOString() });
const OFF = [[1000, 2000]];

test('default: only messages that arrived while offline get the line', () => {
  const list = [at(1, 500), at(2, 900), at(3, 1500), at(4, 1800)];
  const ok = unreadEligible({ upToId: 4, always: false, windows: OFF });
  assert.equal(firstUnreadIndex(list, 1, own, ok), 2);
  assert.equal(unreadCount(list, 1, own, ok), 2);
});

test('online arrival in another channel gets no line by default', () => {
  const list = [at(1, 500), at(2, 3000)];
  assert.equal(firstUnreadIndex(list, 1, own, unreadEligible({ upToId: 2, always: false, windows: OFF })), -1);
});

test('always setting restores line for any unread message', () => {
  const list = [at(1, 500), at(2, 3000)];
  assert.equal(firstUnreadIndex(list, 1, own, unreadEligible({ upToId: 2, always: true, windows: OFF })), 1);
});

test('messages arriving while the chat is open (past upToId) never get a line', () => {
  const list = [at(1, 500), at(2, 1500), at(3, 1600)];
  const ok = unreadEligible({ upToId: 2, always: true, windows: OFF });
  assert.equal(firstUnreadIndex(list, 2, own, ok), -1);
  assert.equal(unreadCount(list, 1, own, ok), 1);
});

test('clearing the pointer (bottom reached) removes the line', () => {
  const list = [at(1, 1100), at(2, 1200)];
  assert.equal(firstUnreadIndex(list, 0, own, unreadEligible({ upToId: 2, always: true, windows: OFF })), -1);
});
