'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeTheme, DEFAULT_THEME } = require('../lib/theme');

test('valid hex colors and a whitelisted font key pass through unchanged', () => {
  const out = sanitizeTheme({ brand: '#ff0000', bgPrimary: '#00ff00', font: 'mono' });
  assert.equal(out.brand, '#ff0000');
  assert.equal(out.bgPrimary, '#00ff00');
  assert.equal(out.font, 'mono');
});

test('an empty string field means "use the app default" and is kept as-is', () => {
  const out = sanitizeTheme({ brand: '', bgRail: '#123456' });
  assert.equal(out.brand, '');
  assert.equal(out.bgRail, '#123456');
});

test('anything that is not a strict #rrggbb hex falls back to the default (empty), never stored raw', () => {
  const attempts = [
    'red', '#fff', '#gggggg', 'javascript:alert(1)',
    'url(https://evil.example/x.png)', '#5865f2; } body { display:none',
  ];
  for (const value of attempts) {
    const out = sanitizeTheme({ brand: value });
    assert.equal(out.brand, DEFAULT_THEME.brand, `expected "${value}" to be rejected`);
  }
});

test('an unrecognized font key falls back to the default font', () => {
  const out = sanitizeTheme({ font: 'Comic Sans MS' });
  assert.equal(out.font, 'default');
});

test('unknown fields are dropped, only the fixed shape is ever returned', () => {
  const out = sanitizeTheme({ brand: '#5865f2', evil: '</style><script>alert(1)</script>' });
  assert.deepEqual(Object.keys(out).sort(), Object.keys(DEFAULT_THEME).sort());
});

test('garbage input never throws, just yields the default theme', () => {
  assert.deepEqual(sanitizeTheme(null), DEFAULT_THEME);
  assert.deepEqual(sanitizeTheme('not an object'), DEFAULT_THEME);
  assert.deepEqual(sanitizeTheme(42), DEFAULT_THEME);
  assert.deepEqual(sanitizeTheme(undefined), DEFAULT_THEME);
});
