'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const express = require('express');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { attachUser } = require('../middleware/auth');
const accounts = require('../lib/accounts');
const challenges = require('../lib/passportChallenges');
const pendingLogin = require('../lib/pendingLogin');
const { PLAIN_REFUSED } = require('../lib/splitAuth');

const app = express();
app.use(express.json());
app.use(attachUser);
app.use('/api/auth', require('../routes/auth'));
app.use('/api/admin', require('../routes/admin'));
app.use('/api/passport', require('../routes/passport'));
app.use(require('../middleware/errorHandler').errorHandler);
let server; let base; let ownerCookie;

async function call(method, url, body, cookie) {
  const res = await fetch(base + url, {
    method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => null), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}

test.before(async () => {
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  accounts.createAccount({ username: 'sa_owner', email: 'sa_owner@t.co', password: 'password123' }); // first account = site owner
  ownerCookie = (await call('POST', '/api/auth/login', { username: 'sa_owner', password: 'password123' })).cookie;
});
test.after(() => { server.close(); db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });
test.beforeEach(() => challenges._resetForTests());

const key = (n) => Buffer.alloc(32, n).toString('base64');
const salt = (n) => Buffer.alloc(16, n).toString('base64');
const splitBackup = { encryptedKey: 'enc-split', salt: 'split:v1', nonce: 'nn' };
const legacyBackup = { encryptedKey: 'enc-legacy', salt: 'argon-salt', nonce: 'nn' };
const registerSplit = (name, n) => call('POST', '/api/auth/register', { username: name, email: `${name}@t.co`, authKey: key(n), authSalt: salt(n) });
const registerLegacy = (name) => call('POST', '/api/auth/register', { username: name, email: `${name}@t.co`, password: 'password123' });
const params = async (name) => (await call('GET', `/api/auth/login-params?username=${encodeURIComponent(name)}`)).body;
const row = (name) => db.prepare('SELECT * FROM users WHERE username = ?').get(name);
const giveTotp = (name, codes) => db.prepare('UPDATE users SET totp_enabled = 1, totp_secret = ?, totp_recovery_codes = ? WHERE username = ?')
  .run('JBSWY3DPEHPK3PXP', JSON.stringify(codes), name);
function givePassport(name, backupSalt) {
  const id = row(name).id;
  db.prepare("UPDATE users SET passport_id = ?, passport_public_key = 'pk' WHERE id = ?").run(`mc1${'a'.repeat(52 - String(id).length)}${id}`, id);
  db.prepare("INSERT INTO e2ee_key_backups (user_id, encrypted_key, salt, nonce) VALUES (?, 'old', ?, 'n')").run(id, backupSalt);
}
const lastAudit = () => ({ ...db.prepare('SELECT action, ok FROM passport_audit ORDER BY id DESC LIMIT 1').get() });

test('login-params: unknown names look split with a stable, case-insensitive fake salt; accounts report their mode', async () => {
  assert.equal((await call('GET', '/api/auth/login-params')).status, 400);
  assert.equal((await call('GET', '/api/auth/login-params?username=a&username=b')).status, 400);
  const r = await call('GET', '/api/auth/login-params?username=nobody_here');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Object.keys(r.body).sort(), ['mode', 'salt', 'v']);
  assert.deepEqual([r.body.v, r.body.mode], [1, 'split']);
  assert.equal(Buffer.from(r.body.salt, 'base64').length, 16);
  assert.equal((await params('NOBODY_here')).salt, r.body.salt);
  assert.notEqual((await params('somebody_else')).salt, r.body.salt);
  await registerLegacy('lp_legacy');
  assert.deepEqual(await params('lp_legacy'), { v: 1, mode: 'password', salt: null });
  await registerSplit('lp_split', 3);
  assert.deepEqual(await params('LP_SPLIT'), { v: 1, mode: 'split', salt: salt(3) });
  assert.equal((await params('__webhook__')).mode, 'split');
});

