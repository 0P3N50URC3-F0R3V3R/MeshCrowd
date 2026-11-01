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
const splitAuth = require('../lib/splitAuth');
const { createSession, getSession } = require('../lib/session');
const { SITE_PERMISSIONS } = require('../lib/permissions');
const { createRegistry } = require('../console/registry');
const registerAccount = require('../console/commands/account');
const registerModeration = require('../console/commands/moderation');

test.before(() => { for (const m of ['log', 'warn', 'error']) console[m] = () => {}; });
test.after(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

function makeRegistry() {
  const r = createRegistry();
  registerAccount(r);
  registerModeration(r);
  return r;
}

function makeCtx(session, answers = []) {
  const out = [];
  const queue = [...answers];
  return {
    session,
    write: (t) => out.push(t),
    writeln: (t) => out.push(`${t}\n`),
    ask: async (q, opts) => { out.push(`[ask:${q}:${opts && opts.secret ? 'secret' : 'plain'}]`); return queue.shift() || ''; },
    confirm: async () => true,
    close: () => {},
    text: () => out.join(''),
  };
}

const LOCAL = { kind: 'local', userId: null, username: 'local' };
const row = (name) => db.prepare('SELECT * FROM users WHERE username = ?').get(name);

async function run(r, line, session = LOCAL, answers = []) {
  const ctx = makeCtx(session, answers);
  await r.execute(line, ctx);
  return ctx.text();
}

function makeUser(name, perms = null) {
  const info = db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run(name, `${name}@example.com`, 'x', name);
  const id = Number(info.lastInsertRowid);
  if (perms !== null) {
    const role = db.prepare('INSERT INTO site_roles (name, permissions, position) VALUES (?, ?, 1)').run(`role-${name}`, perms);
    db.prepare('INSERT INTO user_site_roles (user_id, role_id) VALUES (?, ?)').run(id, role.lastInsertRowid);
  }
  return id;
}

test('create, list, info round trip', async () => {
  const r = makeRegistry();
  const out = await run(r, 'account create alice alice@example.com', LOCAL, ['hunter22pw']);
  assert.ok(out.includes('[ask:') && out.includes(':secret]'));
  assert.ok(out.includes('created'));
  const u = row('alice');
  assert.equal(u.auth_mode, 'password');
  assert.equal(splitAuth.checkLogin(u, { password: 'hunter22pw' }), 'ok');
  assert.ok((await run(r, 'account list')).includes('alice'));
  assert.ok(!(await run(r, 'account list zzz')).includes('alice'));
  const info = await run(r, 'account info alice');
  assert.ok(info.includes('alice@example.com') && info.includes('password'));
  const audit = db.prepare("SELECT * FROM passport_audit WHERE user_id = ? AND action = 'console_create'").get(u.id);
  assert.ok(audit && audit.ok === 1);
});

test('create refuses short password, duplicate and bad input', async () => {
  const r = makeRegistry();
  const out = await run(r, 'account create shorty shorty@example.com abc');
  assert.match(out, /error: .*8 characters/);
  assert.equal(row('shorty'), undefined);
  assert.match(await run(r, 'account create alice alice@example.com longenough1'), /error: .*(exists|taken)/);
  assert.match(await run(r, 'account create x@@ nope longenough1'), /error: /);
});

test('passwd invalidates old password, sessions and audits', async () => {
  const r = makeRegistry();
  await run(r, 'account create bob bob@example.com firstpass1');
  const bob = row('bob');
  const s = createSession(bob.id, 'test');
  const out = await run(r, 'account passwd bob', LOCAL, ['secondpass2']);
  assert.ok(out.includes(':secret]'));
  const after = row('bob');
  assert.equal(splitAuth.checkLogin(after, { password: 'firstpass1' }), 'bad');
  assert.equal(splitAuth.checkLogin(after, { password: 'secondpass2' }), 'ok');
  assert.equal(getSession(s.token), null);
  assert.ok(db.prepare("SELECT 1 FROM passport_audit WHERE user_id = ? AND action = 'console_reset'").get(bob.id));
  assert.match(await run(r, 'account passwd bob', LOCAL, ['short']), /error: .*8 characters/);
});

test('passwd refuses split accounts', async () => {
  const r = makeRegistry();
  const id = makeUser('splitty');
  db.prepare("UPDATE users SET auth_mode = 'split' WHERE id = ?").run(id);
  assert.match(await run(r, 'account passwd splitty', LOCAL, ['longenough1']), /error: .*strengthened/);
});

test('disable/enable, kick, ban/unban', async () => {
  const r = makeRegistry();
  const id = makeUser('carol');
  const s = createSession(id, 'test');
  await run(r, 'kick carol');
  assert.equal(row('carol').is_disabled, 0);
  assert.ok(getSession(s.token));
  await run(r, 'ban carol spamming');
  assert.equal(row('carol').is_disabled, 1);
  assert.equal(getSession(s.token), null);
  await run(r, 'unban carol');
  assert.equal(row('carol').is_disabled, 0);
  await run(r, 'account disable carol');
  assert.equal(row('carol').is_disabled, 1);
  await run(r, 'account enable carol');
  assert.equal(row('carol').is_disabled, 0);
});

test('ban honours a declined confirm and --yes', async () => {
  const r = makeRegistry();
  makeUser('sam');
  const declined = makeCtx(LOCAL);
  declined.confirm = async () => false;
  await r.execute('ban sam being rude', declined);
  assert.ok(declined.text().includes('cancelled'));
  assert.equal(row('sam').is_disabled, 0);
  const logged = [];
  const off = logger.subscribe((e) => logged.push(e));
  const yes = makeCtx(LOCAL);
  yes.confirm = async () => { throw new Error('confirm must be skipped'); };
  await r.execute('ban sam --yes being rude', yes);
  off();
  assert.equal(row('sam').is_disabled, 1);
  const msgs = logged.filter((e) => e.category === 'admin').map((e) => e.message).join('\n');
  assert.ok(msgs.includes('being rude') && !msgs.includes('--yes'));
});

test('delete removes the account after confirmation', async () => {
  const r = makeRegistry();
  makeUser('dave');
  const out = await run(r, 'account delete dave');
  assert.ok(out.includes('deleted'));
  assert.equal(row('dave'), undefined);
});

function auditCount() {
  return db.prepare('SELECT COUNT(*) AS c FROM passport_audit').get().c;
}

test('delete refuses users that own a server or authored a message, with no side effects', async () => {
  const r = makeRegistry();
  const owner = makeUser('olga');
  const author = makeUser('pete');
  const ownerSession = createSession(owner, 'test');
  const authorSession = createSession(author, 'test');
  const server = db.prepare('INSERT INTO servers (name, owner_id) VALUES (?, ?)').run('s', owner);
  const channel = db.prepare("INSERT INTO channels (server_id, name) VALUES (?, 'c')").run(server.lastInsertRowid);
  db.prepare("INSERT INTO messages (scope_type, scope_id, author_id, content) VALUES ('channel', ?, ?, 'hi')").run(channel.lastInsertRowid, author);
  for (const name of ['olga', 'pete']) {
    const before = auditCount();
    const okBefore = db.prepare("SELECT COUNT(*) AS c FROM passport_audit WHERE action = 'console_delete' AND ok = 1").get().c;
    const out = await run(r, `account delete ${name}`);
    assert.match(out, new RegExp(`${name} owns servers or has content and cannot be deleted; use .ban ${name}. instead`));
    assert.ok(row(name), name);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM passport_audit WHERE action = 'console_delete' AND ok = 1").get().c, okBefore);
    assert.ok(auditCount() - before <= 1);
  }
  assert.ok(getSession(ownerSession.token) && getSession(authorSession.token));
});

test('delete honours a declined confirm and --yes', async () => {
  const r = makeRegistry();
  makeUser('quinn');
  makeUser('rita');
  const declined = makeCtx(LOCAL);
  declined.confirm = async () => false;
  await r.execute('account delete quinn', declined);
  assert.ok(declined.text().includes('cancelled'));
  assert.ok(row('quinn'));
  const yes = makeCtx(LOCAL);
  yes.confirm = async () => { throw new Error('confirm must be skipped'); };
  await r.execute('account delete rita --yes', yes);
  assert.ok(yes.text().includes('deleted'));
  assert.equal(row('rita'), undefined);
});

test('unknown user prints a clear error', async () => {
  const r = makeRegistry();
  for (const line of ['account info nobody', 'account passwd nobody', 'account delete nobody', 'account disable nobody', 'kick nobody', 'ban nobody']) {
    assert.match(await run(r, line, LOCAL, ['longenough1']), /error: no such user: nobody/, line);
  }
});

test('roles listing and setrole/unsetrole', async () => {
  const r = makeRegistry();
  const target = makeUser('erin');
  const role = db.prepare('INSERT INTO site_roles (name, permissions, position) VALUES (?, ?, 1)').run('Helper', SITE_PERMISSIONS.VIEW_ADMIN_PANEL);
  assert.ok((await run(r, 'account roles')).includes('Helper'));
  await run(r, 'account setrole erin Helper');
  assert.ok(db.prepare('SELECT 1 FROM user_site_roles WHERE user_id = ? AND role_id = ?').get(target, role.lastInsertRowid));
  await run(r, 'account unsetrole erin Helper');
  assert.ok(!db.prepare('SELECT 1 FROM user_site_roles WHERE user_id = ? AND role_id = ?').get(target, role.lastInsertRowid));
  assert.match(await run(r, 'account setrole erin NoSuchRole'), /error: no such role/);
});

test('ssh grant rule: MANAGE_CONSOLE role needs the flag, local may always', async () => {
  const r = makeRegistry();
  const owner = db.prepare('INSERT INTO site_roles (name, permissions, position) VALUES (?, ?, 100)')
    .run('Owner-like', SITE_PERMISSIONS.MANAGE_CONSOLE | SITE_PERMISSIONS.SITE_ADMINISTRATOR | SITE_PERMISSIONS.VIEW_ADMIN_PANEL);
  const target = makeUser('frank');
  const adminId = makeUser('gina', SITE_PERMISSIONS.SITE_ADMINISTRATOR | SITE_PERMISSIONS.VIEW_ADMIN_PANEL | SITE_PERMISSIONS.MANAGE_USERS);
  const ssh = { kind: 'ssh', userId: adminId, username: 'gina' };
  assert.match(await run(r, 'account setrole frank Owner-like', ssh), /error: /);
  assert.ok(!db.prepare('SELECT 1 FROM user_site_roles WHERE user_id = ? AND role_id = ?').get(target, owner.lastInsertRowid));
  await run(r, 'account setrole frank Owner-like');
  assert.ok(db.prepare('SELECT 1 FROM user_site_roles WHERE user_id = ? AND role_id = ?').get(target, owner.lastInsertRowid));
  assert.match(await run(r, 'account unsetrole frank Owner-like', ssh), /error: /);
  const holder = makeUser('hank', SITE_PERMISSIONS.MANAGE_CONSOLE | SITE_PERMISSIONS.SITE_ADMINISTRATOR | SITE_PERMISSIONS.VIEW_ADMIN_PANEL);
  const holderSsh = { kind: 'ssh', userId: holder, username: 'hank' };
  await run(r, 'account unsetrole frank Owner-like', holderSsh);
  assert.ok(!db.prepare('SELECT 1 FROM user_site_roles WHERE user_id = ? AND role_id = ?').get(target, owner.lastInsertRowid));
});

test('ssh cannot reset or disable a user outranking them', async () => {
  const r = makeRegistry();
  const boss = makeUser('ivan', SITE_PERMISSIONS.MANAGE_CONSOLE);
  const mod = makeUser('judy', SITE_PERMISSIONS.MANAGE_USERS | SITE_PERMISSIONS.VIEW_ADMIN_PANEL);
  const ssh = { kind: 'ssh', userId: mod, username: 'judy' };
  assert.match(await run(r, 'ban ivan', ssh), /error: .*permissions you do not hold/);
  assert.equal(db.prepare('SELECT is_disabled FROM users WHERE id = ?').get(boss).is_disabled, 0);
});

test('ipban creates an expiring row, ipbans lists, ipunban removes', async () => {
  const r = makeRegistry();
  const out = await run(r, 'ipban 10.0.0.0/24 5 testing');
  assert.ok(out.includes('10.0.0.0/24'));
  const ban = db.prepare("SELECT * FROM ip_bans WHERE entry = '10.0.0.0/24'").get();
  assert.ok(ban && ban.expires_at && ban.reason === 'testing');
  assert.ok(Date.parse(ban.expires_at) - Date.now() > 4 * 60_000);
  await run(r, 'ipban 192.0.2.7');
  assert.equal(db.prepare("SELECT expires_at FROM ip_bans WHERE entry = '192.0.2.7'").get().expires_at, null);
  const list = await run(r, 'ipbans');
  assert.ok(list.includes('10.0.0.0/24') && list.includes('192.0.2.7'));
  await run(r, 'ipunban 10.0.0.0/24');
  assert.equal(db.prepare("SELECT 1 FROM ip_bans WHERE entry = '10.0.0.0/24'").get(), undefined);
  assert.match(await run(r, 'ipunban 10.0.0.0/24'), /error: no such ban/);
  assert.match(await run(r, 'ipban notanip'), /error: /);
});

test('admin log records actor and target, never passwords', async () => {
  const r = makeRegistry();
  const logged = [];
  const off = logger.subscribe((e) => logged.push(e));
  await run(r, 'account create kate kate@example.com sup3rs3cretpw');
  await run(r, 'account passwd kate', { kind: 'ssh', userId: null, username: 'root' }, ['an0therS3cret']);
  off();
  const admin = logged.filter((e) => e.category === 'admin').map((e) => e.message).join('\n');
  assert.ok(admin.includes('kate') && admin.includes('root'));
  const all = logged.map((e) => e.message).join('\n');
  assert.ok(!all.includes('sup3rs3cretpw') && !all.includes('an0therS3cret'));
});
