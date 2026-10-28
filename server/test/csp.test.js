'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { buildCsp } = require('../lib/csp');

const sha = (text) => `'sha256-${crypto.createHash('sha256').update(text, 'utf8').digest('base64')}'`;
const lf = (s) => s.replace(/\r\n?/g, '\n');

const IMPORTMAP = '\n{\n  "imports": {\n    "a": "/vendor/a.mjs"\n  }\n}\n';
const html = (map) => `<!doctype html><html><head>\n<script type="importmap">${map}</script>\n<script type="module" src="js/main.js"></script></head></html>`;

function directive(csp, name) {
  const found = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(name + ' '));
  assert.ok(found, `directive ${name} missing`);
  return found.split(/\s+/).slice(1);
}

test('script-src allows wasm-unsafe-eval', () => {
  assert.ok(directive(buildCsp(html(IMPORTMAP)), 'script-src').includes("'wasm-unsafe-eval'"));
});

test('script-src contains the sha256 of the exact importmap inner text', () => {
  assert.ok(directive(buildCsp(html(IMPORTMAP)), 'script-src').includes(sha(IMPORTMAP)));
});

test('script-src never allows unsafe-inline or unsafe-eval', () => {
  const tokens = directive(buildCsp(html(IMPORTMAP)), 'script-src');
  assert.ok(!tokens.includes("'unsafe-inline'"));
  assert.ok(!tokens.includes("'unsafe-eval'"));
  assert.ok(tokens.includes("'self'"));
});

test('editing the importmap changes the emitted hash', () => {
  const a = buildCsp(html(IMPORTMAP));
  const b = buildCsp(html(IMPORTMAP.replace('/vendor/a.mjs', '/vendor/b.mjs')));
  assert.notEqual(a, b);
  assert.ok(directive(b, 'script-src').includes(sha(IMPORTMAP.replace('/vendor/a.mjs', '/vendor/b.mjs'))));
});

test('no importmap means no sha256 token', () => {
  const tokens = directive(buildCsp('<html><script type="module" src="x.js"></script></html>'), 'script-src');
  assert.ok(!tokens.some((t) => t.startsWith("'sha256-")));
  assert.ok(tokens.includes("'wasm-unsafe-eval'"));
});

test('other directives are unchanged', () => {
  const csp = buildCsp(html(IMPORTMAP));
  for (const d of [
    "default-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ]) {
    assert.ok(csp.split(';').map((x) => x.trim()).includes(d), `missing ${d}`);
  }
});

test('real web/index.html importmap hash is emitted', () => {
  const real = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'index.html'), 'utf8');
  const m = /<script type="importmap">([\s\S]*?)<\/script>/.exec(real);
  assert.ok(m, 'web/index.html has no importmap');
  assert.ok(directive(buildCsp(real), 'script-src').includes(sha(lf(m[1]))));
});

test('CRLF source is hashed as LF (browsers normalize newlines before CSP hashing)', () => {
  const crlf = IMPORTMAP.replace(/\n/g, '\r\n');
  const tokens = directive(buildCsp(html(crlf)), 'script-src');
  assert.ok(tokens.includes(sha(IMPORTMAP)));
  assert.ok(!tokens.includes(sha(crlf)));
});

test('mobile page importmap is identical to the desktop page so one CSP covers both', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'web', p), 'utf8');
  assert.equal(buildCsp(read('m/index.html')), buildCsp(read('index.html')));
});
