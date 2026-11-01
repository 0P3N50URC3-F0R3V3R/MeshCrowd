import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { state, setReadState, setReadStateBulk, upsertDmPreview, applyDmRead, getUnreadDmCount, getGlobalUnreadCount, setDmPref } from './state.js';

beforeEach(() => {
  state.me = { id: 1 };
  state.dms = [{ id: 10, members: [], lastMessage: { id: 5 }, readStates: [] }, { id: 11, members: [], lastMessage: { id: 9 }, readStates: [] }];
  state.dmPrefs = new Map();
  state.serverDetail = new Map();
  state.friends = { friends: [], pending: [], blocked: [] };
  setReadStateBulk([]);
});

test('read pointer clears the DM badge and a stale older preview does not re-set it', () => {
  assert.equal(getUnreadDmCount(), 2);
  setReadState('dm', 10, 5);
  setReadState('dm', 11, 9);
  assert.equal(getUnreadDmCount(), 0);
  upsertDmPreview(10, { id: 4 });
  assert.equal(getUnreadDmCount(), 0);
});

test('a read made on another device of the same user clears the badge', () => {
  applyDmRead(10, 1, 5);
  assert.equal(getUnreadDmCount(), 1);
  assert.equal(getGlobalUnreadCount(), 1);
});

test('another member reading only updates their reader pointer', () => {
  applyDmRead(10, 2, 5);
  assert.equal(getUnreadDmCount(), 2);
  assert.deepEqual(state.dms[0].readStates, [{ userId: 2, lastReadMessageId: 5 }]);
});

test('a closed (hidden) conversation never keeps the badge on', () => {
  setDmPref({ dmId: 10, pinned: false, favorite: false, hidden: true });
  assert.equal(getUnreadDmCount(), 1);
});
