'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { isPermissionAllowed, isServerOrigin, isLocalAppPage } = require('./permissions');

const SERVER = 'https://192.168.1.10:8443/';

test('server origin gets the chat permissions only', () => {
  for (const p of ['media', 'display-capture', 'notifications', 'clipboard-sanitized-write', 'fullscreen']) {
    assert.strictEqual(isPermissionAllowed(p, 'https://192.168.1.10:8443/app', SERVER), true, p);
  }
  for (const p of ['geolocation', 'midi', 'midiSysex', 'hid', 'serial', 'usb', 'openExternal', 'clipboard-read', 'pointerLock', 'unknown']) {
    assert.strictEqual(isPermissionAllowed(p, 'https://192.168.1.10:8443/', SERVER), false, p);
  }
});

test('other origins, local pages and bad config get nothing', () => {
  assert.strictEqual(isPermissionAllowed('media', 'https://evil.example/', SERVER), false);
  assert.strictEqual(isPermissionAllowed('media', 'http://192.168.1.10:8443/', SERVER), false);
  assert.strictEqual(isPermissionAllowed('media', 'https://192.168.1.10:9999/', SERVER), false);
  assert.strictEqual(isPermissionAllowed('media', 'file:///C:/app/connect.html', SERVER), false);
  assert.strictEqual(isPermissionAllowed('media', 'null', 'file:///C:/app/connect.html'), false);
  assert.strictEqual(isPermissionAllowed('media', 'https://192.168.1.10:8443/', null), false);
  assert.strictEqual(isPermissionAllowed('media', 'https://192.168.1.10:8443/', 'not a url'), false);
  assert.strictEqual(isPermissionAllowed('media', '', SERVER), false);
  assert.strictEqual(isServerOrigin(undefined, SERVER), false);
});

test('isLocalAppPage accepts only files inside the renderer dir', () => {
  const dir = path.join(__dirname, 'renderer');
  assert.strictEqual(isLocalAppPage(pathToFileURL(path.join(dir, 'connect.html')).href + '?host=x', dir), true);
  assert.strictEqual(isLocalAppPage(pathToFileURL(path.join(__dirname, 'main.js')).href, dir), false);
  assert.strictEqual(isLocalAppPage(pathToFileURL(path.join(dir, '..', 'x.html')).href, dir), false);
  for (const bad of ['https://192.168.1.10:8443/connect.html', 'about:blank', '', null, undefined, 'junk']) {
    assert.strictEqual(isLocalAppPage(bad, dir), false, String(bad));
  }
});
