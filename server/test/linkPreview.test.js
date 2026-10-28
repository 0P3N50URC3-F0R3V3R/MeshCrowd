'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const dns = require('node:dns');
const { extractFirstUrl, isPrivateIp, fetchEmbed } = require('../lib/linkPreview');

test('extractFirstUrl finds the first http(s) url and trims trailing sentence punctuation', () => {
  assert.equal(extractFirstUrl('check https://example.com/path out!'), 'https://example.com/path');
  assert.equal(extractFirstUrl('see https://example.com/foo.'), 'https://example.com/foo');
  assert.equal(extractFirstUrl('no links here'), null);
  assert.equal(extractFirstUrl('(https://example.com/bar)'), 'https://example.com/bar');
});

test('isPrivateIp rejects loopback/private/link-local ranges, allows public addresses', () => {
  assert.equal(isPrivateIp('127.0.0.1'), true);
  assert.equal(isPrivateIp('10.0.0.1'), true);
  assert.equal(isPrivateIp('172.16.5.5'), true);
  assert.equal(isPrivateIp('172.32.5.5'), false);
  assert.equal(isPrivateIp('192.168.1.1'), true);
  assert.equal(isPrivateIp('169.254.1.1'), true);
  assert.equal(isPrivateIp('8.8.8.8'), false);
  assert.equal(isPrivateIp('::1'), true);
  assert.equal(isPrivateIp('fe80::1'), true);
  assert.equal(isPrivateIp('fc00::1'), true);
  assert.equal(isPrivateIp('2001:4860:4860::8888'), false);
});

test('isPrivateIp also rejects the unspecified, CGNAT and benchmarking ranges', () => {
  assert.equal(isPrivateIp('::'), true);
  assert.equal(isPrivateIp('0.0.0.0'), true);
  assert.equal(isPrivateIp('100.64.0.1'), true);
  assert.equal(isPrivateIp('100.127.255.255'), true);
  assert.equal(isPrivateIp('198.18.0.1'), true);
  assert.equal(isPrivateIp('198.19.0.1'), true);
  assert.equal(isPrivateIp('100.128.0.1'), false);
});

test('fetchEmbed refuses a hostname resolving into CGNAT space', async (t) => {
  const originalLookup = dns.promises.lookup;
  dns.promises.lookup = async () => ({ address: '100.64.1.1', family: 4 });
  t.after(() => { dns.promises.lookup = originalLookup; });
  assert.equal(await fetchEmbed('http://cgnat.invalid/'), null);
});

test('fetchEmbed does not follow redirects', async (t) => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    if (req.url === '/start') { res.writeHead(302, { location: '/target' }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><head><title>Redirected</title></head></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const originalLookup = dns.promises.lookup;
  dns.promises.lookup = async () => ({ address: '203.0.113.5', family: 4 });
  t.after(() => { dns.promises.lookup = originalLookup; });

  assert.equal(await fetchEmbed(`http://127.0.0.1:${server.address().port}/start`), null);
  assert.equal(hits, 1);
});

test('fetchEmbed refuses a literal loopback URL without ever attempting the HTTP request', async () => {
  const embed = await fetchEmbed('http://127.0.0.1:1/');
  assert.equal(embed, null);
});

test('fetchEmbed extracts og:title/og:description/og:image from a real HTTP response', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html><head>
      <meta property="og:title" content="Test Page Title">
      <meta property="og:description" content="A description &amp; more">
      <meta property="og:image" content="/img.png">
      <meta property="og:site_name" content="Test Site">
    </head><body></body></html>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/page`;

  // The URL's host is a real loopback address the isPrivateIp guard would normally refuse —
  // fake out just the DNS step to a public-looking address so the guard passes, while the
  // actual fetch() still physically connects to our own local test server above. This proves
  // the extraction logic works without depending on outbound internet access in CI/dev boxes.
  const originalLookup = dns.promises.lookup;
  dns.promises.lookup = async () => ({ address: '203.0.113.5', family: 4 });
  t.after(() => { dns.promises.lookup = originalLookup; });

  const embed = await fetchEmbed(url);
  assert.ok(embed, 'expected an embed to be extracted');
  assert.equal(embed.title, 'Test Page Title');
  assert.equal(embed.description, 'A description & more');
  assert.equal(embed.image, `http://127.0.0.1:${port}/img.png`);
  assert.equal(embed.siteName, 'Test Site');
  assert.equal(embed.url, url);
});

test('fetchEmbed returns null for a non-html response', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;

  const originalLookup = dns.promises.lookup;
  dns.promises.lookup = async () => ({ address: '203.0.113.5', family: 4 });
  t.after(() => { dns.promises.lookup = originalLookup; });

  const embed = await fetchEmbed(`http://127.0.0.1:${port}/data.json`);
  assert.equal(embed, null);
});
