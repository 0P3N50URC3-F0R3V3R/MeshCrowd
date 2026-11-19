'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, '..', '..', 'web', 'js', 'vendor', 'mediasoup-client.js');

test('vendored mediasoup-client bundle is present, bannered and small', () => {
  const stat = fs.statSync(FILE);
  assert.ok(stat.size < 400 * 1024, `bundle is ${stat.size} bytes`);
  const src = fs.readFileSync(FILE, 'utf8');
  const m = /^\/\* mediasoup-client (\d+\.\d+\.\d+) bundled by scripts\/build-vendor\.js \*\/\n/.exec(src);
  assert.ok(m, 'banner missing');
  assert.ok(src.includes('Device'));
  assert.ok(/export\{[^}]*\bDevice\b[^}]*\bversion\b/.test(src.slice(-300)), 'Device/version exports missing');
});
