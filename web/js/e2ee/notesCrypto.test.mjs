import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptBytes, decryptBytes, newFileTag, encryptNote, decryptNote, packNote, unpackNote } from './notesCrypto.mjs';

const newKey = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
const bytes = (s) => new TextEncoder().encode(s);
const SCOPE = 'https://a.example|1|7';

test('a bound file round-trips with its own tag', async () => {
  const key = await newKey();
  const fk = newFileTag();
  const blob = await encryptBytes(key, 5, bytes('hello'), { scope: SCOPE, fk });
  assert.equal(new TextDecoder().decode(await decryptBytes(key, 5, blob, { scope: SCOPE, fk })), 'hello');
});

test('newFileTag is random per call', () => {
  assert.notEqual(newFileTag(), newFileTag());
});

test('a blob swapped in from another file of the same channel and owner fails to decrypt', async () => {
  const key = await newKey();
  const fkA = newFileTag();
  const fkB = newFileTag();
  const blobB = await encryptBytes(key, 5, bytes('b'), { scope: SCOPE, fk: fkB });
  assert.equal(await decryptBytes(key, 5, blobB, { scope: SCOPE, fk: fkA }), null);
});

test('a bound file does not decrypt under another channel or owner scope', async () => {
  const key = await newKey();
  const fk = newFileTag();
  const blob = await encryptBytes(key, 5, bytes('x'), { scope: SCOPE, fk });
  assert.equal(await decryptBytes(key, 6, blob, { scope: SCOPE, fk }), null);
  assert.equal(await decryptBytes(key, 5, blob, { scope: 'https://a.example|1|8', fk }), null);
});

test('legacy channel-only files still decrypt when the note names no tag', async () => {
  const key = await newKey();
  const legacy = await encryptBytes(key, 5, bytes('old'));
  assert.equal(new TextDecoder().decode(await decryptBytes(key, 5, legacy)), 'old');
  assert.equal(new TextDecoder().decode(await decryptBytes(key, 5, legacy, { scope: SCOPE })), 'old');
});

test('a file the note says is bound never falls back to the legacy AAD', async () => {
  const key = await newKey();
  const legacy = await encryptBytes(key, 5, bytes('old'));
  assert.equal(await decryptBytes(key, 5, legacy, { scope: SCOPE, fk: newFileTag() }), null);
});

test('the file tag survives the encrypted note body', async () => {
  const key = await newKey();
  const fk = newFileTag();
  const enc = await encryptNote(key, 5, packNote('t', [{ id: 1, name: 'a.txt', type: 'text/plain', size: 1, fk }]), SCOPE);
  const body = unpackNote(await decryptNote(key, 5, enc, SCOPE));
  assert.equal(body.files[0].fk, fk);
});
