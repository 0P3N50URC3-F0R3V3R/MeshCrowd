'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const bcrypt = require('bcryptjs');
const { db } = require('../db');
const accounts = require('../lib/accounts');
const splitAuth = require('../lib/splitAuth');
const { toPublicUser } = require('../lib/publicUser');

test.after(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

const key = (n) => Buffer.alloc(32, n).toString('base64');
const salt = (n) => Buffer.alloc(16, n).toString('base64');
const splitUser = { auth_mode: 'split', password_hash: bcrypt.hashSync(key(3), 4) };
const legacyUser = { auth_mode: 'password', password_hash: bcrypt.hashSync('password1', 4) };
const LOGIN_CASES = [
  [splitUser, { authKey: key(3) }, 'ok'],
  [splitUser, { authKey: key(4) }, 'bad'],
  [splitUser, { password: 'password1' }, 'plain_refused'],
  [splitUser, { authKey: 'short', password: 'password1' }, 'plain_refused'],
  [legacyUser, { password: 'password1' }, 'ok'],
  [legacyUser, { password: 'nope-nope' }, 'bad'],
  [legacyUser, { authKey: key(3) }, 'bad'],
  [undefined, { password: 'password1' }, 'plain_refused'],
  [undefined, { authKey: key(3) }, 'bad'],
];

test('isAuthKey / isAuthSalt accept only canonical base64 of the exact length', () => {
  assert.equal(splitAuth.isAuthKey(key(1)), true);
  assert.equal(splitAuth.isAuthSalt(salt(1)), true);
  for (const bad of [null, 42, '', salt(1), `${key(1)} `, key(1).replace('=', ''), Buffer.alloc(33, 1).toString('base64'), 'not base64!!']) {
    assert.equal(splitAuth.isAuthKey(bad), false, String(bad));
  }
  for (const bad of [null, '', key(1), `${salt(1)} `, 'AQEBAQEBAQEBAQEBAQEBAR==']) {
    assert.equal(splitAuth.isAuthSalt(bad), false, String(bad));
  }
});

test('existing and raw-inserted users default to legacy mode with no salt', () => {
  const id = db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run('sa_raw', 'sa_raw@t.co', 'h', 'raw').lastInsertRowid;
  assert.deepEqual({ ...db.prepare('SELECT auth_mode, auth_salt FROM users WHERE id = ?').get(id) }, { auth_mode: 'password', auth_salt: null });
});

test('credentialProblem accepts exactly one well-formed credential shape', () => {
  assert.equal(splitAuth.credentialProblem({ password: 'password1' }), null);
  assert.match(splitAuth.credentialProblem({ password: 'short' }), /at least 8/);
  assert.equal(splitAuth.credentialProblem({ authKey: key(1), authSalt: salt(1) }), null);
  assert.match(splitAuth.credentialProblem({ authKey: key(1) }), /sign-in key/);
  assert.match(splitAuth.credentialProblem({ authKey: key(1), authSalt: salt(1), password: 'password1' }), /either/);
  assert.equal(splitAuth.splitKeyProblem({ authKey: key(1), authSalt: salt(1) }), null);
  assert.match(splitAuth.splitKeyProblem({}), /sign-in key/);
});

test('createAccount stores a split row (mode, salt, bcrypt of authKey) and toPublicUser shows authMode to the user only', () => {
  const { userId } = accounts.createAccount({ username: 'sa_split', email: 'sa_split@t.co', authKey: key(2), authSalt: salt(2) });
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  assert.deepEqual([u.auth_mode, u.auth_salt], ['split', salt(2)]);
  assert.equal(bcrypt.compareSync(key(2), u.password_hash), true);
  assert.equal(toPublicUser(u, { viewerIsSelf: true }).authMode, 'split');
  assert.equal(toPublicUser(u, {}).authMode, undefined);
  assert.match(accounts.validateNewAccount({ username: 'okname', email: 'a@b.co', authKey: 'x', authSalt: salt(1) }), /sign-in key/);
  assert.equal(accounts.validateNewAccount({ username: 'okname', email: 'a@b.co', authKey: key(1), authSalt: salt(1) }), null);
  assert.equal(accounts.validateNewAccount({ username: 'okname', email: 'a@b.co', password: 'password1' }), null);
});

test('loginParams: legacy, split, unknown (stable, case-insensitive fake salt) and the reserved webhook account', () => {
  accounts.createAccount({ username: 'sa_legacy', email: 'sa_legacy@t.co', password: 'password1' });
  assert.deepEqual(splitAuth.loginParams('SA_LEGACY'), { v: 1, mode: 'password', salt: null });
  assert.deepEqual(splitAuth.loginParams('sa_split'), { v: 1, mode: 'split', salt: salt(2) });
  const fake = splitAuth.loginParams('no_such_user');
  assert.equal(fake.mode, 'split');
  assert.equal(splitAuth.isAuthSalt(fake.salt), true);
  assert.equal(splitAuth.loginParams('No_Such_User').salt, fake.salt);
  assert.notEqual(splitAuth.loginParams('no_such_user2').salt, fake.salt);
  assert.equal(splitAuth.loginParams('__webhook__').mode, 'split');
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'login_params_secret'").get().value.length, 64);
});

test('checkLogin outcome matrix', () => {
  for (const [user, body, expected] of LOGIN_CASES) {
    assert.equal(splitAuth.checkLogin(user, body), expected, JSON.stringify([user && user.auth_mode, body]));
  }
});

test('checkLogin performs exactly one bcrypt comparison on every path', () => {
  const original = bcrypt.compareSync;
  let calls = 0;
  bcrypt.compareSync = (...args) => { calls += 1; return original(...args); };
  try {
    for (const [user, body] of LOGIN_CASES) {
      calls = 0;
      splitAuth.checkLogin(user, body);
      assert.equal(calls, 1, JSON.stringify([user && user.auth_mode, body]));
    }
  } finally {
    bcrypt.compareSync = original;
  }
});

test('verifyCurrentCredential follows the account mode', () => {
  assert.equal(splitAuth.verifyCurrentCredential(splitUser, { currentAuthKey: key(3) }), true);
  assert.equal(splitAuth.verifyCurrentCredential(splitUser, { currentPassword: key(3) }), false);
  assert.equal(splitAuth.verifyCurrentCredential(legacyUser, { currentPassword: 'password1' }), true);
  assert.equal(splitAuth.verifyCurrentCredential(legacyUser, { currentAuthKey: 'password1' }), false);
});

test('setCredential switches hash, mode and salt together', () => {
  const id = db.prepare('SELECT id FROM users WHERE username = ?').get('sa_legacy').id;
  const read = () => db.prepare('SELECT password_hash, auth_mode, auth_salt FROM users WHERE id = ?').get(id);
  splitAuth.setCredential(id, { authKey: key(5), authSalt: salt(5) });
  assert.deepEqual([read().auth_mode, read().auth_salt], ['split', salt(5)]);
  assert.equal(bcrypt.compareSync('password1', read().password_hash), false);
  assert.equal(bcrypt.compareSync(key(5), read().password_hash), true);
  splitAuth.setCredential(id, { password: 'password2' });
  assert.deepEqual([read().auth_mode, read().auth_salt], ['password', null]);
  assert.equal(bcrypt.compareSync('password2', read().password_hash), true);
});

test('credentialColumns / setCredential refuse half-set or malformed input', () => {
  const id = db.prepare('SELECT id FROM users WHERE username = ?').get('sa_split').id;
  const before = db.prepare('SELECT password_hash, auth_mode, auth_salt FROM users WHERE id = ?').get(id);
  for (const bad of [
    { authKey: key(1) }, { authSalt: salt(1) }, { authKey: key(1), authSalt: undefined }, { authKey: null, authSalt: salt(1) },
    { password: 'x' }, {}, { password: 'password1', authKey: key(1), authSalt: salt(1) }, { authKey: 'short', authSalt: salt(1) },
  ]) {
    assert.throws(() => splitAuth.credentialColumns(bad), /invalid credential/, JSON.stringify(bad));
    assert.throws(() => splitAuth.setCredential(id, bad), /invalid credential/, JSON.stringify(bad));
  }
  assert.deepEqual(db.prepare('SELECT password_hash, auth_mode, auth_salt FROM users WHERE id = ?').get(id), before);
});

test('saveBackup and createAccount enforce the backup tag against the account mode', () => {
  const tagged = { encryptedKey: 'e', salt: 'split:v1', nonce: 'n' };
  const legacy = { encryptedKey: 'e', salt: 'AAAA', nonce: 'n' };
  const pp = (n, backup) => ({ id: `pid${n}`, publicKey: `pk${n}`, e2eePublicKey: `ek${n}`, backup });
  assert.throws(() => accounts.createAccount({ username: 'sa_bk1', email: 'sa_bk1@t.co', authKey: key(6), authSalt: salt(6), passport: pp(1, legacy) }), /backup does not match/);
  assert.throws(() => accounts.createAccount({ username: 'sa_bk2', email: 'sa_bk2@t.co', password: 'password1', passport: pp(2, tagged) }), /backup does not match/);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM users WHERE username IN ('sa_bk1','sa_bk2')").get().c, 0);
  const { userId } = accounts.createAccount({ username: 'sa_bk3', email: 'sa_bk3@t.co', authKey: key(6), authSalt: salt(6), passport: pp(3, tagged) });
  assert.throws(() => accounts.saveBackup(userId, legacy), /backup does not match/);
  accounts.saveBackup(userId, tagged);
});

test('loginParams treats non-string input like an unknown name and folds only ASCII case', () => {
  const empty = splitAuth.loginParams('');
  for (const v of [undefined, null, ['a', 'b'], { a: 1 }, 42]) assert.deepEqual(splitAuth.loginParams(v), empty);
  assert.equal(splitAuth.loginParams('Kelvin').salt, splitAuth.loginParams('kelvin').salt);
  assert.notEqual(splitAuth.loginParams(`${String.fromCharCode(0x212a)}elvin`).salt, splitAuth.loginParams('kelvin').salt);
});
