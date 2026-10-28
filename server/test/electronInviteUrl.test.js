'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMcrUrl, findMcrLink, inviteTarget } = require('../../electron/inviteUrl');

test('parseMcrUrl accepts host, host:port, ip, vanity and encoded federated codes', () => {
  assert.deepEqual(parseMcrUrl('mcr://chat.example.com:8443/abc12345'), { host: 'chat.example.com:8443', code: 'abc12345' });
  assert.deepEqual(parseMcrUrl('MCR://Chat.Example.com/my-server/'), { host: 'chat.example.com', code: 'my-server' });
  assert.deepEqual(parseMcrUrl('mcr://192.168.1.10:8443/abc'), { host: '192.168.1.10:8443', code: 'abc' });
  assert.deepEqual(parseMcrUrl('mcr://h.example/abc%40other.example'), { host: 'h.example', code: 'abc@other.example' });
});

test('parseMcrUrl rejects hostile or malformed links', () => {
  for (const bad of ['', 'https://x/abc', 'mcr://', 'mcr://host', 'mcr://host/', 'mcr://u:p@host/abc', 'mcr://host/abc?x=1', 'mcr://host/abc#x',
    'mcr://host:99999/abc', 'mcr://host/a b', 'mcr://host/%E0%A4%A', 'mcr://ho st/abc', 'mcr://host/a/b', 'mcr://' + 'a'.repeat(300) + '/x', null, 42]) {
    assert.equal(parseMcrUrl(bad), null, String(bad));
  }
});

test('findMcrLink picks the first valid link out of argv', () => {
  assert.deepEqual(findMcrLink(['C:\\x\\MeshCrowd.exe', '--flag', 'mcr://h.example/abc']), { host: 'h.example', code: 'abc' });
  assert.equal(findMcrLink(['a', 'b']), null);
});

test('inviteTarget keeps the configured server scheme and flags a switch', () => {
  const link = { host: 'h.example:8443', code: 'abc@d.example' };
  assert.deepEqual(inviteTarget(link, 'https://h.example:8443/'), { origin: 'https://h.example:8443', sameServer: true, url: 'https://h.example:8443/#invite=abc%40d.example' });
  assert.equal(inviteTarget({ host: 'h.example:8080', code: 'a' }, 'http://h.example:8080').origin, 'http://h.example:8080');
  const other = inviteTarget(link, 'https://elsewhere.example');
  assert.equal(other.sameServer, false);
  assert.equal(other.origin, 'https://h.example:8443');
  assert.equal(inviteTarget(link, null).sameServer, false);
});
