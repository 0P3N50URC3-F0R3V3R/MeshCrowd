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
const logger = require('../lib/logger');
const schema = require('../lib/configSchema');
const registration = require('../lib/registration');
const { createRegistry } = require('../console/registry');
const registerConfig = require('../console/commands/config');

test.before(() => { for (const m of ['log', 'warn', 'error']) console[m] = () => {}; });
test.after(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

const registry = createRegistry();
registerConfig(registry);

const LOCAL = { kind: 'local', userId: null, username: 'local' };

async function run(line, session = LOCAL) {
  const out = [];
  const ctx = { session, write: (t) => out.push(t), writeln: (t) => out.push(`${t}\n`), ask: async () => '', confirm: async () => true, close() {} };
  await registry.execute(line, ctx);
  return out.join('');
}

const stored = () => JSON.parse(fs.readFileSync(config.CONFIG_PATH, 'utf8'));

test('coerce validates types and ranges', () => {
  assert.throws(() => schema.coerce('port', 'abc'), /integer/);
  assert.throws(() => schema.coerce('port', '70000'), /at most/);
  assert.equal(schema.coerce('port', '9000'), 9000);
  assert.equal(schema.coerce('useHttps', 'true'), true);
  assert.equal(schema.coerce('useHttps', 'off'), false);
  assert.throws(() => schema.coerce('useHttps', 'maybe'), /true or false/);
  assert.throws(() => schema.coerce('logging.level', 'loud'), /one of/);
  assert.deepEqual(schema.coerce('iceServers', '[{"urls":"stun:x"}]'), [{ urls: 'stun:x' }]);
  assert.throws(() => schema.coerce('iceServers', '{bad'), /JSON/);
});

test('describe covers every default key, turn.secret is secret, ssh is restart-only', () => {
  const d = schema.describe();
  for (const k of ['port', 'turn.secret', 'downloads.website', 'sites.maxWorkers', 'ssh.port', 'backup.keep', 'logging.level', 'federation.enabled']) assert.ok(d[k], k);
  assert.equal(d['turn.secret'].secret, true);
  assert.equal(d['ssh.enabled'].restart, true);
  assert.equal(d.port.restart, true);
  assert.equal(d['logging.level'].restart, false);
});

test('set/get round trip persists and applies live', async () => {
  const out = await run('config set maxUploadMb 40');
  assert.match(out, /applied live/);
  assert.equal(stored().maxUploadMb, 40);
  assert.equal((await run('config get maxUploadMb')).trim(), '40');
});

test('nested keys are saved without clobbering siblings', async () => {
  await run('config set turn.port 4000');
  assert.equal(stored().turn.port, 4000);
  assert.equal(stored().turn.realm, 'meshcrowd');
});

test('config list never prints the turn secret', async () => {
  const secret = config.load().turn.secret;
  assert.ok(secret.length > 8);
  const out = await run('config list');
  assert.ok(!out.includes(secret));
  assert.match(out, /turn\.secret = \*\*\*/);
  assert.ok(!(await run('config get turn.secret')).includes(secret));
  assert.match(await run('config list logging'), /^logging\.level/);
});

test('set/reset of a secret key never echoes values', async () => {
  const old = config.load().turn.secret;
  const out = await run('config set turn.secret topsecretvalue99');
  assert.ok(!out.includes(old) && !out.includes('topsecretvalue99'));
  assert.equal(stored().turn.secret, 'topsecretvalue99');
  const logs = logger.readRecent(50).map((e) => e.message).join('\n');
  assert.ok(!logs.includes('topsecretvalue99') && !logs.includes(old));
  const out2 = await run('config reset turn.secret');
  assert.ok(!out2.includes('topsecretvalue99'));
});

test('logging.level applies live', async () => {
  const out = await run('config set logging.level warn');
  assert.equal(logger.getLevel(), 'warn');
  assert.match(out, /applied live/);
  await run('config reset logging.level');
  assert.equal(logger.getLevel(), 'info');
});

test('registrationMode applies live', async () => {
  const out = await run('config set registrationMode closed');
  assert.match(out, /applied live/);
  assert.equal(registration.getMode(), 'closed');
  await run('config reset registrationMode');
  assert.equal(registration.getMode(), 'open');
});

test('reset restores the default', async () => {
  await run('config set maxMessageChars 500');
  await run('config reset maxMessageChars');
  assert.equal(stored().maxMessageChars, config.DEFAULTS.maxMessageChars);
});

test('unknown key suggests a close match, bad value is rejected', async () => {
  assert.match(await run('config get maxUploadMB'), /did you mean maxUploadMb/);
  assert.match(await run('config set port abc'), /error: .*integer/);
  assert.notEqual(stored().port, 'abc');
});

test('config change is logged with old and new values', async () => {
  await run('config set maxUploadMb 41');
  const logs = logger.readRecent(50).map((e) => e.message);
  assert.ok(logs.some((m) => /local set maxUploadMb: 40 -> 41/.test(m)));
});

test('config path prints the file', async () => {
  assert.equal((await run('config path')).trim(), config.CONFIG_PATH);
});

test('json keys are shape-checked and bad values leave the config untouched', async () => {
  const before = fs.readFileSync(config.CONFIG_PATH, 'utf8');
  for (const line of [
    'config set iceServers 5', 'config set iceServers {}', 'config set passportOrigins x', 'config set passportOrigins 5',
    'config set trustProxy [1]', 'config set trustProxy null', 'config set trustProxy 1.5', 'config set trustProxy -1', 'config set trustProxy {}',
  ]) assert.match(await run(line), /error: /, line);
  for (const urls of ['5', '[]', '""', '[""]', '[1]']) {
    assert.match(await run(`config set iceServers '[{"urls":${urls}}]'`), /error: iceServers\[0\] .*urls/, urls);
  }
  assert.match(await run(`config set iceServers '[1]'`), /error: iceServers\[0\] .*urls/);
  assert.equal(fs.readFileSync(config.CONFIG_PATH, 'utf8'), before);
});

test('valid json values persist', async () => {
  await run(`config set iceServers '[{"urls":"stun:a:1"},{"urls":["turn:b","turn:c"]}]'`);
  assert.equal(stored().iceServers.length, 2);
  await run(`config set passportOrigins '["https://x.example"]'`);
  assert.deepEqual(stored().passportOrigins, ['https://x.example']);
  for (const [raw, want] of [['2', 2], ['true', true], ['false', false], ['10.0.0.0/8', '10.0.0.0/8']]) {
    await run(`config set trustProxy ${raw}`);
    assert.equal(stored().trustProxy, want);
  }
});

test('integer keys reject hex and exponent forms', () => {
  assert.throws(() => schema.coerce('port', '0x10'), /integer/);
  assert.throws(() => schema.coerce('port', '1e3'), /integer/);
  assert.equal(schema.coerce('port', '8081'), 8081);
});

test('suggest ranks exact, then longest related key, then close edit distance', () => {
  assert.equal(schema.suggest('ssh.portx'), 'ssh.port');
  assert.equal(schema.suggest('SSH.PORT'), 'ssh.port');
  assert.equal(schema.suggest('foo'), null);
  assert.equal(schema.suggest('maxUploadMB'), 'maxUploadMb');
});
