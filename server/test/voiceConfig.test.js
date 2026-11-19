'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const { db } = require('../db');
const config = require('../lib/config');
const schema = require('../lib/configSchema');
const { createRegistry } = require('../console/registry');
const registerConfig = require('../console/commands/config');

test.before(() => { for (const m of ['log', 'warn', 'error']) console[m] = () => {}; });
test.after(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

const registry = createRegistry();
registerConfig(registry);

const LOCAL = { kind: 'local', userId: null, username: 'local' };

async function run(line) {
  const out = [];
  const ctx = { session: LOCAL, write: (t) => out.push(t), writeln: (t) => out.push(`${t}\n`), ask: async () => '', confirm: async () => true, close() {} };
  await registry.execute(line, ctx);
  return out.join('');
}

test('voice defaults merge into a missing config', () => {
  fs.writeFileSync(config.CONFIG_PATH, JSON.stringify({ port: 9000, voice: { mode: 'sfu', sfu: { port: 41000 } } }));
  const cfg = config.load();
  assert.equal(cfg.voice.mode, 'sfu');
  assert.deepEqual(cfg.voice.sfu, { port: 41000, workers: 0, announcedHost: '', maxKbpsPerUser: 0, enableTcp: true });
  fs.writeFileSync(config.CONFIG_PATH, JSON.stringify({ port: 9000 }));
  const bare = config.load();
  assert.equal(bare.voice.mode, 'mesh');
  assert.deepEqual(bare.voice.sfu, { port: 40000, workers: 0, announcedHost: '', maxKbpsPerUser: 0, enableTcp: true });
});

test("voice.mode accepts mesh and sfu and rejects 'x'", () => {
  assert.equal(schema.coerce('voice.mode', 'mesh'), 'mesh');
  assert.equal(schema.coerce('voice.mode', 'sfu'), 'sfu');
  assert.throws(() => schema.coerce('voice.mode', 'x'), /one of/);
});

test('voice.sfu.port rejects 0 and 65536', () => {
  assert.throws(() => schema.coerce('voice.sfu.port', '0'), /at least/);
  assert.throws(() => schema.coerce('voice.sfu.port', '65536'), /at most/);
  assert.equal(schema.coerce('voice.sfu.port', '40000'), 40000);
});

test('voice.sfu.workers accepts 0..16', () => {
  assert.equal(schema.coerce('voice.sfu.workers', '0'), 0);
  assert.equal(schema.coerce('voice.sfu.workers', '16'), 16);
  assert.throws(() => schema.coerce('voice.sfu.workers', '17'), /at most/);
  assert.throws(() => schema.coerce('voice.sfu.workers', '-1'), /at least/);
});

test('voice.sfu.maxKbpsPerUser and enableTcp are typed', () => {
  assert.throws(() => schema.coerce('voice.sfu.maxKbpsPerUser', '10000001'), /at most/);
  assert.equal(schema.coerce('voice.sfu.enableTcp', 'off'), false);
  assert.equal(schema.defaultOf('voice.sfu.enableTcp'), true);
});

test('console config set voice.sfu.port keeps sibling sfu settings', async () => {
  fs.writeFileSync(config.CONFIG_PATH, JSON.stringify({ voice: { sfu: { announcedHost: 'v.example.com' } } }));
  await run('config set voice.sfu.port 41000');
  const sfu = JSON.parse(fs.readFileSync(config.CONFIG_PATH, 'utf8')).voice.sfu;
  assert.equal(sfu.port, 41000);
  assert.equal(sfu.announcedHost, 'v.example.com');
});

test('console config get voice.mode returns mesh', async () => {
  fs.writeFileSync(config.CONFIG_PATH, JSON.stringify({}));
  assert.equal((await run('config get voice.mode')).trim(), '"mesh"');
});

test('config.save replaces arrays instead of merging them', () => {
  fs.writeFileSync(config.CONFIG_PATH, JSON.stringify({}));
  config.save({ iceServers: [{ urls: 'stun:a.example.com:3478' }, { urls: 'stun:b.example.com:3478' }] });
  config.save({ iceServers: [{ urls: 'stun:c.example.com:3478' }] });
  assert.deepEqual(config.load().iceServers, [{ urls: 'stun:c.example.com:3478' }]);
  config.save({ iceServers: [] });
  assert.deepEqual(config.load().iceServers, []);
});
