import test from 'node:test';
import assert from 'node:assert/strict';
import { collectItems } from './infoItems.mjs';

const msg = (id, extra) => ({ id, content: '', attachments: [], ...extra });

test('collectItems sorts attachments into media and files and extracts links newest first', () => {
  const out = collectItems([
    msg(1, { content: 'see https://a.example/x and http://b.example', attachments: [{ url: '/u/1.png', mimeType: 'image/png', fileName: '1.png', sizeBytes: 5 }] }),
    msg(2, { attachments: [{ url: '/u/2.pdf', mimeType: 'application/pdf', fileName: '2.pdf', sizeBytes: 9 }, { url: '/u/3.mp4', mimeType: 'video/mp4', fileName: '3.mp4', sizeBytes: 1 }] }),
    msg(3, { content: 'dup https://a.example/x' }),
  ]);
  assert.deepEqual(out.media.map((m) => m.fileName), ['3.mp4', '1.png']);
  assert.deepEqual(out.files.map((f) => f.fileName), ['2.pdf']);
  assert.deepEqual(out.links, ['https://a.example/x', 'http://b.example']);
});

test('collectItems ignores undecryptable / encrypted ciphertext and empty input', () => {
  assert.deepEqual(collectItems([]), { media: [], files: [], links: [] });
  const out = collectItems([msg(1, { isEncrypted: true, decryptFailed: true, content: 'https://leak.example' })]);
  assert.deepEqual(out.links, []);
});
