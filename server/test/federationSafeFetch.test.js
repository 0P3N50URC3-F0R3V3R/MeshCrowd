'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

delete process.env.DISMESH_FEDERATION_ALLOW_LOOPBACK;
const { safeFetch, pinnedLookup } = require('../lib/federationSsrf');

test('the pinned resolver refuses a hostname that resolves to loopback', async () => {
  const err = await new Promise((resolve) => pinnedLookup('localhost', {}, (e) => resolve(e)));
  assert.equal(err?.code, 'EBLOCKED');
});

test('the pinned resolver refuses when ANY returned address is non-public (all:true)', async () => {
  const err = await new Promise((resolve) => pinnedLookup('localhost', { all: true }, (e) => resolve(e)));
  assert.equal(err?.code, 'EBLOCKED');
});

test('safeFetch rejects plain http, private IP literals and unsupported schemes without connecting', async () => {
  await assert.rejects(safeFetch('http://93.184.216.34/'), /https/);
  await assert.rejects(safeFetch('https://127.0.0.1/'), /not public/);
  await assert.rejects(safeFetch('https://10.1.2.3/x'), /not public/);
  await assert.rejects(safeFetch('https://[::1]/x'), /not public/);
  await assert.rejects(safeFetch('ftp://example.com/'), /https|protocol/);
});

test('with the loopback test hatch, safeFetch does not follow redirects and returns a real Response', async (t) => {
  process.env.DISMESH_FEDERATION_ALLOW_LOOPBACK = '1';
  t.after(() => { delete process.env.DISMESH_FEDERATION_ALLOW_LOOPBACK; });
  let hits = 0;
  const target = http.createServer((req, res) => { hits += 1; res.end('internal'); });
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  const redirector = http.createServer((req, res) => {
    if (req.url === '/json') { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); return; }
    res.writeHead(307, { Location: `http://127.0.0.1:${target.address().port}/` }); res.end();
  });
  await new Promise((r) => redirector.listen(0, '127.0.0.1', r));
  t.after(() => { target.close(); redirector.close(); });

  const redirected = await safeFetch(`http://127.0.0.1:${redirector.address().port}/`, { method: 'POST', body: '{}' });
  assert.equal(redirected.status, 307);
  assert.equal(redirected.ok, false);
  assert.equal(hits, 0);

  const json = await safeFetch(`http://127.0.0.1:${redirector.address().port}/json`);
  assert.equal(json.ok, true);
  assert.deepEqual(await json.json(), { ok: true });
});
