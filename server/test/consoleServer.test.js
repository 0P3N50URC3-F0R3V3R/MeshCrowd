'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const { db } = require('../db');
const presence = require('../lib/presence');
const lifecycle = require('../lib/lifecycle');
const metrics = require('../lib/metrics');
const { createRegistry } = require('../console/registry');
const registerServer = require('../console/commands/server');
const { registerAll } = require('../console/bootstrap');

test.before(() => { for (const m of ['log', 'warn', 'error']) console[m] = () => {}; metrics.start(); });
test.after(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

const registry = createRegistry();
registerServer(registry);

const LOCAL = { kind: 'local', userId: null, username: 'local' };

function makeCtx(extra = {}) {
  const out = [];
  const ctx = { session: LOCAL, write: (t) => out.push(t), writeln: (t) => out.push(`${t}\n`), ask: async () => '', confirm: async () => true, close() {}, ...extra };
  ctx.text = () => out.join('');
  return ctx;
}

async function run(line, extra) {
  const ctx = makeCtx(extra);
  await registry.execute(line, ctx);
  return ctx.text();
}

let seq = 0;
function addUser(username, displayName) {
  seq += 1;
  return Number(db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)').run(username, `${username}${seq}@x.test`, 'x', displayName).lastInsertRowid);
}

function fakeWs(sent) { return { OPEN: 1, readyState: 1, send: (s) => sent.push(JSON.parse(s)) }; }

test('list shows online users once with connection count, sorted, with total', async () => {
  const zed = addUser('zed', 'Zed Z');
  const amy = addUser('amy', 'Amy A');
  const w1 = fakeWs([]); const w2 = fakeWs([]); const w3 = fakeWs([]);
  presence.registerConnection(zed, w1); presence.registerConnection(zed, w2); presence.registerConnection(amy, w3);
  try {
    const out = await run('list');
    const lines = out.trim().split('\n');
    const rows = lines.filter((l) => /\b(amy|zed)\b/.test(l));
    assert.equal(rows.length, 2);
    assert.match(rows[0], /amy/);
    assert.match(rows[1], /zed/);
    assert.match(rows[1], /Zed Z/);
    assert.match(rows[1], /\b2\b/);
    assert.match(lines[lines.length - 1], /2 users online, 3 connections/);
    const filtered = await run('list ZE');
    assert.match(filtered, /zed/);
    assert.doesNotMatch(filtered, /amy/);
    assert.match(filtered, /1 user/);
  } finally {
    presence.unregisterConnection(zed, w1); presence.unregisterConnection(zed, w2); presence.unregisterConnection(amy, w3);
  }
  assert.match(await run('list'), /0 users online/);
});

test('announce broadcasts to online users', async () => {
  const id = addUser('listener', 'L');
  const sent = [];
  const ws = fakeWs(sent);
  presence.registerConnection(id, ws);
  try {
    const out = await run('announce maintenance at noon');
    assert.match(out, /1 online user/);
  } finally { presence.unregisterConnection(id, ws); }
  assert.equal(sent[0].type, 'server_notice');
  assert.equal(sent[0].text, 'maintenance at noon');
  assert.match(await run('announce'), /usage/);
});

test('status prints the key facts', async () => {
  const out = await run('status');
  for (const k of ['version', 'uptime', 'memory', 'online', 'ports', 'ssh', 'turn', 'federation', 'log level', 'last backup']) assert.match(out, new RegExp(k), k);
});

test('stats prints a table and survives without onInterrupt', async () => {
  const out = await run('stats');
  for (const k of ['cpu', 'load', 'memory', 'event loop', 'requests', 'db', 'turn', 'warn']) assert.match(out, new RegExp(k, 'i'), k);
  const watch = await run('stats watch 1');
  assert.match(watch, /cpu/i);
});

test('stats watch refreshes until interrupted and cleans up', async () => {
  let handler = null;
  let disposed = false;
  const ctx = makeCtx({ onInterrupt: (fn) => { handler = fn; return () => { disposed = true; }; } });
  const p = registry.execute('stats watch 0.1', ctx);
  await new Promise((r) => setTimeout(r, 350));
  handler();
  await p;
  assert.ok(ctx.text().split('\x1b[2J').length - 1 >= 2);
  assert.equal(disposed, true);
  assert.match(await run('stats watch abc'), /usage|invalid/);
});

test('server stop/restart confirm, honour --yes, schedule and cancel', async () => {
  const calls = [];
  const orig = lifecycle.shutdown;
  lifecycle.shutdown = (opts) => { calls.push(opts); return new Promise(() => {}); };
  try {
    assert.match(await run('server restart', { confirm: async () => false }), /cancelled/);
    assert.deepEqual(calls, []);
    assert.match(await run('server restart 30 --yes'), /30 seconds/);
    assert.deepEqual(calls[0], { restart: true, delaySeconds: 30, announce: true });
    await run('server stop --yes');
    assert.deepEqual(calls[1], { restart: false, delaySeconds: 0, announce: true });
    assert.match(await run('server stop -5 --yes'), /usage|invalid/);
  } finally { lifecycle.shutdown = orig; }
});

test('server cancel reports a scheduled stop', async () => {
  assert.match(await run('server cancel'), /nothing/);
  const realExit = process.exit;
  process.exit = () => {};
  try {
    const p = lifecycle.shutdown({ restart: false, delaySeconds: 60, announce: false });
    assert.match(await run('server stop --yes'), /already scheduled/);
    assert.match(await run('server cancel'), /cancelled/);
    await p;
  } finally { process.exit = realExit; }
});

test('registerAll registers every command module without duplicates and help lists them', async () => {
  const fresh = createRegistry();
  registerAll(fresh);
  const names = fresh.listFor(LOCAL).map((d) => d.name);
  assert.equal(new Set(names).size, names.length);
  for (const n of ['help', 'exit', 'status', 'list', 'stats', 'stats watch', 'announce', 'server stop', 'server restart', 'server cancel',
    'account list', 'kick', 'ban', 'config get', 'config set', 'backup create', 'backup restore']) {
    assert.ok(names.includes(n), n);
  }
  const ctx = makeCtx();
  await fresh.execute('help', ctx);
  const help = ctx.text();
  for (const n of ['status', 'announce', 'server restart', 'backup restore', 'account list']) assert.ok(help.includes(n), n);
  assert.throws(() => registerAll(fresh), /already registered/);
});
