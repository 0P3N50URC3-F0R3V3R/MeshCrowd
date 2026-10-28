import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeMessages, applyUpdate, applyDelete, shouldCompact, reconcileLatest, dropMatchingPending, windowReachesLatest } from './messageList.mjs';

const m = (id, extra = {}) => ({ id, author: { id: 1 }, createdAt: `2026-01-01T00:0${id}:00Z`, content: `c${id}`, ...extra });

test('mergeMessages sorts ascending and existing ids win (no duplicates, no ciphertext overwrite)', () => {
  const list = [m(3, { content: 'plain', decryptFailed: false })];
  const out = mergeMessages(list, [m(1), m(3, { content: 'CIPHER', isEncrypted: true }), m(2)]);
  assert.deepEqual(out.map((x) => x.id), [1, 2, 3]);
  assert.equal(out[2].content, 'plain');
});

test('applyUpdate for an unknown id returns the same list; encrypted updates reset decryptFailed', () => {
  const list = [m(1, { decryptFailed: false })];
  assert.equal(applyUpdate(list, m(9)), list);
  const next = applyUpdate(list, m(1, { isEncrypted: true, content: 'CIPHER2' }));
  assert.equal(next[0].content, 'CIPHER2');
  assert.equal(next[0].decryptFailed, undefined);
  assert.equal(list[0].decryptFailed, false);
});

test('applyDelete removes by id and is a no-op for unknown ids', () => {
  const list = [m(1), m(2)];
  assert.deepEqual(applyDelete(list, 1).map((x) => x.id), [2]);
  assert.equal(applyDelete(list, 7), list);
});

test('shouldCompact groups same-author messages within 5 minutes only', () => {
  assert.equal(shouldCompact(m(1), m(2)), true);
  assert.equal(shouldCompact(m(1), { ...m(2), author: { id: 2 } }), false);
  assert.equal(shouldCompact(m(1), { ...m(2), createdAt: '2026-01-01T01:00:00Z' }), false);
  assert.equal(shouldCompact(m(1), m(2, { replyTo: { id: 1 } })), false);
  assert.equal(shouldCompact(m(1, { eventType: 'x' }), m(2)), false);
  assert.equal(shouldCompact(null, m(2)), false);
});

test('mergeMessages skips tombstoned ids so a delete that raced a create stays deleted', () => {
  const out = mergeMessages([m(1)], [m(2), m(3)], new Set([2]));
  assert.deepEqual(out.map((x) => x.id), [1, 3]);
});

test('reconcileLatest applies edits and deletes inside the fetched page and keeps older history', () => {
  const page = [m(5, { content: 'edited' }), m(7)]; // 6 was deleted while offline
  const list = [m(1), m(2), m(5), m(6), m(7)];
  const out = reconcileLatest(list, page, 2);
  assert.deepEqual(out.map((x) => x.id), [1, 2, 5, 7]);
  assert.equal(out.find((x) => x.id === 5).content, 'edited');
});

test('reconcileLatest resets to the page when the page is the whole history or leaves a gap', () => {
  assert.deepEqual(reconcileLatest([m(1), m(2)], [m(2)], 50).map((x) => x.id), [2]);
  assert.deepEqual(reconcileLatest([m(1), m(2)], [], 50), []);
  assert.deepEqual(reconcileLatest([m(1), m(2)], [m(8), m(9), m(10)], 3).map((x) => x.id), [8, 9, 10]);
});

test('dropMatchingPending removes the pending bubble for an own message that arrived first', () => {
  const pending = [{ key: 'a', text: 'hi' }, { key: 'b', text: 'other' }];
  const own = { author: { id: 1 }, content: 'hi' };
  assert.deepEqual(dropMatchingPending(pending, own, 1).map((p) => p.key), ['b']);
  assert.equal(dropMatchingPending(pending, own, 2), pending);
  assert.equal(dropMatchingPending(pending, { author: { id: 1 }, content: 'nope' }, 1), pending);
  assert.equal(dropMatchingPending([{ key: 'f', text: 'hi', failed: true }], own, 1).length, 1);
});

test('windowReachesLatest: an around-window with fewer than half a page after the target ends at the newest message', () => {
  const ids = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => m(a + i));
  assert.equal(windowReachesLatest(ids(1, 30), 28, 50), true); // only 2 newer
  assert.equal(windowReachesLatest(ids(1, 50), 10, 50), false); // 40 newer, more probably exist
  assert.equal(windowReachesLatest(ids(1, 30), 30, 50), true);
  assert.equal(windowReachesLatest([], 5, 50), true);
});
