'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { PassThrough, Duplex } = require('node:stream');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const { db } = require('../db');
const logger = require('../lib/logger');
const config = require('../lib/config');
const schema = require('../lib/configSchema');
const backup = require('../lib/backup');
const { SITE_PERMISSIONS } = require('../lib/permissions');
const { createRegistry } = require('../console/registry');
const { registerAll } = require('../console/bootstrap');
const local = require('../console/local');
const ssh = require('../console/ssh');

test.before(() => { for (const m of ['log', 'warn', 'error']) console[m] = () => {}; });
test.after(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));
const registry = createRegistry();
registerAll(registry);

const LOCAL = { kind: 'local', userId: null, username: 'console' };
const SSH = { kind: 'ssh', userId: 1, username: 'root' };

function makeCtx(session, { confirm = true } = {}) {
  const out = [];
  return {
    session,
    write: (t) => out.push(t),
    writeln: (t) => out.push(`${t}\n`),
    ask: async () => '',
    confirm: async () => confirm,
    close() {},
    onInterrupt: () => () => {},
    text: () => out.join(''),
  };
}
async function run(line, session = LOCAL, opts) {
  const ctx = makeCtx(session, opts);
  await registry.execute(line, ctx);
  return ctx.text();
}

function fakeChannel() {
  const ch = new Duplex({ read() {}, write(chunk, enc, cb) { cb(); } });
  ch.type = (text) => ch.push(Buffer.from(text));
  return ch;
}
const complete = (rl, line) => new Promise((resolve) => rl.completer(line, (err, res) => resolve(res)));

const mkUser = (n) => Number(db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
  .run(n, `${n}@t.local`, 'h', n).lastInsertRowid);
const mkRole = (name, perms) => Number(db.prepare('INSERT INTO site_roles (name, color, permissions, position) VALUES (?, ?, ?, ?)')
  .run(name, '#000000', perms, 1).lastInsertRowid);
const perms = (id) => db.prepare('SELECT permissions FROM site_roles WHERE id = ?').get(id).permissions;

test('account roleperm adds and removes the console permission, locally, with confirmation and an admin log line', async () => {
  const id = mkRole('Recover', SITE_PERMISSIONS.VIEW_ADMIN_PANEL);
  const entries = [];
  const off = logger.subscribe((e) => entries.push(e));
  assert.match(await run('account roleperm Recover +console', LOCAL, { confirm: false }), /cancelled/);
  assert.equal(perms(id), SITE_PERMISSIONS.VIEW_ADMIN_PANEL);
  assert.match(await run('account roleperm Recover +console --yes'), /added/);
  assert.equal(perms(id), SITE_PERMISSIONS.VIEW_ADMIN_PANEL | SITE_PERMISSIONS.MANAGE_CONSOLE);
  assert.match(await run('account roleperm Recover -console'), /removed/);
  assert.equal(perms(id), SITE_PERMISSIONS.VIEW_ADMIN_PANEL);
  assert.match(await run('account roleperm Recover bogus'), /usage/);
  assert.match(await run('account roleperm Nope +console --yes'), /no such role/);
  off();
  assert.ok(entries.some((e) => e.category === 'admin' && /MANAGE_CONSOLE/.test(e.message) && /Recover/.test(e.message)));
});

test('account roleperm is refused and hidden over ssh', async () => {
  const id = mkRole('SshTry', 0);
  assert.match(await run('account roleperm SshTry +console --yes', SSH), /only available in the local server console/);
  assert.equal(perms(id), 0);
  assert.doesNotMatch(await run('help account', SSH), /roleperm/);
  assert.match(await run('help account', LOCAL), /roleperm/);
});

test('account grant and revoke are aliases of setrole and unsetrole and show in help', async () => {
  const uid = mkUser('al_user');
  const rid = mkRole('Helper', SITE_PERMISSIONS.VIEW_ADMIN_PANEL);
  assert.match(await run('account grant al_user Helper'), /granted Helper to al_user/);
  assert.ok(db.prepare('SELECT 1 FROM user_site_roles WHERE user_id = ? AND role_id = ?').get(uid, rid));
  assert.match(await run('account revoke al_user Helper'), /removed Helper from al_user/);
  assert.ok(!db.prepare('SELECT 1 FROM user_site_roles WHERE user_id = ? AND role_id = ?').get(uid, rid));
  assert.match(await run('help account setrole'), /account grant/);
  assert.match(await run('help account grant'), /usage: account setrole/);
});

test('historyForm masks inline secrets and nothing else', () => {
  assert.equal(registry.historyForm('account passwd alice S3cret!'), 'account passwd ***');
  assert.equal(registry.historyForm('account create bob b@x.co S3cret!'), 'account create ***');
  assert.equal(registry.historyForm('config set turn.secret abc'), 'config set ***');
  assert.equal(registry.historyForm('config set logging.level warn'), null);
  assert.equal(registry.historyForm('account passwd'), null);
  assert.equal(registry.historyForm('help'), null);
  assert.equal(registry.historyForm('nonsense "unterminated'), null);
});

test('local console: inline secrets never stay in readline history', async () => {
  const stdin = new PassThrough(); const stdout = new PassThrough();
  const con = local.start({ stdin, stdout, registry, terminal: true, color: false });
  await tick();
  stdin.write('account create hist_user hist@t.local Inl1ne-secret\n');
  await tick(200);
  stdin.write('help\n');
  await tick(60);
  const h = con.rl.history;
  assert.ok(!h.some((l) => l.includes('Inl1ne-secret')), JSON.stringify(h));
  assert.ok(h.includes('account create ***'));
  assert.ok(h.includes('help'));
  con.stop();
});

