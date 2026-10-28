'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;
const { db } = require('../db');
const php = require('../lib/phpRuntime');

test.after(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

test('resolveBinary prefers the configured path', () => {
  assert.equal(php.resolveBinary({ sites: { phpPath: 'C:\\x\\php.exe' } }), 'C:\\x\\php.exe');
  assert.equal(typeof php.resolveBinary({}), 'string');
});

test('classifyExit maps the Windows missing-DLL codes to vcredist-missing', () => {
  assert.equal(php.classifyExit(-1073741515), 'vcredist-missing'); // 0xC0000135 as a signed int
  assert.equal(php.classifyExit(0xC0000135), 'vcredist-missing');
  assert.equal(php.classifyExit(-1073741701), 'vcredist-missing'); // 0xC000007B
  assert.equal(php.classifyExit(1), 'failed');
});

test('check reports not-found for a missing binary and ok for a working one', () => {
  const missing = php.check(path.join(tmpDir, 'nope', 'php.exe'));
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'not-found');
  const ok = php.check(process.execPath); // `node -v` stands in for `php -v`
  assert.equal(ok.ok, true);
  assert.match(ok.version, /\S/);
});

test('launchSpec sandboxes the process and never forwards app secrets', async () => {
  process.env.DISMESH_SECRET_TEST = 'leak-me';
  await php.init({ sites: { phpPath: process.execPath } });
  const docroot = path.join(tmpDir, 'sites', '7');
  const spec = php.launchSpec({ siteId: 7, port: 45678, docroot });
  const joined = spec.args.join(' ');
  assert.ok(spec.args.includes(`open_basedir="${path.resolve(docroot)}"`));
  assert.match(joined, /disable_functions=[^ ]*shell_exec/);
  assert.match(joined, /allow_url_include=0/);
  assert.ok(spec.args.includes('127.0.0.1:45678'));
  assert.ok(spec.args.includes('-t'));
  assert.equal(spec.cwd, path.resolve(docroot));
  assert.ok(!('DISMESH_SECRET_TEST' in spec.env));
  assert.ok(Object.keys(spec.env).every((k) => ['PATH', 'SystemRoot', 'TEMP', 'TMP'].includes(k)));
});

test('path values are quoted so php.ini does not read "~" (8.3 short names) as an operator', async () => {
  await php.init({ sites: { phpPath: process.execPath } });
  const docroot = path.join(tmpDir, 'RENDSZ~1', 'sites', '7');
  const spec = php.launchSpec({ siteId: 7, port: 45678, docroot });
  const basedir = spec.args.find((a) => a.startsWith('open_basedir='));
  assert.equal(basedir, `open_basedir="${path.resolve(docroot)}"`);
  assert.ok(basedir.includes('~'));
});

test('a real short-name docroot is expanded to its long path before it reaches open_basedir', async () => {
  if (process.platform !== 'win32') return;
  if (!tmpDir.includes('~')) return; // os.tmpdir() is a long path here, so there is no short name to expand
  const docroot = path.join(tmpDir, 'a long folder name');
  fs.mkdirSync(docroot, { recursive: true });
  await php.init({ sites: { phpPath: process.execPath } });
  const spec = php.launchSpec({ siteId: 7, port: 45678, docroot });
  assert.equal(spec.cwd, fs.realpathSync.native(docroot));
  assert.ok(!spec.cwd.includes('~'));
});

test('init records the status', async () => {
  const s = await php.init({ sites: { phpPath: process.execPath } });
  assert.equal(s.ok, true);
  assert.equal(php.getStatus().ok, true);
  const bad = await php.init({ sites: { phpPath: path.join(tmpDir, 'missing', 'php.exe') } });
  assert.equal(bad.ok, false);
  assert.equal(php.getStatus().reason, 'not-found');
});
