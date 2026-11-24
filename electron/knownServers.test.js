'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeOrigin, upsert, remove, setSignIn, switchTarget, MAX_SERVERS } = require('./knownServers');

test('normalizeOrigin keeps http(s) origins only and refuses credentials', () => {
  assert.equal(normalizeOrigin('https://H.Example.com:8443/some/path?x=1'), 'https://h.example.com:8443');
  assert.equal(normalizeOrigin('http://192.168.1.10:8080'), 'http://192.168.1.10:8080');
  for (const bad of ['javascript:alert(1)', 'file:///c:/x', 'ftp://x', 'https://u:p@x.example.com', 'nonsense', '', null, 42]) assert.equal(normalizeOrigin(bad), null);
});

test('upsert adds, moves to the front and keeps the sign-in choice', () => {
  let list = upsert([], { url: 'https://a.example.com/x', name: 'A', icon: '' }, 1);
  list = upsert(list, { url: 'https://b.example.com', name: 'B', icon: '' }, 2);
  list = setSignIn(list, 'https://a.example.com', 'keep');
  list = upsert(list, { url: 'https://a.example.com', name: 'A renamed', icon: '' }, 3);
  assert.deepEqual(list.map((e) => e.url), ['https://a.example.com', 'https://b.example.com']);
  assert.equal(list[0].name, 'A renamed');
  assert.equal(list[0].signIn, 'keep');
  assert.equal(list[0].lastUsed, 3);
  assert.equal(list[1].signIn, null);
});

test('upsert refuses a bad address, clamps the name and drops a bad icon', () => {
  assert.deepEqual(upsert([], { url: 'javascript:1', name: 'x', icon: '' }, 1), []);
  const long = upsert([], { url: 'https://a.example.com', name: `  ${'n'.repeat(100)}\nx`, icon: 'data:image/jpeg;base64,AAAA' }, 1)[0];
  assert.equal(long.name.length, 60);
  assert.equal(long.icon, '');
  const png = `data:image/png;base64,${'A'.repeat(100)}`;
  assert.equal(upsert([], { url: 'https://a.example.com', name: 'a', icon: png }, 1)[0].icon, png);
  assert.equal(upsert([], { url: 'https://a.example.com', name: 'a', icon: `data:image/png;base64,${'A'.repeat(30000)}` }, 1)[0].icon, '');
  assert.equal(upsert([], { url: 'https://a.example.com', name: '', icon: '' }, 1)[0].name, 'a.example.com');
});

test('the list is capped and the oldest entry is dropped', () => {
  let list = [];
  for (let i = 0; i < MAX_SERVERS + 5; i++) list = upsert(list, { url: `https://h${i}.example.com`, name: `h${i}`, icon: '' }, i);
  assert.equal(list.length, MAX_SERVERS);
  assert.equal(list[0].url, `https://h${MAX_SERVERS + 4}.example.com`);
  assert.equal(list.some((e) => e.url === 'https://h0.example.com'), false);
});

test('switchTarget accepts https, and http only for a server already known', () => {
  const known = upsert([], { url: 'http://lan.example.com:8080', name: 'lan', icon: '' }, 1);
  assert.equal(switchTarget('https://New.Example.com/path', known), 'https://new.example.com');
  assert.equal(switchTarget('http://lan.example.com:8080/x', known), 'http://lan.example.com:8080');
  assert.equal(switchTarget('http://other.example.com', known), null);
  for (const bad of ['javascript:alert(1)', 'file:///c:/x', 'data:text/html,x', 'https://u:p@x.example.com', '', null]) assert.equal(switchTarget(bad, known), null);
});

test('remove and setSignIn', () => {
  let list = upsert([], { url: 'https://a.example.com', name: 'a', icon: '' }, 1);
  assert.equal(setSignIn(list, 'https://a.example.com', 'bogus')[0].signIn, null);
  assert.equal(setSignIn(list, 'https://a.example.com', 'session')[0].signIn, 'session');
  assert.equal(setSignIn(list, 'https://nope.example.com', 'keep')[0].signIn, null);
  assert.deepEqual(remove(list, 'https://a.example.com/'), []);
  assert.equal(remove(list, 'https://other.example.com').length, 1);
});
