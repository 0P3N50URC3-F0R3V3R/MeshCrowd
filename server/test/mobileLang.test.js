'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? walk(p) : (/\.(js|mjs)$/.test(e.name) && !/\.test\./.test(e.name) ? [p] : []);
});

test('every t(\'m.…\') key used in web/m exists in en and hu', () => {
  const en = JSON.parse(fs.readFileSync(path.join(root, 'lang', 'en.json'), 'utf8')).m;
  const hu = JSON.parse(fs.readFileSync(path.join(root, 'lang', 'hu.json'), 'utf8')).m;
  const used = new Set();
  for (const file of walk(path.join(root, 'web', 'm'))) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\bt\(\s*['"]m\.(\w+)['"]/g)) used.add(m[1]);
    for (const m of src.matchAll(/(?:label|hint):\s*['"]m\.(\w+)['"]/g)) used.add(m[1]);
  }
  for (const key of used) {
    assert.ok(key in en, `m.${key} missing from en.json`);
    assert.ok(key in hu, `m.${key} missing from hu.json`);
  }
  assert.deepEqual(Object.keys(en).sort(), Object.keys(hu).sort());
});