test('register: the split shape creates a split account; mixed shapes and malformed keys are refused', async () => {
  const r = await registerSplit('rg_split', 4);
  assert.equal(r.status, 201);
  assert.equal(r.body.user.authMode, 'split');
  assert.equal(row('rg_split').auth_salt, salt(4));
  assert.equal((await call('POST', '/api/auth/register', { username: 'rg_both', email: 'rg_both@t.co', password: 'password123', authKey: key(1), authSalt: salt(1) })).status, 400);
  assert.equal((await call('POST', '/api/auth/register', { username: 'rg_bad', email: 'rg_bad@t.co', authKey: 'short', authSalt: salt(1) })).status, 400);
  assert.equal((await call('POST', '/api/auth/register', { username: 'rg_bad2', email: 'rg_bad2@t.co', authKey: key(1), authSalt: `${salt(1)} ` })).status, 400);
  assert.equal((await registerLegacy('rg_legacy')).body.user.authMode, 'password');
});

test('login: split accounts need authKey and never accept the plaintext password; legacy accounts are unchanged', async () => {
  await registerSplit('li_split', 5);
  await registerLegacy('li_legacy');
  const L = (body) => call('POST', '/api/auth/login', body);
  const ok = await L({ username: 'li_split', authKey: key(5) });
  assert.equal(ok.status, 200);
  assert.ok(ok.cookie.startsWith('dismesh_session='));
  const expect401 = async (body, error) => {
    const r = await L(body);
    assert.deepEqual([r.status, r.body.error], [401, error], JSON.stringify(body));
  };
  await expect401({ username: 'li_split', authKey: key(6) }, 'invalid credentials');
  await expect401({ username: 'li_split', password: 'password123' }, PLAIN_REFUSED);
  await expect401({ username: 'li_split', authKey: 'short', password: 'password123' }, PLAIN_REFUSED);
  await expect401({ username: 'li_nobody', password: 'password123' }, PLAIN_REFUSED);
  await expect401({ username: 'li_nobody', authKey: key(5) }, 'invalid credentials');
  await expect401({ username: 'li_legacy', authKey: key(5) }, 'invalid credentials');
  await expect401({ username: 'li_legacy', password: 'wrong-pass-1' }, 'invalid credentials');
  assert.equal((await L({ username: 'li_legacy', password: 'password123' })).status, 200);
  assert.equal((await L({ username: 'li_split' })).status, 400);
  assert.equal((await L({ username: ['li_split'], authKey: key(5) })).status, 400);
  assert.equal((await L({ username: 'x'.repeat(255), authKey: key(5) })).status, 400);
});

test('login: a split account with 2FA gets a pending token and /login/2fa completes it', async () => {
  await registerSplit('li_totp', 7);
  giveTotp('li_totp', ['totp-rec1']);
  const r = await call('POST', '/api/auth/login', { username: 'li_totp', authKey: key(7) });
  assert.equal(r.body.requiresTotp, true);
  assert.equal(r.cookie, '');
  const done = await call('POST', '/api/auth/login/2fa', { pendingToken: r.body.pendingToken, code: 'totp-rec1' });
  assert.equal(done.status, 200);
  assert.ok(done.cookie.startsWith('dismesh_session='));
});

test('login: a disabled split account is refused after the credential check', async () => {
  await registerSplit('li_dis', 16);
  db.prepare('UPDATE users SET is_disabled = 1 WHERE username = ?').run('li_dis');
  assert.equal((await call('POST', '/api/auth/login', { username: 'li_dis', authKey: key(16) })).status, 403);
  assert.equal((await call('POST', '/api/auth/login', { username: 'li_dis', authKey: key(17) })).status, 401);
});

test('the native Android payloads still work end to end for legacy accounts', async () => {
  assert.equal((await call('POST', '/api/auth/register', { username: 'an_user', email: 'an@t.co', password: 'password123' })).status, 201);
  giveTotp('an_user', ['an-rec1']);
  const step1 = await call('POST', '/api/auth/login', { username: 'an_user', password: 'password123' });
  assert.equal(step1.body.requiresTotp, true);
  assert.equal((await call('POST', '/api/auth/login/2fa', { pendingToken: step1.body.pendingToken, code: 'an-rec1' })).status, 200);
});

