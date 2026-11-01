'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { PassThrough } = require('node:stream');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const { db } = require('../db');
const logger = require('../lib/logger');
const config = require('../lib/config');
const { createRegistry } = require('../console/registry');
const { registerAll } = require('../console/bootstrap');
const { createLogFeed } = require('../console/logFeed');
const local = require('../console/local');

test.before(() => { for (const m of ['log', 'warn', 'error']) console[m] = () => {}; });
test.after(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const registry = createRegistry();
registerAll(registry);

function boot(extra = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let text = '';
  stdout.on('data', (c) => { text += c; });
  const con = local.start({ stdin, stdout, registry, terminal: true, color: false, ...extra });
  return { stdin, stdout, con, text: () => text, clear: () => { text = ''; } };
}

const sshCtx = (extra = {}) => {
  const out = [];
  return { session: { kind: 'ssh', userId: 1, username: 'root' }, write: (t) => out.push(t), writeln: (t) => out.push(`${t}\n`), ask: async () => '', confirm: async () => true, close() {}, text: () => out.join(''), ...extra };
};

test('banner, prompt and help', async () => {
  const h = boot();
  await tick();
  assert.match(h.text(), /Type help for commands/);
  assert.match(h.text(), /meshcrowd> /);
  h.clear();
  h.stdin.write('help\n');
  await tick(60);
  assert.match(h.text(), /log tail/);
  h.con.stop();
});

test('a log entry mid-line is printed and the typed text redrawn', async () => {
  const h = boot();
  await tick();
  h.clear();
  h.stdin.write('par');
  await tick();
  logger.scoped('test').error('boom happened');
  await tick();
  const t = h.text();
  assert.match(t, /boom happened/);
  assert.ok(t.indexOf('boom happened') < t.lastIndexOf('meshcrowd> par'), 'prompt with partial input redrawn after entry');
  h.con.stop();
});

test('local console streams the live log at the current level', async () => {
  const h = boot();
  await tick();
  logger.setLevel('warn');
  h.clear();
  logger.scoped('t').info('quiet one');
  logger.scoped('t').warn('loud one');
  await tick();
  assert.doesNotMatch(h.text(), /quiet one/);
  assert.match(h.text(), /loud one/);
  logger.setLevel('info');
  h.con.stop();
});

test('secret prompt does not echo and is kept out of history', async () => {
  let secret;
  const reg = createRegistry();
  reg.register({ name: 'pw', area: 'x', summary: '', usage: 'pw', async run(a, ctx) { secret = await ctx.ask('Password:', { secret: true }); return 'ok'; } });
  const h = boot({ registry: reg });
  await tick();
  h.clear();
  h.stdin.write('pw\n');
  await tick();
  h.stdin.write('hunter2xyz\n');
  await tick(60);
  assert.equal(secret, 'hunter2xyz');
  assert.doesNotMatch(h.text(), /hunter2xyz/);
  assert.match(h.text(), /Password:/);
  assert.ok(!h.con.rl.history.some((l) => l.includes('hunter2xyz')));
  assert.ok(h.con.rl.history.includes('pw'));
  h.con.stop();
});

test('q interrupts a running command through ctx.onInterrupt', async () => {
  const reg = createRegistry();
  reg.register({ name: 'hold', area: 'x', summary: '', usage: 'hold', async run(a, ctx) { let off; await new Promise((res) => { off = ctx.onInterrupt(res); }); off(); return 'released'; } });
  const h = boot({ registry: reg });
  await tick();
  h.stdin.write('hold\n');
  await tick();
  h.clear();
  h.stdin.write('q');
  await tick(60);
  assert.match(h.text(), /released/);
  h.con.stop();
});

test('Ctrl+C interrupts a running watch; at the prompt it needs two presses', async () => {
  const reg = createRegistry();
  reg.register({ name: 'hold', area: 'x', summary: '', usage: 'hold', async run(a, ctx) { let off; await new Promise((res) => { off = ctx.onInterrupt(res); }); off(); return 'released'; } });
  let exits = 0;
  const h = boot({ registry: reg, onExit: () => { exits++; } });
  await tick();
  h.stdin.write('hold\n');
  await tick();
  h.stdin.write('\x03');
  await tick(60);
  assert.match(h.text(), /released/);
  assert.equal(exits, 0);
  h.clear();
  h.stdin.write('\x03');
  await tick();
  assert.match(h.text(), /Ctrl\+C again/);
  assert.equal(exits, 0);
  h.stdin.write('\x03');
  await tick();
  assert.equal(exits, 1);
  h.con.stop();
});

test('log tail (ssh ctx) streams entries at or above the level until interrupted', async () => {
  let fire;
  const ctx = sshCtx({ onInterrupt: (fn) => { fire = fn; return () => {}; } });
  const p = registry.execute('log tail warn', ctx);
  await tick();
  logger.scoped('t').info('tail-info');
  logger.scoped('t').warn('tail-warn');
  fire();
  await p;
  assert.match(ctx.text(), /tail-warn/);
  assert.doesNotMatch(ctx.text(), /tail-info/);
  logger.scoped('t').warn('after-tail');
  assert.doesNotMatch(ctx.text(), /after-tail/);
});

test('log tail accepts an AbortSignal fallback and refuses without any stop channel', async () => {
  const ac = new AbortController();
  const ctx = sshCtx({ signal: ac.signal });
  const p = registry.execute('log tail', ctx);
  await tick();
  logger.scoped('t').info('signal-entry');
  ac.abort();
  await p;
  assert.match(ctx.text(), /signal-entry/);
  const bare = sshCtx();
  await registry.execute('log tail', bare);
  assert.match(bare.text(), /interactive/);
});

test('log tail on the local console says the live log is already shown', async () => {
  const ctx = sshCtx({ session: { kind: 'local', userId: null, username: 'console' }, liveLog: true });
  await registry.execute('log tail', ctx);
  assert.match(ctx.text(), /already/);
});

test('log level shows, sets live, persists, and validates', async () => {
  const ctx = sshCtx();
  await registry.execute('log level', ctx);
  assert.match(ctx.text(), /info/);
  await registry.execute('log level warn', ctx);
  assert.equal(logger.getLevel(), 'warn');
  assert.equal(config.load().logging.level, 'warn');
  const bad = sshCtx();
  await registry.execute('log level loud', bad);
  assert.match(bad.text(), /usage/);
  assert.equal(logger.getLevel(), 'warn');
  logger.setLevel('info');
  config.save({ logging: { level: 'info' } });
});

test('log show and log files', async () => {
  logger.scoped('show').info('persisted-line-1');
  logger.scoped('show').warn('persisted-line-2');
  const ctx = sshCtx();
  await registry.execute('log show 5 warn', ctx);
  assert.match(ctx.text(), /persisted-line-2/);
  assert.doesNotMatch(ctx.text(), /persisted-line-1/);
  const bad = sshCtx();
  await registry.execute('log show 0', bad);
  assert.match(bad.text(), /usage/);
  const files = sshCtx();
  await registry.execute('log files', files);
  assert.match(files.text(), /dismesh-\d{4}-\d{2}-\d{2}\.log\s+\d/);
});

test('createLogFeed colors by level only when asked and filters by minLevel', () => {
  const out = [];
  const feed = createLogFeed({ write: (l) => out.push(l), minLevel: 'warn', color: true });
  feed.start();
  logger.scoped('c').info('nope');
  logger.scoped('c').warn('yellow');
  logger.scoped('c').error('red');
  feed.stop();
  logger.scoped('c').error('after');
  assert.equal(out.length, 2);
  assert.match(out[0], /\x1b\[33m.*yellow/);
  assert.match(out[1], /\x1b\[31m.*red/);
  const plain = [];
  const f2 = createLogFeed({ write: (l) => plain.push(l), minLevel: 'debug', color: false });
  f2.start();
  logger.setLevel('debug');
  logger.scoped('c').debug('dbg');
  logger.setLevel('info');
  f2.stop();
  assert.doesNotMatch(plain[0], /\x1b/);
});
