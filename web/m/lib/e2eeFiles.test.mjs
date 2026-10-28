import test from 'node:test';
import assert from 'node:assert/strict';
import { e2eeFileKind, INLINE_MAX_BYTES } from './e2eeFiles.mjs';

test('e2eeFileKind: only small raster images render inline, everything else is a download chip', () => {
  assert.equal(e2eeFileKind({ type: 'image/png', size: 100 }), 'image');
  assert.equal(e2eeFileKind({ type: 'image/webp', size: INLINE_MAX_BYTES }), 'image');
  assert.equal(e2eeFileKind({ type: 'image/jpeg', size: INLINE_MAX_BYTES + 1 }), 'file');
  assert.equal(e2eeFileKind({ type: 'image/svg+xml', size: 10 }), 'file');
  assert.equal(e2eeFileKind({ type: 'application/pdf', size: 10 }), 'file');
  assert.equal(e2eeFileKind({ type: 'text/html', size: 10 }), 'file');
});
