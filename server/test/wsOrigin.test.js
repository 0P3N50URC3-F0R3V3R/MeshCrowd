'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isAllowedWsOrigin } = require('../lib/wsOrigin');

const req = (origin, host, extra = {}) => ({ headers: { ...(origin ? { origin } : {}), ...(host ? { host } : {}), ...extra } });
const cfg = { publicHost: 'chat.example.com', trustProxy: false };

test('no Origin header (Electron loadURL, curl) is allowed', () => {
  assert.equal(isAllowedWsOrigin(req(null, 'x'), cfg), true);
});

test('publicHost and loopback origins are allowed as before', () => {
  assert.equal(isAllowedWsOrigin(req('https://chat.example.com:8443', 'other'), cfg), true);
  assert.equal(isAllowedWsOrigin(req('http://localhost:8080', 'other'), cfg), true);
  assert.equal(isAllowedWsOrigin(req('http://127.0.0.1:8080', 'other'), cfg), true);
});

test('a page served by this very server is allowed whatever address it was reached on', () => {
  assert.equal(isAllowedWsOrigin(req('http://10.0.2.2:18084', '10.0.2.2:18084'), cfg), true);
  assert.equal(isAllowedWsOrigin(req('https://192.168.1.44:8443', '192.168.1.44:8443'), cfg), true);
  assert.equal(isAllowedWsOrigin(req('https://alt.example.org', 'alt.example.org'), cfg), true);
});

test('a page from another site is refused', () => {
  assert.equal(isAllowedWsOrigin(req('https://evil.example', '192.168.1.44:8443'), cfg), false);
  assert.equal(isAllowedWsOrigin(req('http://192.168.1.44:9999', '192.168.1.44:8443'), cfg), false);
  assert.equal(isAllowedWsOrigin(req('http://192.168.1.44:8443', null), cfg), false);
  assert.equal(isAllowedWsOrigin(req('not a url', 'x'), cfg), false);
});

test('behind a trusted proxy the forwarded host counts, otherwise it is ignored', () => {
  const fwd = { 'x-forwarded-host': 'chat2.example.net, internal' };
  assert.equal(isAllowedWsOrigin(req('https://chat2.example.net', 'internal:8080', fwd), { ...cfg, trustProxy: true }), true);
  assert.equal(isAllowedWsOrigin(req('https://chat2.example.net', 'internal:8080', fwd), cfg), false);
});
