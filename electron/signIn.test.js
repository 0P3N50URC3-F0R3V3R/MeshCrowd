'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldAsk, needsSessionConversion, sessionOrigins } = require('./signIn');

const entry = (signIn) => ({ url: 'https://a.example.com', name: 'A', icon: '', lastUsed: 1, signIn });

test('asks only when never asked and a session cookie exists', () => {
  assert.equal(shouldAsk(entry(null), true), true);
  assert.equal(shouldAsk(entry(null), false), false);
  assert.equal(shouldAsk(entry('keep'), true), false);
  assert.equal(shouldAsk(entry('session'), true), false);
  assert.equal(shouldAsk(undefined, true), false);
});

test('only a persistent cookie of a session-only server is converted', () => {
  assert.equal(needsSessionConversion(entry('session'), { session: false }), true);
  assert.equal(needsSessionConversion(entry('session'), { session: true }), false);
  assert.equal(needsSessionConversion(entry('keep'), { session: false }), false);
  assert.equal(needsSessionConversion(entry(null), { session: false }), false);
  assert.equal(needsSessionConversion(entry('session'), null), false);
});

test('sessionOrigins lists exactly the session-only servers', () => {
  const list = [{ ...entry('session'), url: 'https://s1.example.com' }, entry('keep'), { ...entry('session'), url: 'https://s2.example.com' }, entry(null)];
  assert.deepEqual(sessionOrigins(list), ['https://s1.example.com', 'https://s2.example.com']);
});
