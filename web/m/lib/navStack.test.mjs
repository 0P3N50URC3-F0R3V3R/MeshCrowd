import test from 'node:test';
import assert from 'node:assert/strict';
import { createNavStack, popAction } from './navStack.mjs';

test('push/pop keeps depth and emits events', () => {
  const s = createNavStack({ name: 'tab' });
  const seen = [];
  s.subscribe((e) => seen.push([e.kind, e.depth, e.top.name]));
  s.push({ name: 'chat' });
  s.push({ name: 'thread' });
  assert.equal(s.depth(), 3);
  assert.equal(s.pop(), true);
  assert.deepEqual(seen, [['push', 2, 'chat'], ['push', 3, 'thread'], ['pop', 2, 'chat']]);
});

test('pop at the root is refused; popTo trims to a depth; reset replaces everything', () => {
  const s = createNavStack({ name: 'tab' });
  assert.equal(s.pop(), false);
  s.push({ name: 'a' }); s.push({ name: 'b' }); s.push({ name: 'c' });
  assert.equal(s.popTo(2), true);
  assert.equal(s.top().name, 'a');
  assert.equal(s.popTo(5), false);
  assert.equal(s.popTo(0), false);
  s.reset({ name: 'tab2' });
  assert.equal(s.depth(), 1);
  assert.equal(s.top().name, 'tab2');
});

test('replace swaps the top only', () => {
  const s = createNavStack({ name: 'tab' });
  s.push({ name: 'a' });
  s.replace({ name: 'b' });
  assert.equal(s.depth(), 2);
  assert.equal(s.top().name, 'b');
});

test('popAction: an open sheet always wins; d0 recovers a deeper stack instead of getting stuck', () => {
  assert.equal(popAction({ d: 1, depth: 3, sheetOpen: true }), 'closeSheet');
  assert.equal(popAction({ d: 0, depth: 1, sheetOpen: false }), 'exit');
  assert.equal(popAction({ d: 0, depth: 3, sheetOpen: false }), 'recover');
  assert.equal(popAction({ d: 1, depth: 3, sheetOpen: false }), 'popTo');
  assert.equal(popAction({ d: 3, depth: 3, sheetOpen: false }), 'none');
  assert.equal(popAction({ d: 4, depth: 3, sheetOpen: false }), 'none');
});
