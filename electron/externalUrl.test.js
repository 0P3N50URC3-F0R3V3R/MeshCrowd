'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { externalUrl } = require('./externalUrl');

test('externalUrl passes web and mail links only', () => {
  assert.strictEqual(externalUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.strictEqual(externalUrl('http://example.com'), 'http://example.com/');
  assert.strictEqual(externalUrl('mailto:a@b.c'), 'mailto:a@b.c');
  for (const bad of ['file:///C:/Windows/System32/calc.exe', 'smb://evil/share', 'ms-msdt:/id', 'javascript:alert(1)', 'data:text/html,x', 'mcr://host/code', 'not a url', '', null, undefined]) {
    assert.strictEqual(externalUrl(bad), null, String(bad));
  }
});
