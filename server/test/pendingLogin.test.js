'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const pendingLogin = require('../lib/pendingLogin');

test('peek returns the userId repeatedly without consuming it', () => {
  const token = pendingLogin.create(42);
  assert.equal(pendingLogin.peek(token), 42, 'a wrong-code attempt (peek) must not burn the token');
  assert.equal(pendingLogin.peek(token), 42, 'peeking again must still work — this is what a mistyped 2FA code followed by the correct one relies on');
  pendingLogin.remove(token);
  assert.equal(pendingLogin.peek(token), null, 'remove() is what actually makes the token one-shot');
});

test('an unknown token peeks to null', () => {
  assert.equal(pendingLogin.peek('not-a-real-token'), null);
});

test('removing an already-removed or unknown token is a harmless no-op', () => {
  assert.doesNotThrow(() => pendingLogin.remove('not-a-real-token'));
  const token = pendingLogin.create(1);
  pendingLogin.remove(token);
  assert.doesNotThrow(() => pendingLogin.remove(token));
});

test('tokens are unique per call', () => {
  const a = pendingLogin.create(1);
  const b = pendingLogin.create(1);
  assert.notEqual(a, b);
  pendingLogin.remove(a);
  pendingLogin.remove(b);
});
