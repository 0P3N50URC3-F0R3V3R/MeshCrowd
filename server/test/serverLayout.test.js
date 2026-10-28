'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeServerLayout, sanitizeFolderIcon } = require('../lib/serverLayout');

const MY_SERVERS = new Set([1, 2, 3]);

test('passes through valid server entries, drops ones the user is not a member of', () => {
  const out = sanitizeServerLayout([{ type: 'server', id: 1 }, { type: 'server', id: 99 }], MY_SERVERS);
  assert.deepEqual(out, [{ type: 'server', id: 1 }]);
});

test('a folder keeps only member servers and drops the folder entirely if that empties it', () => {
  const out = sanitizeServerLayout([
    { type: 'folder', id: 'f1', name: 'Gaming', color: '#57f287', servers: [1, 2, 99] },
    { type: 'folder', id: 'f2', name: 'Empty', color: '#57f287', servers: [99, 100] },
  ], MY_SERVERS);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].servers, [1, 2]);
  assert.equal(out[0].name, 'Gaming');
});

test('an invalid folder color falls back to the default rather than storing arbitrary CSS', () => {
  const out = sanitizeServerLayout([{ type: 'folder', id: 'f1', name: 'X', color: 'javascript:alert(1)', servers: [1] }], MY_SERVERS);
  assert.equal(out[0].color, '#0d9488');
});

test('non-array or garbage input never throws, just yields an empty layout', () => {
  assert.deepEqual(sanitizeServerLayout(null, MY_SERVERS), []);
  assert.deepEqual(sanitizeServerLayout('not an array', MY_SERVERS), []);
  assert.deepEqual(sanitizeServerLayout([null, 42, { type: 'nonsense' }], MY_SERVERS), []);
});

test('duplicate server ids within a folder are deduped', () => {
  const out = sanitizeServerLayout([{ type: 'folder', id: 'f1', name: 'X', color: '#57f287', servers: [1, 1, 2] }], MY_SERVERS);
  assert.deepEqual(out[0].servers, [1, 2]);
});

test('a folder with no icon defaults to auto (the mini-grid preview)', () => {
  const out = sanitizeServerLayout([{ type: 'folder', id: 'f1', name: 'X', color: '#57f287', servers: [1] }], MY_SERVERS);
  assert.deepEqual(out[0].icon, { kind: 'auto' });
});

test('sanitizeFolderIcon accepts a whitelisted built-in name, rejects anything else', () => {
  assert.deepEqual(sanitizeFolderIcon({ kind: 'builtin', value: 'rocket' }), { kind: 'builtin', value: 'rocket' });
  assert.deepEqual(sanitizeFolderIcon({ kind: 'builtin', value: 'not-a-real-icon' }), { kind: 'auto' });
  assert.deepEqual(sanitizeFolderIcon({ kind: 'builtin', value: '<script>alert(1)</script>' }), { kind: 'auto' });
});

test('sanitizeFolderIcon accepts only a real uploaded-folder-icon path, not an arbitrary URL', () => {
  assert.deepEqual(
    sanitizeFolderIcon({ kind: 'image', value: '/uploads/foldericons/1-abc123.png' }),
    { kind: 'image', value: '/uploads/foldericons/1-abc123.png' }
  );
  assert.deepEqual(sanitizeFolderIcon({ kind: 'image', value: 'https://evil.example/x.png' }), { kind: 'auto' });
  assert.deepEqual(sanitizeFolderIcon({ kind: 'image', value: '/uploads/foldericons/../../etc/passwd' }), { kind: 'auto' });
  assert.deepEqual(sanitizeFolderIcon({ kind: 'image', value: '/uploads/avatars/1-x.png' }), { kind: 'auto' });
});

test('sanitizeFolderIcon falls back to auto for garbage input without throwing', () => {
  assert.deepEqual(sanitizeFolderIcon(null), { kind: 'auto' });
  assert.deepEqual(sanitizeFolderIcon('nonsense'), { kind: 'auto' });
  assert.deepEqual(sanitizeFolderIcon({ kind: 'nonsense', value: 'x' }), { kind: 'auto' });
});

test('a folder icon round-trips through the full layout sanitizer', () => {
  const out = sanitizeServerLayout([
    { type: 'folder', id: 'f1', name: 'X', color: '#57f287', servers: [1], icon: { kind: 'builtin', value: 'star' } },
  ], MY_SERVERS);
  assert.deepEqual(out[0].icon, { kind: 'builtin', value: 'star' });
});
