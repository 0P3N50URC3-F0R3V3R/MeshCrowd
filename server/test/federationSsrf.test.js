'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isSafePeerUrl } = require('../lib/federationSsrf');

test('rejects loopback and private targets', async () => {
  assert.equal(await isSafePeerUrl('https://127.0.0.1/'), false);
  assert.equal(await isSafePeerUrl('https://localhost/'), false);
  assert.equal(await isSafePeerUrl('https://10.1.2.3/'), false);
  assert.equal(await isSafePeerUrl('https://192.168.1.5/'), false);
  assert.equal(await isSafePeerUrl('https://169.254.1.1/'), false);
});

test('rejects malformed URLs and non-https', async () => {
  assert.equal(await isSafePeerUrl('not a url'), false);
  assert.equal(await isSafePeerUrl('http://example.com/'), false);
});

test('accepts a public https host', async () => {
  // 93.184.216.34 is example.com's stable public IP; no live DNS needed if offline — the
  // validator must handle a literal public IP in the URL directly.
  assert.equal(await isSafePeerUrl('https://93.184.216.34/'), true);
});

test('rejects IPv6 loopback and private ranges', async () => {
  assert.equal(await isSafePeerUrl('https://[::1]/'), false);
  assert.equal(await isSafePeerUrl('https://[fc00::1]/'), false);
  assert.equal(await isSafePeerUrl('https://[fd00::1]/'), false);
});

test('rejects the unspecified addresses, CGNAT and benchmarking ranges', async () => {
  const { isPrivateOrLoopback } = require('../lib/federationSsrf');
  assert.equal(isPrivateOrLoopback('::'), true);
  assert.equal(isPrivateOrLoopback('0.0.0.0'), true);
  assert.equal(isPrivateOrLoopback('100.64.0.1'), true);
  assert.equal(isPrivateOrLoopback('198.18.0.1'), true);
  assert.equal(isPrivateOrLoopback('198.19.255.255'), true);
  assert.equal(isPrivateOrLoopback('198.20.0.1'), false);
  assert.equal(await isSafePeerUrl('https://[::]/'), false);
});

test('rejects link-local IPv6 addresses (fe80::/10)', async () => {
  // fe80::/10 spans first groups 0xfe80–0xfebf; verify full range coverage
  assert.equal(await isSafePeerUrl('https://[fe80::1]/'), false);
  assert.equal(await isSafePeerUrl('https://[fe90::1]/'), false);
  assert.equal(await isSafePeerUrl('https://[fea0::1]/'), false);
  assert.equal(await isSafePeerUrl('https://[febf::1]/'), false);
});

test('rejects IPv4-mapped IPv6 addresses targeting private ranges', async () => {
  // Critical: IPv4-mapped addresses must go through IPv4 range checks
  // These represent loopback, link-local, and RFC1918 private networks
  assert.equal(await isSafePeerUrl('https://[::ffff:127.0.0.1]/'), false);
  assert.equal(await isSafePeerUrl('https://[::ffff:169.254.169.254]/'), false); // link-local metadata endpoint
  assert.equal(await isSafePeerUrl('https://[::ffff:10.0.0.1]/'), false);
  assert.equal(await isSafePeerUrl('https://[::ffff:192.168.1.1]/'), false);
  assert.equal(await isSafePeerUrl('https://[::ffff:172.16.0.1]/'), false);
});

test('rejects bare IPv4-compatible IPv6 addresses (::x.x.x.x form)', async () => {
  // IPv4-compatible (deprecated but supported by Node.js URL parser): ::x.x.x.x
  // Without the ffff marker, these were previously undetected
  assert.equal(await isSafePeerUrl('https://[::127.0.0.1]/'), false);
  assert.equal(await isSafePeerUrl('https://[::169.254.169.254]/'), false); // link-local metadata
  assert.equal(await isSafePeerUrl('https://[::10.0.0.1]/'), false);
});

test('accepts public IPv6 addresses', async () => {
  // 2001:4860:4860::8888 is Google Public DNS (not reserved/private)
  assert.equal(await isSafePeerUrl('https://[2001:4860:4860::8888]/'), true);
});
