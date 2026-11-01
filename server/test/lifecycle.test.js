'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const { db } = require('../db');
const lifecycle = require('../lib/lifecycle');
const backup = require('../lib/backup');
const { createRegistry } = require('../console/registry');
const registerBackup = require('../console/commands/backup');
const { supervise, forwardedSignals } = require('../supervisor');

test.before(() => { for (const m of ['log', 'warn', 'error']) console[m] = () => {}; });
test.after(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

const realExit = process.exit;
let exits;
test.beforeEach(() => {
  exits = [];
  process.exit = (code) => { exits.push(code); };
  lifecycle._test.reset();
  lifecycle._test.setDb({ close() {} });
});
test.afterEach(() => { process.exit = realExit; });

function localCtx(out) {
  return { session: { kind: 'local', userId: null, username: 'local' }, write: (t) => out.push(t), writeln: (t) => out.push(`${t}\n`), ask: async () => '', confirm: async () => true, close() {} };
}

test('shutdown runs closers in reverse order and survives a throwing closer', async () => {
  const order = [];
  lifecycle.registerCloser('a', () => { order.push('a'); });
  lifecycle.registerCloser('b', () => { order.push('b'); throw new Error('boom'); });
  lifecycle.registerCloser('c', async () => { order.push('c'); });
  await lifecycle.shutdown({ restart: false });
  assert.deepEqual(order, ['c', 'b', 'a']);
  assert.deepEqual(exits, [0]);
});

test('restart exits with 42', async () => {
  await lifecycle.shutdown({ restart: true });
  assert.deepEqual(exits, [42]);
});

test('db.close on an already closed handle is tolerated', async () => {
  lifecycle._test.setDb({ close() { throw new Error('database is not open'); } });
  await lifecycle.shutdown({ restart: true });
  assert.deepEqual(exits, [42]);
});

test('a pending countdown can be cancelled and nothing runs', async () => {
  let ran = false;
  lifecycle.registerCloser('x', () => { ran = true; });
  const p = lifecycle.shutdown({ restart: true, delaySeconds: 60, announce: false });
  assert.ok(lifecycle.pending());
  assert.equal(lifecycle.cancel(), true);
  await p;
  assert.equal(lifecycle.pending(), null);
  assert.equal(ran, false);
  assert.deepEqual(exits, []);
  assert.equal(lifecycle.cancel(), false);
});

test('a short countdown completes then exits', async () => {
  const t0 = Date.now();
  await lifecycle.shutdown({ restart: false, delaySeconds: 0.05, announce: false });
  assert.ok(Date.now() - t0 >= 40);
  assert.deepEqual(exits, [0]);
});

test('countdown announces to online users', async () => {
  const presence = require('../lib/presence');
  const sent = [];
  const ws = { OPEN: 1, readyState: 1, send: (s) => sent.push(JSON.parse(s)) };
  presence.registerConnection(987654, ws);
  try {
    await lifecycle.shutdown({ restart: true, delaySeconds: 0.02 });
  } finally { presence.unregisterConnection(987654, ws); }
  assert.ok(sent.length >= 1);
  assert.equal(sent[0].type, 'server_notice');
  assert.match(sent[0].text, /restart/);
});

test('stopForRestore stops closers once, keeps the process, resume restores', async () => {
  const log = [];
  lifecycle.registerCloser('srv', () => { log.push('stop'); }, { resume: () => { log.push('resume'); } });
  const { resume } = await lifecycle.stopForRestore();
  assert.deepEqual(log, ['stop']);
  assert.deepEqual(exits, []);
  await lifecycle.shutdown({ restart: true, announce: false });
  assert.deepEqual(log, ['stop']);
  assert.deepEqual(exits, [42]);
  resume();
  assert.deepEqual(log, ['stop', 'resume']);
});

test('backup restore through the registry: stopForRestore -> restore -> restart(42)', async () => {
  const calls = [];
  lifecycle.registerCloser('srv', () => { calls.push('stopped'); });
  const orig = backup.restoreBackup;
  backup.restoreBackup = async (name) => { calls.push(`restore ${name}`); };
  process.exit = (code) => { calls.push(`exit ${code}`); exits.push(code); };
  const registry = createRegistry();
  registerBackup(registry);
  const out = [];
  try {
    await registry.execute('backup restore backup-20260101-000000-000-manual.zip --yes', localCtx(out));
  } finally { backup.restoreBackup = orig; }
  assert.deepEqual(calls, ['stopped', 'restore backup-20260101-000000-000-manual.zip', 'exit 42']);
  assert.match(out.join(''), /restored/);
});

test('backup restore that fails after the live db closed still restarts', async () => {
  const calls = [];
  lifecycle.registerCloser('srv', () => { calls.push('stopped'); });
  lifecycle._test.setDb({ close() { calls.push('dbclose'); throw new Error('database is not open'); } });
  const orig = backup.restoreBackup;
  backup.restoreBackup = async () => { const e = new Error('copy failed'); e.liveDbClosed = true; throw e; };
  const registry = createRegistry();
  registerBackup(registry);
  const out = [];
  try {
    await registry.execute('backup restore backup-20260101-000000-000-manual.zip --yes', localCtx(out));
  } finally { backup.restoreBackup = orig; }
  assert.deepEqual(calls, ['stopped', 'dbclose']);
  assert.deepEqual(exits, [42]);
  assert.match(out.join(''), /copy failed/);
});

test('backup restore that fails before the db closed resumes and does not exit', async () => {
  const calls = [];
  lifecycle.registerCloser('srv', () => { calls.push('stopped'); }, { resume: () => { calls.push('resumed'); } });
  const orig = backup.restoreBackup;
  backup.restoreBackup = async () => { throw new Error('verification failed'); };
  const registry = createRegistry();
  registerBackup(registry);
  const out = [];
  try {
    await registry.execute('backup restore backup-20260101-000000-000-manual.zip --yes', localCtx(out));
  } finally { backup.restoreBackup = orig; }
  assert.deepEqual(calls, ['stopped', 'resumed']);
  assert.deepEqual(exits, []);
  assert.match(out.join(''), /verification failed/);
});

test('supervisor restarts the child on exit 42 and stops on any other code', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-sup-'));
  const counter = path.join(dir, 'count');
  const script = path.join(dir, 'child.js');
  fs.writeFileSync(script, `
const fs = require('fs');
const f = ${JSON.stringify(counter)};
const n = (fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 0) + 1;
fs.writeFileSync(f, String(n));
process.exit(n < 3 ? 42 : 0);
`);
  try {
    const code = await supervise(script, { stdio: 'ignore' });
    assert.equal(code, 0);
    assert.equal(fs.readFileSync(counter, 'utf8'), '3');
    fs.writeFileSync(script, 'process.exit(7)');
    assert.equal(await supervise(script, { stdio: 'ignore' }), 7);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a signal-style shutdown during a countdown closes immediately and runs closers', async () => {
  const order = [];
  lifecycle.registerCloser('srv', () => { order.push('closed'); });
  const countdown = lifecycle.shutdown({ restart: true, delaySeconds: 60, announce: false });
  assert.ok(lifecycle.pending());
  await lifecycle.shutdown({ restart: false, announce: false });
  await countdown;
  assert.equal(lifecycle.pending(), null);
  assert.deepEqual(order, ['closed']);
  assert.deepEqual(exits, [0]);
});

test('a second shutdown while closers run waits instead of exiting early', async () => {
  let release;
  lifecycle.registerCloser('slow', () => new Promise((r) => { release = r; }));
  const first = lifecycle.shutdown({ restart: false, announce: false });
  const second = lifecycle.shutdown({ restart: false, announce: false });
  assert.equal(second, first);
  assert.deepEqual(exits, []);
  await new Promise((r) => setTimeout(r, 10));
  release();
  await first;
  assert.deepEqual(exits, [0]);
});

test('a stuck closer is abandoned after the closer timeout and the exit code is kept', async () => {
  lifecycle._test.setTimeouts({ closer: 30, watchdog: 5000 });
  const order = [];
  lifecycle.registerCloser('first', () => { order.push('first'); });
  lifecycle.registerCloser('stuck', () => new Promise(() => {}));
  const t0 = Date.now();
  await lifecycle.shutdown({ restart: true, announce: false });
  assert.ok(Date.now() - t0 < 1000);
  assert.deepEqual(order, ['first']);
  assert.deepEqual(exits, [42]);
});

test('the watchdog forces the exit when closers overrun', async () => {
  lifecycle._test.setTimeouts({ closer: 150, watchdog: 30 });
  lifecycle.registerCloser('stuck', () => new Promise(() => {}));
  const p = lifecycle.shutdown({ restart: true, announce: false });
  await new Promise((r) => setTimeout(r, 90));
  assert.deepEqual(exits, [42]);
  await p;
});

test('supervisor forwards SIGTERM/SIGHUP but never SIGINT on POSIX, nothing on Windows', () => {
  assert.deepEqual(forwardedSignals('linux'), ['SIGTERM', 'SIGHUP']);
  assert.deepEqual(forwardedSignals('darwin'), ['SIGTERM', 'SIGHUP']);
  assert.deepEqual(forwardedSignals('win32'), []);
});

test('supervisor resolves 0 and does not restart when stopped and the child exits 42', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-sup-'));
  const counter = path.join(dir, 'count');
  const script = path.join(dir, 'child.js');
  fs.writeFileSync(script, `
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(counter)}, 'x');
setTimeout(() => process.exit(42), 500);
`);
  try {
    const p = supervise(script, { stdio: 'ignore', platform: 'linux' });
    await new Promise((r) => setTimeout(r, 250));
    process.emit('SIGINT', 'SIGINT');
    assert.equal(await p, 0);
    assert.equal(fs.readFileSync(counter, 'utf8'), 'x');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
