'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { probe } = require('../lib/sfu/availability');

test('probe reports ok with a version on this machine', () => {
  const r = probe();
  assert.strictEqual(r.ok, true, r.reason);
  assert.match(r.version, /^\d+\.\d+\.\d+/);
  assert.ok(fs.existsSync(r.workerPath));
});

test('probe returns ok:false with a reason when the worker binary is missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sfu-probe-'));
  try {
    const pkg = path.join(root, 'node_modules', 'mediasoup');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'mediasoup', version: '0.0.0', main: 'index.js' }));
    fs.writeFileSync(path.join(pkg, 'index.js'), '');
    const r = probe({ root });
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /worker binary missing/);
    assert.ok(r.reason.includes(pkg));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
