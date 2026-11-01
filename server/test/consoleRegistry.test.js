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
const { parseLine } = require('../console/parser');
const { createRegistry } = require('../console/registry');
const registerCore = require('../console/commands/core');

test.before(() => { for (const m of ['log', 'warn', 'error']) console[m] = () => {}; });
test.after(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

function makeCtx(kind = 'local') {
  const out = [];
  let closed = false;
  return {
    session: { kind, userId: kind === 'local' ? null : 1, username: 'root' },
    write: (t) => out.push(t),
    writeln: (t) => out.push(`${t}\n`),
    ask: async () => '',
    confirm: async () => true,
    close: () => { closed = true; },
    text: () => out.join(''),
    isClosed: () => closed,
  };
}

function makeRegistry() {
  const r = createRegistry();
  registerCore(r);
  r.register({ name: 'account create', area: 'account', summary: 'Create an account', usage: 'account create <name>', examples: ['account create bob'], run: async () => {} });
  r.register({ name: 'account list', area: 'account', summary: 'List accounts', usage: 'account list', run: async () => {} });
  r.register({ name: 'backup now', area: 'backup', summary: 'Run a backup', usage: 'backup now', local: true, run: async () => {} });
  return r;
}

test('parseLine splits quotes, escapes and flags', () => {
  assert.deepEqual(parseLine('account create "Bob Smith" --yes'), ['account', 'create', 'Bob Smith', '--yes']);
  assert.deepEqual(parseLine('say \'a b\' c\\ d "e\\"f"'), ['say', 'a b', 'c d', 'e"f']);
  assert.deepEqual(parseLine('  x  "" '), ['x', '']);
  assert.deepEqual(parseLine(''), []);
});

test('parseLine throws on unterminated quote', () => {
  assert.throws(() => parseLine('a "b c'), { message: 'unterminated quote' });
});

test('help lists commands grouped by area and hides local commands from ssh', async () => {
  const r = makeRegistry();
  const local = makeCtx('local');
  await r.execute('help', local);
  for (const n of ['help', 'exit', 'account create', 'account list', 'backup now']) assert.ok(local.text().includes(n), n);
  assert.ok(local.text().includes('account:') && local.text().includes('general:'));
  const ssh = makeCtx('ssh');
  await r.execute('help', ssh);
  assert.ok(!ssh.text().includes('backup now'));
  assert.ok(ssh.text().includes('account create'));
});

test('help <area> and help <command>', async () => {
  const r = makeRegistry();
  const a = makeCtx();
  await r.execute('help account', a);
  assert.ok(a.text().includes('account create') && a.text().includes('account list'));
  assert.ok(!a.text().includes('backup now'));
  const c = makeCtx();
  await r.execute('help account create', c);
  assert.ok(c.text().includes('usage: account create <name>') && c.text().includes('Create an account') && c.text().includes('account create bob'));
});

test('help hides local command details from ssh', async () => {
  const r = makeRegistry();
  const ssh = makeCtx('ssh');
  await r.execute('help backup now', ssh);
  assert.ok(ssh.text().includes('unknown command'));
});

test('unknown command suggests closest match', async () => {
  const r = makeRegistry();
  const ctx = makeCtx();
  await r.execute('hlep', ctx);
  assert.match(ctx.text(), /unknown command.*did you mean help.*try help/);
  const none = makeCtx();
  await r.execute('zzzzzzzzzz', none);
  assert.ok(!none.text().includes('did you mean'));
});

test('local command refused for ssh sessions', async () => {
  const r = makeRegistry();
  const ssh = makeCtx('ssh');
  await r.execute('backup now', ssh);
  assert.ok(ssh.text().includes('unknown command'));
});

test('handler errors are written, never rejected; string results are written', async () => {
  const r = makeRegistry();
  r.register({ name: 'boom', area: 'x', summary: 's', usage: 'boom', run: async () => { throw new Error('kaput'); } });
  r.register({ name: 'hi', area: 'x', summary: 's', usage: 'hi', run: async () => 'hello' });
  const ctx = makeCtx();
  await r.execute('boom', ctx);
  await r.execute('hi', ctx);
  await r.execute('say "oops', ctx);
  assert.ok(ctx.text().includes('error: kaput'));
  assert.ok(ctx.text().includes('hello'));
  assert.ok(ctx.text().includes('error: unterminated quote'));
});

test('exit and quit close the session; completions', async () => {
  const r = makeRegistry();
  const a = makeCtx();
  await r.execute('quit', a);
  assert.ok(a.isClosed());
  const b = makeCtx();
  await r.execute('exit', b);
  assert.ok(b.isClosed());
  assert.deepEqual(r.completions('he'), ['help']);
  assert.deepEqual(r.completions('account'), ['account create', 'account list']);
});

test('completions hide local-only commands from ssh sessions', () => {
  const r = createRegistry();
  r.register({ name: 'server stop', area: 'server', summary: '', usage: '', run() {} });
  r.register({ name: 'backup restore', area: 'backup', summary: '', usage: '', local: true, run() {} });
  const ssh = { kind: 'ssh', userId: 1, username: 'root' };
  const local = { kind: 'local', userId: null, username: 'console' };
  assert.deepEqual(r.completions('backup', ssh), []);
  assert.deepEqual(r.completions('backup', local), ['backup restore']);
  assert.deepEqual(r.completions('s', ssh), ['server stop']);
});

test('duplicate registration throws', () => {
  const r = makeRegistry();
  assert.throws(() => r.register({ name: 'exit', area: 'x', summary: '', usage: '', run() {} }), /already registered/);
});

test('secrets reach handlers but never the log', async () => {
  const r = makeRegistry();
  const seen = [];
  r.register({ name: 'user add', area: 'x', summary: 's', usage: 'u', run: async (args) => { seen.push(args); } });
  r.register({ name: 'login', area: 'x', summary: 's', usage: 'u', secretArgs: true, run: async (args) => { seen.push(args); } });
  const logged = [];
  const off = logger.subscribe((e) => logged.push(e));
  const ctx = makeCtx();
  await r.execute('user add bob --password hunter2', ctx);
  await r.execute('user add bob --token=tok123 --key k9 -secret s3', ctx);
  await r.execute('login pw-positional', ctx);
  off();
  assert.deepEqual(seen[0], ['bob', '--password', 'hunter2']);
  assert.deepEqual(seen[2], ['pw-positional']);
  const all = logged.map((e) => e.message).join('\n');
  for (const s of ['hunter2', 'tok123', 'k9', 's3', 'pw-positional']) assert.ok(!all.includes(s), s);
  assert.ok(all.includes('root ran: user add bob --password ***'));
  assert.ok(logged.every((e) => e.category === 'console'));
});

test('qualified secret flags are masked in both forms', async () => {
  const r = makeRegistry();
  r.register({ name: 'cfg', area: 'x', summary: 's', usage: 'u', run: async () => {} });
  const logged = [];
  const off = logger.subscribe((e) => logged.push(e));
  await r.execute('cfg --new-password aa11 --api-key=bb22 --auth-key cc33 --totp-secret dd44 --name keep', makeCtx());
  off();
  const all = logged.map((e) => e.message).join('\n');
  for (const s of ['aa11', 'bb22', 'cc33', 'dd44']) assert.ok(!all.includes(s), s);
  assert.ok(all.includes('--name keep'));
});

test('non-Error throws print a sensible error', async () => {
  const r = makeRegistry();
  r.register({ name: 'ts', area: 'x', summary: 's', usage: 'u', run: async () => { throw 'plain'; } });
  r.register({ name: 'tn', area: 'x', summary: 's', usage: 'u', run: async () => { throw null; } });
  r.register({ name: 'tu', area: 'x', summary: 's', usage: 'u', run: async () => { throw undefined; } });
  const ctx = makeCtx();
  await r.execute('ts', ctx);
  await r.execute('tn', ctx);
  await r.execute('tu', ctx);
  assert.ok(ctx.text().includes('error: plain\n'));
  assert.equal((ctx.text().match(/error: /g) || []).length, 3);
});

test('parseLine keeps a backslash before ordinary characters', () => {
  assert.deepEqual(parseLine('cd C:\\temp\\x'), ['cd', 'C:\\temp\\x']);
  assert.deepEqual(parseLine('a "C:\\temp\\x" b\\\\c'), ['a', 'C:\\temp\\x', 'b\\c']);
});
