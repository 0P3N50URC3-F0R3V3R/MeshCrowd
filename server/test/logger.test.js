'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const { db } = require('../db');
const logger = require('../lib/logger');

const logDir = path.join(tmpDir, 'logs');
const day = new Date().toISOString().slice(0, 10);

test.before(() => { for (const m of ['log', 'warn', 'error']) console[m] = () => {}; });
test.after(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });
test.beforeEach(() => {
  logger.configure({ dir: logDir, maxFileMb: 10, keepDays: 30 });
  fs.mkdirSync(logDir, { recursive: true });
  for (const f of fs.readdirSync(logDir)) fs.rmSync(path.join(logDir, f));
  logger.setLevel('debug');
});

test('level filter drops lower levels', () => {
  const seen = [];
  const off = logger.subscribe((e) => seen.push(e.level));
  logger.setLevel('warn');
  logger.log('i'); logger.debug('d'); logger.warn('w'); logger.error('e');
  off();
  assert.deepEqual(seen, ['warn', 'error']);
  assert.equal(logger.getLevel(), 'warn');
});

test('subscribe receives entries and unsubscribe stops them', () => {
  const seen = [];
  const off = logger.subscribe((e) => seen.push(e));
  logger.scoped('ssh').info('hello');
  off();
  logger.scoped('ssh').info('later');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].category, 'ssh');
  assert.equal(seen[0].level, 'info');
  assert.equal(seen[0].message, 'hello');
  assert.ok(seen[0].ts);
});

test('mask hides secret values', () => {
  const out = logger.mask('password=hunter2 token: abc apiKey="x y" ok=1');
  assert.ok(!out.includes('hunter2'));
  assert.ok(!out.includes('abc'));
  assert.ok(!out.includes('x y'));
  assert.ok(out.includes('ok=1'));
});

test('written lines and emitted entries are masked', () => {
  const seen = [];
  const off = logger.subscribe((e) => seen.push(e));
  logger.log('login password=hunter2');
  off();
  assert.ok(!seen[0].message.includes('hunter2'));
  assert.ok(!fs.readFileSync(path.join(logDir, `dismesh-${day}.log`), 'utf8').includes('hunter2'));
});

test('readRecent returns the last n entries and honours minLevel', () => {
  logger.log('one'); logger.warn('two'); logger.log('three');
  assert.deepEqual(logger.readRecent(2).map((e) => e.message), ['two', 'three']);
  assert.deepEqual(logger.readRecent(5, 'warn').map((e) => e.message), ['two']);
});

test('rotation creates numbered files when the size cap is hit', () => {
  logger.configure({ maxFileMb: 0.0001 });
  for (let i = 0; i < 20; i++) logger.log(`line ${i} ${'x'.repeat(50)}`);
  const names = logger.listFiles().map((f) => f.name);
  assert.ok(names.includes(`dismesh-${day}.log`));
  assert.ok(names.includes(`dismesh-${day}.1.log`));
  assert.equal(logger.readRecent(100).length, 20);
});

test('pruneOldFiles removes files older than keepDays', () => {
  const old = path.join(logDir, 'dismesh-2020-01-01.log');
  fs.writeFileSync(old, 'x');
  const t = new Date(Date.now() - 40 * 86400000);
  fs.utimesSync(old, t, t);
  logger.log('fresh');
  assert.equal(logger.pruneOldFiles(), 1);
  assert.ok(!fs.existsSync(old));
  assert.equal(logger.listFiles().length, 1);
});

test('writing to an unwritable dir never throws', () => {
  const blocker = path.join(tmpDir, 'blocker');
  fs.writeFileSync(blocker, 'x');
  logger.configure({ dir: path.join(blocker, 'sub') });
  assert.doesNotThrow(() => logger.error('boom'));
});