test('change-password (split): current key required, new key validated, backup tag enforced, salt rotated, other sessions revoked', async () => {
  const reg = await registerSplit('cp_split', 8);
  const other = await call('POST', '/api/auth/login', { username: 'cp_split', authKey: key(8) });
  const CP = (body) => call('POST', '/api/auth/change-password', body, reg.cookie);
  assert.equal((await CP({ currentPassword: 'password123', newPassword: 'another-pass-9' })).status, 400);
  assert.equal((await CP({ currentAuthKey: key(9), newAuthKey: key(10), newAuthSalt: salt(10) })).status, 401);
  assert.equal((await CP({ currentAuthKey: key(8), newAuthKey: 'short', newAuthSalt: salt(10) })).status, 400);
  givePassport('cp_split', 'split:v1');
  assert.equal((await CP({ currentAuthKey: key(8), newAuthKey: key(10), newAuthSalt: salt(10) })).status, 400);
  assert.equal((await CP({ currentAuthKey: key(8), newAuthKey: key(10), newAuthSalt: salt(10), backup: legacyBackup })).status, 400);
  const ok = await CP({ currentAuthKey: key(8), newAuthKey: key(10), newAuthSalt: salt(10), backup: splitBackup });
  assert.equal(ok.status, 200);
  assert.equal((await params('cp_split')).salt, salt(10));
  assert.equal((await call('POST', '/api/auth/login', { username: 'cp_split', authKey: key(8) })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { username: 'cp_split', authKey: key(10) })).status, 200);
  assert.equal((await call('GET', '/api/auth/me', null, reg.cookie)).status, 200);
  assert.equal((await call('GET', '/api/auth/me', null, other.cookie)).status, 401);
  assert.equal(db.prepare('SELECT encrypted_key FROM e2ee_key_backups WHERE user_id = ?').get(row('cp_split').id).encrypted_key, 'enc-split');
});

test('upgrade-credentials: needs a session and the current password; makes the account split and drops the password hash', async () => {
  const reg = await registerLegacy('up_one');
  const other = await call('POST', '/api/auth/login', { username: 'up_one', password: 'password123' });
  givePassport('up_one', 'argon-salt');
  const UP = (body, cookie = reg.cookie) => call('POST', '/api/auth/upgrade-credentials', body, cookie);
  const good = { currentPassword: 'password123', authKey: key(11), authSalt: salt(11), backup: splitBackup };
  assert.equal((await UP(good, '')).status, 401);
  assert.equal((await UP({ ...good, currentPassword: 'wrong-pass-1' })).status, 401);
  assert.equal((await UP({ ...good, backup: undefined })).status, 400);
  assert.equal((await UP({ ...good, backup: legacyBackup })).status, 400);
  assert.equal((await UP({ ...good, authSalt: 'nope' })).status, 400);
  assert.equal(row('up_one').auth_mode, 'password');
  const ok = await UP(good);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.authMode, 'split');
  const u = row('up_one');
  assert.deepEqual([u.auth_mode, u.auth_salt], ['split', salt(11)]);
  assert.equal(bcrypt.compareSync('password123', u.password_hash), false);
  assert.deepEqual(await params('up_one'), { v: 1, mode: 'split', salt: salt(11) });
  const plain = await call('POST', '/api/auth/login', { username: 'up_one', password: 'password123' });
  assert.deepEqual([plain.status, plain.body.error], [401, PLAIN_REFUSED]);
  assert.equal((await call('POST', '/api/auth/login', { username: 'up_one', authKey: key(11) })).status, 200);
  assert.equal((await call('GET', '/api/auth/me', null, reg.cookie)).status, 200);
  assert.equal((await call('GET', '/api/auth/me', null, other.cookie)).status, 401);
  assert.equal(db.prepare('SELECT encrypted_key FROM e2ee_key_backups WHERE user_id = ?').get(u.id).encrypted_key, 'enc-split');
  assert.equal((await UP(good)).status, 409);
});

