'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const webRoot = path.join(__dirname, '..', '..', 'web');
const roots = [path.join(webRoot, 'js'), path.join(webRoot, 'm')];

function listModules(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return listModules(p);
    return /\.(js|mjs)$/.test(e.name) && !/\.test\./.test(e.name) ? [p] : [];
  });
}

test('every browser module parses (a syntax error blanks the whole app)', () => {
  for (const file of roots.flatMap(listModules)) {
    const r = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: fs.readFileSync(file) });
    assert.equal(r.status, 0, `${path.relative(webRoot, file)}: ${r.stderr}`);
  }
});

test('every named import in the browser modules resolves to a real export', () => {
  const r = spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', path.join(__dirname, '..', 'tools', 'webLinkCheck.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
});
