import test from 'node:test';
import assert from 'node:assert/strict';
import { generateIdentityKeypair } from './crypto.mjs';
import {
  deriveRootSecret, initChains, sealMessage, openMessage, serializeState, deserializeState, MAX_SKIPPED,
} from './ratchet.mjs';

async function pair() {
  const a = await generateIdentityKeypair();
  const b = await generateIdentityKeypair();
  const rootA = await deriveRootSecret(a.privateKey, b.publicKey);
  const rootB = await deriveRootSecret(b.privateKey, a.publicKey);
  return { rootA, rootB, a: await initChains(rootA, 1, 2), b: await initChains(rootB, 2, 1) };
}

test('both sides derive the same root secret', async () => {
  const { rootA, rootB } = await pair();
  assert.deepEqual([...rootA], [...rootB]);
});

test('round trip in both directions', async () => {
  let { a, b } = await pair();
  let sealed = await sealMessage(a, 7, { text: 'hi bob', embed: null });
  a = sealed.state;
  assert.equal(sealed.envelope.v, 1);
  assert.equal(sealed.envelope.chainIndex, 0);
  let opened = await openMessage(b, 7, sealed.envelope);
  b = opened.state;
  assert.deepEqual(opened.plaintextObj, { text: 'hi bob', embed: null });

  sealed = await sealMessage(b, 7, { text: 'hi alice', embed: { url: 'https://x.test' } });
  b = sealed.state;
  opened = await openMessage(a, 7, sealed.envelope);
  assert.deepEqual(opened.plaintextObj, { text: 'hi alice', embed: { url: 'https://x.test' } });
});

test('ciphertext never contains the plaintext', async () => {
  const { a } = await pair();
  const { envelope } = await sealMessage(a, 1, { text: 'secret-marker-12345' });
  assert.ok(!JSON.stringify(envelope).includes('secret-marker'));
});

test('out-of-order delivery decrypts via skipped keys', async () => {
  let { a, b } = await pair();
  const envs = [];
  for (const text of ['one', 'two', 'three']) {
    const s = await sealMessage(a, 3, { text });
    a = s.state;
    envs.push(s.envelope);
  }
  let r = await openMessage(b, 3, envs[2]);
  b = r.state;
  assert.equal(r.plaintextObj.text, 'three');
  assert.equal(Object.keys(b.skipped).length, 2);
  r = await openMessage(b, 3, envs[0]);
  b = r.state;
  assert.equal(r.plaintextObj.text, 'one');
  r = await openMessage(b, 3, envs[1]);
  b = r.state;
  assert.equal(r.plaintextObj.text, 'two');
  assert.equal(Object.keys(b.skipped).length, 0);
});

test('simultaneous sends from both sides never collide on a chain position', async () => {
  let { a, b } = await pair();
  const fromA = await sealMessage(a, 5, { text: 'from a' });
  const fromB = await sealMessage(b, 5, { text: 'from b' });
  a = fromA.state;
  b = fromB.state;
  assert.equal(fromA.envelope.chainIndex, 0);
  assert.equal(fromB.envelope.chainIndex, 0);
  assert.equal((await openMessage(b, 5, fromA.envelope)).plaintextObj.text, 'from a');
  assert.equal((await openMessage(a, 5, fromB.envelope)).plaintextObj.text, 'from b');
});

test('a consumed message key cannot decrypt again', async () => {
  let { a, b } = await pair();
  const s = await sealMessage(a, 2, { text: 'once' });
  const r = await openMessage(b, 2, s.envelope);
  await assert.rejects(openMessage(r.state, 2, s.envelope), /already consumed/);
  const early = await sealMessage(s.state, 2, { text: 'later' });
  const late = await sealMessage(early.state, 2, { text: 'latest' });
  const r2 = await openMessage(r.state, 2, late.envelope);
  const r3 = await openMessage(r2.state, 2, early.envelope);
  await assert.rejects(openMessage(r3.state, 2, early.envelope), /already consumed/);
});

test('tampered ciphertext and wrong dm id are rejected without advancing state', async () => {
  const { a, b } = await pair();
  const { envelope } = await sealMessage(a, 9, { text: 'x' });
  const tampered = { ...envelope, ciphertext: (envelope.ciphertext[0] === 'A' ? 'B' : 'A') + envelope.ciphertext.slice(1) };
  await assert.rejects(openMessage(b, 9, tampered), /decryption failed/);
  await assert.rejects(openMessage(b, 10, envelope), /decryption failed/);
  await assert.rejects(openMessage(b, 9, { ...envelope, chainIndex: 1 }), /decryption failed/);
  assert.equal(b.recvIndex, 0);
  assert.equal((await openMessage(b, 9, envelope)).plaintextObj.text, 'x');
});

test('a forged far-future index does not advance the chain', async () => {
  const { a, b } = await pair();
  const { envelope } = await sealMessage(a, 4, { text: 'real' });
  await assert.rejects(openMessage(b, 4, { ...envelope, chainIndex: 500 }), /decryption failed/);
  assert.equal(b.recvIndex, 0);
  assert.equal(Object.keys(b.skipped).length, 0);
  assert.equal((await openMessage(b, 4, envelope)).plaintextObj.text, 'real');
});

test('skipped-key cap is enforced', async () => {
  let { a, b } = await pair();
  let last;
  for (let i = 0; i <= MAX_SKIPPED + 1; i += 1) {
    const s = await sealMessage(a, 6, { text: String(i) });
    a = s.state;
    last = s.envelope;
  }
  await assert.rejects(openMessage(b, 6, last), /too many skipped/);
  assert.equal(b.recvIndex, 0);
});

test('chain is one-way: old chain key cannot reach earlier message keys', async () => {
  let { a, b } = await pair();
  const first = await sealMessage(a, 8, { text: 'first' });
  a = first.state;
  const second = await sealMessage(a, 8, { text: 'second' });
  const r = await openMessage(b, 8, second.envelope);
  assert.equal(r.state.recvIndex, 2);
  assert.deepEqual(Object.keys(r.state.skipped), ['0']);
  const copy = await deserializeState(await serializeState(r.state));
  copy.skipped = {};
  await assert.rejects(openMessage(copy, 8, first.envelope), /already consumed/);
});

test('consumed chain keys are wiped', async () => {
  const { a, b } = await pair();
  const oldSend = a.sendKey;
  const oldRecv = b.recvKey;
  const s = await sealMessage(a, 1, { text: 'w' });
  await openMessage(b, 1, s.envelope);
  assert.ok(oldSend.every((x) => x === 0));
  assert.ok(oldRecv.every((x) => x === 0));
});

test('malformed envelopes are rejected', async () => {
  const { b } = await pair();
  for (const bad of [null, 'nope', '{}', { v: 2 }, { v: 1, chainIndex: -1, nonce: 'AA', ciphertext: 'AA' },
    { v: 1, chainIndex: 0, nonce: 'AAAA', ciphertext: 'AAAA' }, { v: 1, chainIndex: 1.5, nonce: '', ciphertext: '' }]) {
    await assert.rejects(openMessage(b, 1, bad), /invalid envelope/);
  }
});

test('state survives serialize/deserialize', async () => {
  let { a, b } = await pair();
  const s = await sealMessage(a, 1, { text: 'persist' });
  a = s.state;
  b = await deserializeState(await serializeState(b));
  assert.equal((await openMessage(b, 1, s.envelope)).plaintextObj.text, 'persist');
});