test('local console: completer returns nothing while an ask is pending', async () => {
  const reg = createRegistry();
  reg.register({ name: 'pw', area: 'x', summary: '', usage: 'pw', async run(a, ctx) { return ctx.ask('Password:', { secret: true }); } });
  reg.register({ name: 'help', area: 'x', summary: '', usage: 'help', run() {} });
  const stdin = new PassThrough(); const stdout = new PassThrough();
  const con = local.start({ stdin, stdout, registry: reg, terminal: true, color: false });
  await tick();
  assert.deepEqual((await complete(con.rl, 'he'))[0], ['help']);
  stdin.write('pw\n');
  await tick();
  assert.deepEqual(await complete(con.rl, 'he'), [[], 'he']);
  con.stop();
});

test('ssh shell: inline secrets never stay in history', async () => {
  const channel = fakeChannel();
  const shell = ssh._test.startShell({ channel, session: SSH, registry, closeSession() {}, touch() {}, cols: 100, recheck: () => true });
  await tick();
  channel.type('account create ssh_hist ssh_hist@t.local Inl1ne-ssh-secret\r');
  await tick(200);
  channel.type('help\r');
  await tick(100);
  assert.ok(!shell.rl.history.some((l) => l.includes('Inl1ne-ssh-secret')), JSON.stringify(shell.rl.history));
  assert.ok(shell.rl.history.includes('account create ***'));
  shell.stop();
});

test('ssh shell: the completer is off while an ask is pending', async () => {
  const reg = createRegistry();
  reg.register({ name: 'pw', area: 'x', summary: '', usage: 'pw', async run(a, ctx) { return ctx.ask('Password:', { secret: true }); } });
  reg.register({ name: 'help', area: 'x', summary: '', usage: 'help', run() {} });
  const channel = fakeChannel();
  const shell = ssh._test.startShell({ channel, session: SSH, registry: reg, closeSession() {}, touch() {}, cols: 100, recheck: () => true });
  await tick();
  assert.deepEqual((await complete(shell.rl, 'he'))[0], ['help']);
  channel.type('pw\r');
  await tick(80);
  assert.deepEqual(await complete(shell.rl, 'he'), [[], 'he']);
  shell.stop();
});

test('backup scheduler: stop prevents re-arm of an in-flight run and a second start leaves one chain', async () => {
  let runs = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const stop = backup.startScheduler({ delay: () => 5, run: async () => { runs += 1; await gate; } });
  await tick(40);
  assert.equal(runs, 1);
  stop();
  release();
  await tick(60);
  assert.equal(runs, 1, 'no re-arm after stop');
  assert.equal(backup.schedulerActive(), false);

  let a = 0; let b = 0;
  backup.startScheduler({ delay: () => 5, run: async () => { a += 1; } });
  await tick(30);
  const stopB = backup.startScheduler({ delay: () => 5, run: async () => { b += 1; } });
  const aAtSwitch = a;
  await tick(60);
  assert.ok(a <= aAtSwitch + 1, 'the first chain was replaced');
  assert.ok(b > 0);
  stopB();
  const bAfter = b;
  await tick(40);
  assert.equal(b, bAfter);
});

test('backup keep and the config schema share the 1-100 cap', async () => {
  assert.equal(schema.describe()['backup.keep'].max, 100);
  assert.match(await run('backup keep 101'), /between 1 and 100/);
  assert.match(await run('config set backup.keep 101'), /error/);
});

test('ssh.allowPublicKeys is a reserved key that defaults to false', () => {
  assert.equal(config.DEFAULTS.ssh.allowPublicKeys, false);
  assert.equal(schema.describe()['ssh.allowPublicKeys'].type, 'boolean');
});

test('ice server credentials are masked in config show and redacted in backups', async () => {
  config.save({ iceServers: [{ urls: 'turn:t.example:3478', username: 'u', credential: 'turn-cred-123' }] });
  for (const line of ['config get iceServers', 'config list']) {
    const out = await run(line);
    assert.ok(!out.includes('turn-cred-123'), line);
  }
  assert.match(await run('config get iceServers'), /"credential":"\*\*\*"/);
  const red = backup._test.redactConfig(config.load());
  assert.ok(!JSON.stringify(red).includes('turn-cred-123'));
  const merged = backup._test.mergeConfig(red, config.load());
  assert.equal(merged.iceServers[0].credential, 'turn-cred-123');
});

test('log tail colours ssh sessions only', async () => {
  const colourOf = async (session) => {
    const ctx = makeCtx(session);
    let stop;
    ctx.onInterrupt = (fn) => { stop = fn; return () => {}; };
    const done = registry.execute('log tail warn', ctx);
    await tick();
    logger.scoped('t').warn('coloured line');
    await tick();
    stop();
    await done;
    return ctx.text();
  };
  assert.match(await colourOf(SSH), /\x1b\[[0-9;]*m/);
});

test('start-server.bat exits quietly after a deliberate stop and keeps the pause for failures', () => {
  const bat = fs.readFileSync(path.join(__dirname, '..', '..', 'start-server.bat'), 'utf8');
  assert.match(bat, /if %errorlevel%==0 exit \/b 0/);
  assert.ok(bat.indexOf('exit /b 0') < bat.indexOf('pause'));
});
