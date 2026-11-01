import test from 'node:test';
import assert from 'node:assert/strict';
import { keysToClear, notifyKey } from './notifyClear.mjs';

const base = { globalCount: 3, focused: true, isViewing: () => false, status: () => 'unread' };

test('notifyKey joins scope type and id', () => {
  assert.equal(notifyKey({ scopeType: 'dm', scopeId: 7 }), 'dm:7');
});

test('everything clears when nothing is unread', () => {
  assert.deepEqual(keysToClear(['dm:1', 'channel:2'], { ...base, globalCount: 0 }), ['dm:1', 'channel:2']);
});

test('keeps still-unread scopes', () => {
  assert.deepEqual(keysToClear(['dm:1', 'channel:2'], base), []);
});

test('clears the scope being viewed only while focused', () => {
  const isViewing = (k) => k === 'dm:1';
  assert.deepEqual(keysToClear(['dm:1', 'channel:2'], { ...base, isViewing }), ['dm:1']);
  assert.deepEqual(keysToClear(['dm:1'], { ...base, isViewing, focused: false }), []);
});

test('clears scopes that were read elsewhere, keeps unknown ones', () => {
  const status = (k) => (k === 'dm:1' ? 'read' : k === 'thread:9' ? 'unknown' : 'unread');
  assert.deepEqual(keysToClear(['dm:1', 'thread:9', 'channel:2'], { ...base, status }), ['dm:1']);
});
