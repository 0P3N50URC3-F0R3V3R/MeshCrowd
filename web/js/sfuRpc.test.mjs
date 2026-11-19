import test from 'node:test';
import assert from 'node:assert/strict';
import { createRpc } from './sfuRpc.mjs';

function setup(opts) {
  const sent = [];
  const rpc = createRpc((m) => sent.push(m), opts);
  return { rpc, sent };
}

test('request resolves with the data of the matching response', async () => {
  const { rpc, sent } = setup();
  const p = rpc.request('caps', { a: 1 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].op, 'caps');
  assert.deepEqual(sent[0].data, { a: 1 });
  rpc.handleResponse({ id: sent[0].id, ok: true, data: { x: 2 } });
  assert.deepEqual(await p, { x: 2 });
});

test('request rejects with error.code when ok is false', async () => {
  const { rpc, sent } = setup();
  const p = rpc.request('produce', {});
  rpc.handleResponse({ id: sent[0].id, ok: false, error: 'muted' });
  await assert.rejects(p, (err) => err.code === 'muted');
});

test('request rejects after timeoutMs', async () => {
  const { rpc, sent } = setup({ timeoutMs: 20 });
  const p = rpc.request('caps');
  await assert.rejects(p, (err) => err.code === 'timeout');
  rpc.handleResponse({ id: sent[0].id, ok: true, data: {} });
});

test('responses with unknown ids are ignored', async () => {
  const { rpc, sent } = setup();
  const p = rpc.request('caps');
  rpc.handleResponse({ id: sent[0].id + 1000, ok: true, data: { wrong: true } });
  rpc.handleResponse({ id: sent[0].id, ok: true, data: { right: true } });
  assert.deepEqual(await p, { right: true });
});

test('ids are unique across rpc instances so a stale response cannot resolve a new request', async () => {
  const a = setup();
  const b = setup();
  a.rpc.request('caps').catch(() => {});
  const p = b.rpc.request('caps');
  assert.notEqual(a.sent[0].id, b.sent[0].id);
  b.rpc.handleResponse({ id: a.sent[0].id, ok: true, data: { stale: true } });
  b.rpc.handleResponse({ id: b.sent[0].id, ok: true, data: { fresh: true } });
  assert.deepEqual(await p, { fresh: true });
  a.rpc.close();
});

test('close rejects pending requests and refuses new ones', async () => {
  const { rpc, sent } = setup();
  const p = rpc.request('caps');
  rpc.close();
  await assert.rejects(p, (err) => err.code === 'closed');
  await assert.rejects(rpc.request('caps'), (err) => err.code === 'closed');
  assert.equal(sent.length, 1);
});
