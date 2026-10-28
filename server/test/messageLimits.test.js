'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;
fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ maxMessageChars: 50 }));

const { maxMessageChars, DEFAULT_CHARS } = require('../lib/messageLimits');

test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('maxMessageChars reads config.json and clamps to the 100 minimum', () => {
  assert.equal(maxMessageChars(), 100);
  assert.equal(DEFAULT_CHARS, 15000);
});
