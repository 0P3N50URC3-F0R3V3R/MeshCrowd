'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

process.env.DISMESH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
const atRest = require('../lib/atRest');

test('seal/open round-trips, including unicode and empty text', () => {
  for (const text of ['hello', 'árvíztűrő tükörfúrógép 🎉', '', 'a'.repeat(20000)]) {
    const sealed = atRest.seal(text);
    assert.ok(atRest.isSealed(sealed));
    assert.ok(!sealed.includes(text) || text === '');
    assert.equal(atRest.open(sealed), text);
  }
});

test('every seal uses a fresh nonce', () => {
  assert.notEqual(atRest.seal('same'), atRest.seal('same'));
});

test('plain text, null and tampered values pass through open() unchanged', () => {
  assert.equal(atRest.open('just text'), 'just text');
  assert.equal(atRest.open('enc1:not-base64-garbage'), 'enc1:not-base64-garbage');
  assert.equal(atRest.open(null), null);
  const sealed = atRest.seal('secret');
  const tampered = `${sealed.slice(0, -4)}AAAA`;
  assert.equal(atRest.open(tampered), tampered);
});

test('sealFor only seals DM scopes', () => {
  assert.ok(atRest.isSealed(atRest.sealFor('dm', 'x')));
  assert.equal(atRest.sealFor('channel', 'x'), 'x');
  assert.equal(atRest.sealFor('thread', 'x'), 'x');
});
