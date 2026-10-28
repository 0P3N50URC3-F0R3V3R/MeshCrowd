'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeOrigins, buildSiteCsp } = require('../lib/siteCsp');

test('normalizeOrigins accepts plain https origins and canonicalises them', () => {
  const r = normalizeOrigins(['https://cdn.jsdelivr.net', 'https://cdn.jsdelivr.net/', 'https://Example.com:8443']);
  assert.deepEqual(r, { ok: true, origins: ['https://cdn.jsdelivr.net', 'https://example.com:8443'] });
});

test('normalizeOrigins rejects wildcards, http, paths, credentials, queries and junk', () => {
  for (const bad of ['http://x.com', '*', 'https://*.x.com', 'https://x.com/path', 'https://u:p@x.com', 'https://x.com?a=1', 'javascript:alert(1)', '', 5, null]) {
    assert.equal(normalizeOrigins([bad]).ok, false, String(bad));
  }
  assert.equal(normalizeOrigins('https://x.com').ok, false);
  assert.equal(normalizeOrigins(Array.from({ length: 21 }, (_, i) => `https://h${i}.com`)).ok, false);
});

test('buildSiteCsp always frames only itself and lists external origins per directive', () => {
  const none = buildSiteCsp([]);
  assert.match(none, /frame-ancestors 'self'/);
  assert.match(none, /frame-src 'none'/);
  assert.match(none, /script-src 'self' 'unsafe-inline'(;|$)/);
  const some = buildSiteCsp(['https://cdn.example.com']);
  assert.match(some, /script-src 'self' 'unsafe-inline' https:\/\/cdn\.example\.com/);
  assert.match(some, /img-src 'self' data: blob: https:\/\/cdn\.example\.com/);
  assert.match(some, /frame-src https:\/\/cdn\.example\.com/);
  assert.match(some, /form-action 'self'/);
});
