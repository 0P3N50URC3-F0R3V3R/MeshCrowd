'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../lib/passportChallenges');

test.beforeEach(() => c._resetForTests());

test('issue returns a fresh nonce bound to the origin and consume works exactly once', () => {
  const ch = c.issue('https://a.example');
  assert.equal(ch.origin, 'https://a.example');
  assert.match(ch.nonce, /^[0-9a-f]{64}$/);
  assert.equal(c.consume(ch.nonce, ch.issuedAt, 'https://a.example'), true);
  assert.equal(c.consume(ch.nonce, ch.issuedAt, 'https://a.example'), false);
});

test('consume rejects unknown nonces, mismatching issuedAt and expired challenges', () => {
  const ch = c.issue('o');
  assert.equal(c.consume('0'.repeat(64), ch.issuedAt, 'o'), false);
  assert.equal(c.consume(ch.nonce, '2000-01-01T00:00:00.000Z', 'o'), false);
  const old = c.issue('o');
  c._backdate(old.nonce, 61_000);
  assert.equal(c.consume(old.nonce, old.issuedAt, 'o'), false);
});

test('the store is capped so it cannot be used to exhaust memory', () => {
  const first = c.issue('o');
  for (let i = 0; i < 10_050; i++) c.issue('o');
  assert.ok(c._size() <= 10_000);
  assert.equal(c.consume(first.nonce, first.issuedAt, 'o'), false);
});

test('five failures lock a key for the lockout window, success clears them', () => {
  for (let i = 0; i < 4; i++) c.recordFailure('id:x');
  assert.equal(c.isLocked('id:x'), false);
  c.recordFailure('id:x');
  assert.equal(c.isLocked('id:x'), true);
  assert.equal(c.isLocked('id:other'), false);
  c.clearFailures('id:x');
  assert.equal(c.isLocked('id:x'), false);
});

test('sub-threshold failures age out after the window instead of accumulating forever', () => {
  for (let i = 0; i < 4; i++) c.recordFailure('id:slow');
  c._backdateFailure('id:slow', 16 * 60_000);
  c.recordFailure('id:slow');
  assert.equal(c.isLocked('id:slow'), false);
  for (let i = 0; i < 3; i++) c.recordFailure('id:slow');
  assert.equal(c.isLocked('id:slow'), false);
  c.recordFailure('id:slow');
  assert.equal(c.isLocked('id:slow'), true);
});

test('the failure map is capped', () => {
  for (let i = 0; i < 10_050; i++) c.recordFailure(`id:${i}`);
  assert.ok(c._failureCount() <= 10_000);
});

test('failures while locked do not extend the lock', () => {
  for (let i = 0; i < 5; i++) c.recordFailure('id:v');
  assert.equal(c.isLocked('id:v'), true);
  c._backdateFailure('id:v', 14 * 60_000);
  for (let i = 0; i < 20; i++) c.recordFailure('id:v');
  c._backdateFailure('id:v', 2 * 60_000);
  assert.equal(c.isLocked('id:v'), false);
});

test('a nonce issued for one origin is refused for another', () => {
  const ch = c.issue('https://a.example');
  assert.equal(c.consume(ch.nonce, ch.issuedAt, 'https://b.example'), false);
  assert.equal(c.consume(ch.nonce, ch.issuedAt, 'https://a.example'), false);
});
