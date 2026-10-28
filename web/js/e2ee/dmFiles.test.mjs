import test from 'node:test';
import assert from 'node:assert/strict';
import { generateIdentityKeypair } from './crypto.mjs';
import { deriveRootSecret, initChains, sealMessage, openMessage } from './ratchet.mjs';
import { newBlobId, encryptFile, decryptFile, fileMeta, normalizeFiles, buildPayload, MAX_FILES } from './dmFiles.mjs';
import { isValidEnvelope } from '../../../server/lib/e2eeEnvelope.js';

const bytes = (s) => new TextEncoder().encode(s);

test('file round trip with the DM id and blob id bound in', async () => {
  const id = newBlobId();
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.notEqual(id, newBlobId());
  const plain = bytes('hello encrypted attachment');
  const { key, blob } = await encryptFile(plain, 9, id);
  assert.equal(blob.length, plain.length + 28);
  assert.ok(!Buffer.from(blob).toString('latin1').includes('hello'));
  assert.deepEqual([...await decryptFile(blob, key, 9, id)], [...plain]);
});

test('every file gets a fresh key and iv', async () => {
  const id = newBlobId();
  const one = await encryptFile(bytes('same'), 1, id);
  const two = await encryptFile(bytes('same'), 1, id);
  assert.notEqual(one.key, two.key);
  assert.notDeepEqual([...one.blob], [...two.blob]);
});

test('tampering, wrong key and rebinding are all rejected', async () => {
  const id = newBlobId();
  const { key, blob } = await encryptFile(bytes('do not touch'), 4, id);
  const other = await encryptFile(bytes('x'), 4, id);

  assert.equal(await decryptFile(blob, key, 5, id), null, 'other DM');
  assert.equal(await decryptFile(blob, key, 4, newBlobId()), null, 'other blob id');
  assert.equal(await decryptFile(blob, other.key, 4, id), null, 'wrong key');
  for (const i of [0, 12, blob.length - 1]) {
    const flipped = blob.slice();
    flipped[i] ^= 1;
    assert.equal(await decryptFile(flipped, key, 4, id), null, `flipped byte ${i}`);
  }
  assert.equal(await decryptFile(blob.slice(0, blob.length - 1), key, 4, id), null, 'truncated');
  assert.equal(await decryptFile(blob.slice(0, 20), key, 4, id), null, 'shorter than overhead');
  assert.equal(await decryptFile(blob, 'not base64!', 4, id), null, 'garbage key');
});

test('empty files round trip', async () => {
  const id = newBlobId();
  const { key, blob } = await encryptFile(new Uint8Array(0), 2, id);
  assert.equal(blob.length, 28);
  assert.equal((await decryptFile(blob, key, 2, id)).length, 0);
});

test('normalizeFiles keeps valid entries and drops malformed ones', async () => {
  const id = newBlobId();
  const { key } = await encryptFile(bytes('x'), 1, id);
  const good = fileMeta(id, key, { name: 'a.png', type: 'image/png', size: 1 });
  assert.deepEqual(normalizeFiles([good]), [good]);
  assert.deepEqual(normalizeFiles(undefined), []);
  assert.deepEqual(normalizeFiles('nope'), []);
  const bad = [
    { ...good, id: '../../etc/passwd' },
    { ...good, id: good.id.toUpperCase() },
    { ...good, key: 'short' },
    { ...good, size: -1 },
    { ...good, size: 1.5 },
    null,
    'string',
  ];
  assert.deepEqual(normalizeFiles(bad), []);
  const loose = normalizeFiles([{ id, key, size: 3, name: 'n'.repeat(500), type: 7 }])[0];
  assert.equal(loose.name.length, 200);
  assert.equal(loose.type, 'application/octet-stream');
  assert.equal(normalizeFiles(Array(MAX_FILES + 3).fill(good)).length, MAX_FILES);
  assert.equal(fileMeta(id, key, { size: 0 }).name, 'file');
});

async function pair() {
  const a = await generateIdentityKeypair();
  const b = await generateIdentityKeypair();
  return {
    a: await initChains(await deriveRootSecret(a.privateKey, b.publicKey), 1, 2),
    b: await initChains(await deriveRootSecret(b.privateKey, a.publicKey), 2, 1),
  };
}

test('payload with files rides the ratchet, and old text-only payloads still open', async () => {
  let { a, b } = await pair();
  const legacy = await sealMessage(a, 3, { text: 'old style', embed: null });
  a = legacy.state;
  assert.deepEqual(buildPayload('old style', null, []), { text: 'old style', embed: null });

  const id = newBlobId();
  const content = bytes('attached bytes');
  const { key, blob } = await encryptFile(content, 3, id);
  const meta = fileMeta(id, key, { name: 'notes.txt', type: 'text/plain', size: content.length });
  const withFile = await sealMessage(a, 3, buildPayload('see file', null, [meta]));
  assert.ok(isValidEnvelope(JSON.stringify(withFile.envelope)), 'server still accepts the envelope');
  const wire = JSON.stringify(withFile.envelope);
  assert.ok(!wire.includes(key) && !wire.includes('notes.txt') && !wire.includes(id));

  let opened = await openMessage(b, 3, legacy.envelope);
  b = opened.state;
  assert.equal(opened.plaintextObj.text, 'old style');
  assert.deepEqual(normalizeFiles(opened.plaintextObj.files), []);

  opened = await openMessage(b, 3, withFile.envelope);
  const [got] = normalizeFiles(opened.plaintextObj.files);
  assert.deepEqual(got, meta);
  assert.deepEqual([...await decryptFile(blob, got.key, 3, got.id)], [...content]);
});

test('a full payload of five files with long names fits the envelope limit', async () => {
  const { a } = await pair();
  const files = [];
  for (let i = 0; i < MAX_FILES; i++) {
    const id = newBlobId();
    const { key } = await encryptFile(bytes('x'), 1, id);
    files.push(fileMeta(id, key, { name: 'ű'.repeat(200), type: 'application/' + 'x'.repeat(100), size: 1 }));
  }
  const { envelope } = await sealMessage(a, 1, buildPayload('é'.repeat(4000), null, files));
  assert.ok(isValidEnvelope(JSON.stringify(envelope)));
});
