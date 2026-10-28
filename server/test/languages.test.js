'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeCode, validateLanguageJson, diffKeys } = require('../lib/languages');

test('accepts a lowercase 2-8 letter code', () => {
  assert.equal(sanitizeCode('en'), 'en');
  assert.equal(sanitizeCode('hu'), 'hu');
  assert.equal(sanitizeCode('abcdefgh'), 'abcdefgh');
});

test('rejects path traversal and non-slug codes', () => {
  const attempts = ['../../server/index', '..', 'en/../../etc', 'EN', 'e n', '', null, undefined, 42, 'toolongcodexx', 'e1'];
  for (const value of attempts) {
    assert.equal(sanitizeCode(value), null, `expected "${JSON.stringify(value)}" to be rejected`);
  }
});

test('validates a well-formed nested translation object', () => {
  const result = validateLanguageJson({ common: { save: 'Save', cancel: 'Cancel' }, auth: { loginTitle: 'Sign in' } });
  assert.equal(result.ok, true);
  assert.deepEqual([...result.keys].sort(), ['auth.loginTitle', 'common.cancel', 'common.save']);
});

test('rejects a top-level non-object', () => {
  for (const bad of [null, 'text', 42, ['a'], true]) {
    assert.equal(validateLanguageJson(bad).ok, false);
  }
});

test('rejects an array used as a namespace', () => {
  assert.equal(validateLanguageJson({ common: ['Save', 'Cancel'] }).ok, false);
});

test('rejects a non-string leaf value', () => {
  assert.equal(validateLanguageJson({ common: { count: 5 } }).ok, false);
  assert.equal(validateLanguageJson({ common: { flag: true } }).ok, false);
  assert.equal(validateLanguageJson({ common: { missing: null } }).ok, false);
});

test('rejects prototype-pollution-shaped keys at any nesting depth', () => {
  // A JS object *literal* with a `__proto__` key sets the prototype instead of creating an own
  // property (no own key for Object.keys to see) — that's a different thing from what actually
  // happens in production, where JSON.parse on untrusted text DOES create an own "__proto__"
  // property. Use JSON.parse here so this test exercises the real attack surface.
  assert.equal(validateLanguageJson(JSON.parse('{"__proto__": {"save": "x"}}')).ok, false);
  assert.equal(validateLanguageJson({ common: { constructor: 'x' } }).ok, false);
  assert.equal(validateLanguageJson({ common: { nested: { prototype: 'x' } } }).ok, false);
});

test('diffKeys reports missing and extra keys relative to the base', () => {
  const base = new Set(['common.save', 'common.cancel', 'auth.loginTitle']);
  const candidate = new Set(['common.save', 'common.extraOne']);
  const { missing, extra } = diffKeys(candidate, base);
  assert.deepEqual(missing.sort(), ['auth.loginTitle', 'common.cancel']);
  assert.deepEqual(extra, ['common.extraOne']);
});
