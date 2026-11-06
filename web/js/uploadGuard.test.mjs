import test from 'node:test';
import assert from 'node:assert/strict';
import { checkUploadFile, fileExtension } from './uploadGuard.mjs';

test('blocks executables, case-insensitive and trailing dots', () => {
  for (const n of ['a.exe', 'A.EXE', 'run.bat', 'x.cmd', 'y.com', 'z.exe.', 'evil.pdf.exe']) {
    assert.equal(checkUploadFile({ name: n, size: 1 }, 25).reason, 'blocked', n);
  }
});

test('allows ordinary files, including names with no extension', () => {
  assert.equal(checkUploadFile({ name: 'a.png', size: 1 }, 25).ok, true);
  assert.equal(checkUploadFile({ name: 'README', size: 1 }, 25).ok, true);
  assert.equal(fileExtension('.exe'), '');
});

test('size cap is inclusive of the limit', () => {
  const mb = 1024 * 1024;
  assert.equal(checkUploadFile({ name: 'a.zip', size: 25 * mb }, 25).ok, true);
  const r = checkUploadFile({ name: 'a.zip', size: 25 * mb + 1 }, 25);
  assert.deepEqual([r.ok, r.reason, r.maxMb], [false, 'tooLarge', 25]);
});