test('upgrade-credentials: 2FA enforced, a wrong password never burns a recovery code, failures lock out, every outcome audited', async () => {
  const reg = await registerLegacy('up_totp');
  giveTotp('up_totp', ['up-rec1']);
  const good = { currentPassword: 'password123', authKey: key(12), authSalt: salt(12) };
  const UP = (body) => call('POST', '/api/auth/upgrade-credentials', body, reg.cookie);
  assert.equal((await UP({ ...good, code: 'up-rec1', backup: splitBackup })).status, 400); // no passport -> no backup allowed
  assert.deepEqual(lastAudit(), { action: 'upgrade', ok: 0 });
  const noCode = await UP(good);
  assert.deepEqual([noCode.status, noCode.body.requiresTotp], [401, true]);
  assert.deepEqual(lastAudit(), { action: 'upgrade', ok: 0 });
  await UP({ ...good, currentPassword: 'wrong-pass-1', code: 'up-rec1' });
  assert.deepEqual(JSON.parse(row('up_totp').totp_recovery_codes), ['up-rec1']);
  assert.equal((await UP({ ...good, code: 'up-rec1' })).status, 200);
  assert.deepEqual(lastAudit(), { action: 'upgrade', ok: 1 });
  assert.equal((await UP({ ...good, code: 'up-rec1' })).status, 409);
  assert.deepEqual(lastAudit(), { action: 'upgrade', ok: 0 });

  const reg2 = await registerLegacy('up_lock');
  const UP2 = (body) => call('POST', '/api/auth/upgrade-credentials', body, reg2.cookie);
  for (let i = 0; i < 5; i++) await UP2({ ...good, currentPassword: 'wrong-pass-1' });
  assert.equal((await UP2(good)).status, 429);
  assert.deepEqual(lastAudit(), { action: 'upgrade_locked', ok: 0 });
  assert.equal(row('up_lock').auth_mode, 'password');
});

test('admin reset: split targets take a browser-derived key, legacy targets a password; mismatched shapes are refused', async () => {
  const s = await registerSplit('ad_split', 13);
  await registerLegacy('ad_legacy');
  const users = (await call('GET', '/api/admin/users', null, ownerCookie)).body.users;
  assert.equal(users.find((u) => u.username === 'ad_split').authMode, 'split');
  assert.equal(users.find((u) => u.username === 'ad_legacy').authMode, 'password');
  const P = (name, body) => call('PATCH', `/api/admin/users/${row(name).id}`, body, ownerCookie);
  assert.equal((await P('ad_split', { password: 'newpass-123' })).status, 400);
  assert.equal((await P('ad_split', { authKey: 'short', authSalt: salt(14) })).status, 400);
  assert.equal((await P('ad_split', { authKey: key(14), authSalt: salt(14) })).status, 200);
  assert.deepEqual([row('ad_split').auth_mode, row('ad_split').auth_salt], ['split', salt(14)]);
  assert.equal((await call('GET', '/api/auth/me', null, s.cookie)).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { username: 'ad_split', authKey: key(13) })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { username: 'ad_split', authKey: key(14) })).status, 200);
  assert.equal((await P('ad_legacy', { authKey: key(15), authSalt: salt(15) })).status, 400);
  assert.equal((await P('ad_legacy', { password: 'short' })).status, 400);
  assert.equal((await P('ad_legacy', { password: 'newpass-123' })).status, 200);
  assert.equal(row('ad_legacy').auth_mode, 'password');
  assert.equal((await call('POST', '/api/auth/login', { username: 'ad_legacy', password: 'newpass-123' })).status, 200);
  assert.deepEqual(
    { ...db.prepare('SELECT action, ok FROM passport_audit WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(row('ad_legacy').id) },
    { action: 'admin_reset', ok: 1 },
  );
});

