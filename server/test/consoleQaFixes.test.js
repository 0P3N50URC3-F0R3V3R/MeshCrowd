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
const { SITE_PERMISSIONS } = require('../lib/permissions');
const { createRegistry } = require('../console/registry');
const { registerAll } = require('../console/bootstrap');

test.before(() => { for (const m of ['log', 'warn', 'error']) console[m] = () => {}; });
test.after(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

const registry = createRegistry();
registerAll(registry);

const mkUser = (n) => Number(db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
  .run(n, `${n}@t.local`, 'h', n).lastInsertRowid);
const mkRole = (name, perms) => Number(db.prepare('INSERT INTO site_roles (name, color, permissions, position) VALUES (?, ?, ?, ?)')
  .run(name, '#000000', perms, 1).lastInsertRowid);
const assign = (u, r) => db.prepare('INSERT INTO user_site_roles (user_id, role_id) VALUES (?, ?)').run(u, r);
const setDisabled = (id, v) => db.prepare('UPDATE users SET is_disabled = ? WHERE id = ?').run(v, id);
const disabled = (id) => db.prepare('SELECT is_disabled FROM users WHERE id = ?').get(id).is_disabled;
const exists = (id) => !!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id);
const hasRole = (u, r) => !!db.prepare('SELECT 1 FROM user_site_roles WHERE user_id = ? AND role_id = ?').get(u, r);

const LOCAL = { kind: 'local', userId: null, username: 'console' };
const sshAs = (userId, username) => ({ kind: 'ssh', userId, username });

async function run(line, session = LOCAL) {
  const out = [];
  await registry.execute(line, {
    session, write: (t) => out.push(t), writeln: (t) => out.push(`${t}\n`),
    ask: async () => 'password-1234', confirm: async () => true, close() {}, onInterrupt: () => () => {},
  });
  return out.join('');
}

const CONSOLE = SITE_PERMISSIONS.MANAGE_CONSOLE | SITE_PERMISSIONS.VIEW_ADMIN_PANEL;
const roleA = mkRole('ConsoleA', CONSOLE);
const roleB = mkRole('ConsoleB', CONSOLE);
const alice = mkUser('alice_q');
const bob = mkUser('bob_q');
assign(alice, roleA);
assign(bob, roleB);
const asAlice = sshAs(alice, 'alice_q');
const asBob = sshAs(bob, 'bob_q');

test('ssh: acting on yourself is refused for ban, disable, delete and losing the console role', async () => {
  assert.match(await run('ban alice_q --yes', asAlice), /you cannot ban yourself; use the local console/);
  assert.match(await run('account disable alice_q', asAlice), /you cannot disable yourself/);
  assert.match(await run('account delete alice_q --yes', asAlice), /you cannot delete yourself/);
  assert.match(await run('account unsetrole alice_q ConsoleA', asAlice), /cannot remove your own console permission/);
  assert.equal(disabled(alice), 0);
  assert.ok(exists(alice));
  assert.ok(hasRole(alice, roleA));
});

test('ssh: acting on another console account is fine while a second one stays enabled', async () => {
  assert.match(await run('ban bob_q --yes', asAlice), /^banned bob_q/);
  assert.equal(disabled(bob), 1);
  assert.match(await run('unban bob_q', asAlice), /unbanned/);
  assert.match(await run('account unsetrole bob_q ConsoleB', asAlice), /removed ConsoleB/);
  assert.match(await run('account setrole bob_q ConsoleB', asAlice), /granted ConsoleB/);
});

test('ssh: the last enabled console account cannot be removed by another operator; local console can', async () => {
  const op = mkUser('op_q');
  assign(op, mkRole('OpRole', CONSOLE | SITE_PERMISSIONS.SITE_ADMINISTRATOR));
  const only = mkUser('only_q');
  const onlyRole = mkRole('OnlyConsole', SITE_PERMISSIONS.MANAGE_CONSOLE);
  assign(only, onlyRole);
  for (const id of [alice, bob]) setDisabled(id, 1);
  const asOp = sshAs(op, 'op_q');
  setDisabled(op, 1);
  assert.match(await run('ban only_q --yes', asOp), /last enabled account with console access/);
  assert.match(await run('account disable only_q', asOp), /last enabled account/);
  assert.match(await run('account delete only_q --yes', asOp), /last enabled account/);
  assert.match(await run('account unsetrole only_q OnlyConsole', asOp), /last enabled account/);
  assert.equal(disabled(only), 0);
  assert.ok(exists(only));
  assert.ok(hasRole(only, onlyRole));
  assert.match(await run('ban only_q --yes', LOCAL), /^banned only_q/);
  assert.equal(disabled(only), 1);
  for (const id of [alice, bob, op, only]) setDisabled(id, 0);
});

test('local console is unrestricted', async () => {
  setDisabled(bob, 1);
  const solo = mkUser('solo_q');
  assign(solo, mkRole('SoloConsole', CONSOLE));
  setDisabled(alice, 1);
  assert.match(await run('account disable solo_q'), /disabled solo_q/);
  assert.match(await run('account delete solo_q --yes'), /deleted account solo_q/);
  setDisabled(alice, 0);
  setDisabled(bob, 0);
});

test('refused local-only command prints a clear message; unknown commands still suggest, never a hidden one', async () => {
  assert.match(await run('account roleperm Owner +console', asBob), /`account roleperm` is only available in the local server console/);
  assert.match(await run('backup restore x', asBob), /`backup restore` is only available in the local server console/);
  assert.match(await run('backpu list', asBob), /unknown command: backpu, did you mean backup\?/);
  assert.equal(registry.suggest('roleperm', asBob), null);
  assert.ok(!registry.listFor(asBob).some((d) => d.name === 'account roleperm'));
});

test('config set is logged with key and values, masked only for secret keys, at warn level', async () => {
  const entries = [];
  const off = logger.subscribe((e) => entries.push(e));
  const prev = logger.getLevel();
  logger.setLevel('warn');
  await run('config set logging.keepDays 9');
  await run('config set turn.secret topsecretvalue');
  logger.setLevel(prev);
  off();
  const msgs = entries.map((e) => e.message).join('\n');
  assert.match(msgs, /ran: config set logging\.keepDays 9/);
  assert.match(msgs, /set logging\.keepDays: .* -> 9/);
  assert.match(msgs, /ran: config set \*\*\* \*\*\*/);
  assert.doesNotMatch(msgs, /topsecretvalue/);
  await run('config reset logging.keepDays');
  await run('config reset turn.secret');
});

test('state-changing commands are audited at warn, read-only ones are not', async () => {
  const entries = [];
  const off = logger.subscribe((e) => entries.push(e));
  const prev = logger.getLevel();
  logger.setLevel('warn');
  mkUser('aud_q');
  await run('ban aud_q --yes');
  await run('unban aud_q');
  await run('ipban 192.0.2.77 5');
  await run('ipunban 192.0.2.77');
  await run('announce hello');
  await run('help');
  await run('account list');
  await run('config get port');
  await run('ipbans');
  logger.setLevel(prev);
  off();
  const warned = entries.filter((e) => e.category === 'console' && e.level === 'warn').map((e) => e.message);
  for (const c of ['ban aud_q', 'unban aud_q', 'ipban 192.0.2.77', 'ipunban', 'announce hello']) {
    assert.ok(warned.some((m) => m.includes(`ran: ${c}`)), c);
  }
  for (const c of ['ran: help', 'ran: account list', 'ran: config get', 'ran: ipbans']) {
    assert.ok(!entries.some((e) => e.message.includes(c)), c);
  }
});

test('audit flag marks exactly the state-changing commands', () => {
  const need = ['ban', 'unban', 'ipban', 'ipunban', 'kick', 'account create', 'account passwd', 'account delete', 'account disable',
    'account enable', 'account setrole', 'account unsetrole', 'account roleperm', 'config set', 'config reset', 'backup create',
    'backup delete', 'backup restore', 'backup keep', 'backup auto', 'server stop', 'server restart', 'announce'];
  const none = ['help', 'list', 'status', 'stats', 'log show', 'config get', 'config list', 'account list', 'account info',
    'backup list', 'backup verify', 'ssh status'];
  const byName = new Map(registry.listFor({ kind: 'local' }).map((d) => [d.name, d]));
  for (const n of need) assert.ok(byName.get(n) && byName.get(n).audit, n);
  for (const n of none) assert.ok(byName.get(n) && !byName.get(n).audit, n);
});

test('ipban strips --yes from the reason', async () => {
  await run('ipban 192.0.2.88 5 --yes');
  await run('ipban 192.0.2.89 5 scanning --yes');
  const reason = (ip) => db.prepare('SELECT reason FROM ip_bans WHERE entry = ?').get(ip).reason;
  assert.ok(!/--yes/.test(reason('192.0.2.88')));
  assert.equal(reason('192.0.2.89'), 'scanning');
});

test('backup delete validates the name before asking', async () => {
  let asked = false;
  const out = [];
  await registry.execute('backup delete ../../etc', {
    session: LOCAL, write() {}, writeln: (t) => out.push(t), ask: async () => '',
    confirm: async () => { asked = true; return true; }, close() {}, onInterrupt: () => () => {},
  });
  assert.equal(asked, false);
  assert.match(out.join(''), /invalid backup name/);
});