test('malformed JSON bodies answer 400 and never reach any log', async () => {
  const seen = [];
  const orig = { error: console.error, log: console.log, warn: console.warn };
  for (const k of Object.keys(orig)) console[k] = (...a) => { seen.push(a.map((x) => (x instanceof Error ? `${x.message}
${x.stack}
${x.body}` : JSON.stringify(x))).join(' ')); };
  let results;
  try {
    const post = (u) => fetch(base + u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"username":"x","password":"TopSecretPw-9","authKey":"SECRETKEYVALUE",' });
    results = [(await post('/api/auth/login')).status, (await post('/api/passport/login')).status, (await post('/api/auth/change-password')).status];
  } finally { Object.assign(console, orig); }
  assert.deepEqual(results, [400, 400, 400]);
  const all = seen.join(' | ');
  assert.equal(all.includes('TopSecretPw-9') || all.includes('SECRETKEYVALUE'), false);
});

test('login: the reserved webhook account behaves like an unknown name', async () => {
  const r = await call('POST', '/api/auth/login', { username: '__WebHook__', password: 'password123' });
  assert.deepEqual([r.status, r.body.error], [401, PLAIN_REFUSED]);
});

test('a pending 2FA login is dead after change-password, upgrade and admin reset', async () => {
  const pend = async (name, body) => (await call('POST', '/api/auth/login', { username: name, ...body })).body.pendingToken;
  const alive = (t) => pendingLogin.peek(t) !== null;

  const a = await registerSplit('pl_cp', 20);
  giveTotp('pl_cp', ['pl-rec1']);
  const ta = await pend('pl_cp', { authKey: key(20) });
  assert.ok(alive(ta));
  const cookieA = (await call('POST', '/api/auth/login/2fa', { pendingToken: await pend('pl_cp', { authKey: key(20) }), code: 'pl-rec1' })).cookie;
  assert.equal((await call('POST', '/api/auth/change-password', { currentAuthKey: key(20), newAuthKey: key(21), newAuthSalt: salt(21) }, cookieA)).status, 200);
  assert.equal(alive(ta), false);

  const b = await registerLegacy('pl_up');
  giveTotp('pl_up', ['pl-rec2', 'pl-rec3']);
  const tb = await pend('pl_up', { password: 'password123' });
  assert.ok(alive(tb));
  const cookieB = (await call('POST', '/api/auth/login/2fa', { pendingToken: await pend('pl_up', { password: 'password123' }), code: 'pl-rec2' })).cookie;
  assert.equal((await call('POST', '/api/auth/upgrade-credentials', { currentPassword: 'password123', authKey: key(22), authSalt: salt(22), code: 'pl-rec3' }, cookieB)).status, 200);
  assert.equal(alive(tb), false);

  await registerSplit('pl_ad', 23);
  giveTotp('pl_ad', ['pl-rec4']);
  const tc = await pend('pl_ad', { authKey: key(23) });
  assert.ok(alive(tc));
  assert.equal((await call('PATCH', `/api/admin/users/${row('pl_ad').id}`, { authKey: key(24), authSalt: salt(24) }, ownerCookie)).status, 200);
  assert.equal(alive(tc), false);
  assert.equal((await call('POST', '/api/auth/login/2fa', { pendingToken: tc, code: 'pl-rec4' })).status, 401);
  assert.ok(a && b);
});

test('upgrade without a code on a 2FA account does not count toward the lockout', async () => {
  const reg = await registerLegacy('up_nocode');
  giveTotp('up_nocode', ['nc-rec1']);
  const good = { currentPassword: 'password123', authKey: key(25), authSalt: salt(25) };
  const UP = (body) => call('POST', '/api/auth/upgrade-credentials', body, reg.cookie);
  for (let i = 0; i < 6; i++) assert.deepEqual([(await UP(good)).status], [401]);
  assert.equal((await UP({ ...good, code: 'nc-rec1' })).status, 200);
});

test('admin reset: a bad credential leaves other fields untouched, and the audit row names the acting admin', async () => {
  await registerSplit('ad_atomic', 26);
  const id = row('ad_atomic').id;
  const before = row('ad_atomic').display_name;
  const r = await call('PATCH', `/api/admin/users/${id}`, { displayName: 'Changed Name', authKey: 'short', authSalt: salt(26) }, ownerCookie);
  assert.equal(r.status, 400);
  assert.equal(row('ad_atomic').display_name, before);
  assert.equal((await call('PATCH', `/api/admin/users/${id}`, { authKey: key(27), authSalt: salt(27) }, ownerCookie)).status, 200);
  const a = db.prepare('SELECT action, actor_user_id FROM passport_audit WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(id);
  assert.deepEqual({ ...a }, { action: 'admin_reset', actor_user_id: row('sa_owner').id });
});

test('login and login-params accept the account email as well as the username', async () => {
  await registerSplit('em_split', 7);
  await registerLegacy('em_legacy');
  const L = (body) => call('POST', '/api/auth/login', body);
  assert.deepEqual(await params('EM_Split@T.co'), { v: 1, mode: 'split', salt: salt(7) });
  assert.deepEqual(await params('em_legacy@t.co'), { v: 1, mode: 'password', salt: null });
  assert.equal((await L({ username: 'em_split@t.co', authKey: key(7) })).status, 200);
  assert.equal((await L({ username: 'em_split@t.co', authKey: key(8) })).status, 401);
  assert.equal((await L({ username: 'EM_LEGACY@t.co', password: 'password123' })).status, 200);
  assert.equal((await L({ username: 'nobody@t.co', authKey: key(7) })).status, 401);
  assert.equal((await L({ username: 'em_split@t.co'.padEnd(300, 'x'), authKey: key(7) })).status, 400);
});
