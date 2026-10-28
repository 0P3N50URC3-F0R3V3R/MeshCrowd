'use strict';

// Credential rules for the two sign-in modes (docs/superpowers/specs/2026-10-01-split-password-design.md):
// 'password' (legacy, the native Android app: the server receives the password) and 'split' (the
// browser derives authKey + wrapKey from the password; only authKey is ever sent).

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { db } = require('../db');

const BCRYPT_COST = 12;
const AUTH_KEY_BYTES = 32;
const AUTH_SALT_BYTES = 16;
const PLAIN_REFUSED = 'invalid credentials. If you strengthened your sign-in, use the web app or an updated app.';

// Same cost as every real hash, so an unknown user or a wrong-shape request takes as long as a real check.
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), BCRYPT_COST);

// Exactly the canonical padded base64 of `len` bytes, so one key has one textual form.
function isCanonical(b64, len) {
  if (typeof b64 !== 'string') return false;
  const buf = Buffer.from(b64, 'base64');
  return buf.length === len && buf.toString('base64') === b64;
}
const isAuthKey = (s) => isCanonical(s, AUTH_KEY_BYTES);
const isAuthSalt = (s) => isCanonical(s, AUTH_SALT_BYTES);

function splitKeyProblem({ authKey, authSalt }) {
  return isAuthKey(authKey) && isAuthSalt(authSalt) ? null : 'invalid sign-in key';
}

// The password length rule can only be enforced here for legacy accounts; for split accounts the
// browser enforces it (the server never sees the password).
function credentialProblem({ password, authKey, authSalt }) {
  if (authKey === undefined && authSalt === undefined) {
    return typeof password === 'string' && password.length >= 8 ? null : 'password must be at least 8 characters';
  }
  if (password !== undefined) return 'send either a password or a sign-in key, not both';
  return splitKeyProblem({ authKey, authSalt });
}

function credentialColumns({ password, authKey, authSalt }) {
  const problem = credentialProblem({ password, authKey, authSalt });
  if (problem) throw new Error(`invalid credential: ${problem}`);
  if (authKey === undefined && authSalt === undefined) {
    return { passwordHash: bcrypt.hashSync(password, BCRYPT_COST), authMode: 'password', authSalt: null };
  }
  return { passwordHash: bcrypt.hashSync(authKey, BCRYPT_COST), authMode: 'split', authSalt };
}

// Overwrites the previous hash: after a switch to split nothing derived from the password itself is kept.
function setCredential(userId, credential) {
  const c = credentialColumns(credential);
  db.prepare('UPDATE users SET password_hash = ?, auth_mode = ?, auth_salt = ? WHERE id = ?')
    .run(c.passwordHash, c.authMode, c.authSalt, userId);
}

// One bcrypt comparison on every path so response time does not reveal unknown vs legacy vs split.
// A plaintext password is never accepted for a split account; for unknown and split names it gets
// PLAIN_REFUSED (the same pair login-params cannot tell apart either).
function checkLogin(user, { password, authKey }) {
  if (user && user.auth_mode === 'split' && isAuthKey(authKey)) {
    return bcrypt.compareSync(authKey, user.password_hash) ? 'ok' : 'bad';
  }
  if (user && user.auth_mode !== 'split' && typeof password === 'string') {
    return bcrypt.compareSync(password, user.password_hash) ? 'ok' : 'bad';
  }
  bcrypt.compareSync('dummy', DUMMY_HASH);
  return typeof password === 'string' && (!user || user.auth_mode === 'split') ? 'plain_refused' : 'bad';
}

// For session-authenticated changes (change-password, attach, upgrade): the field must match the mode.
function verifyCurrentCredential(user, { currentPassword, currentAuthKey }) {
  if (user.auth_mode === 'split') {
    if (isAuthKey(currentAuthKey)) return bcrypt.compareSync(currentAuthKey, user.password_hash);
    bcrypt.compareSync('dummy', DUMMY_HASH);
    return false;
  }
  return typeof currentPassword === 'string' && bcrypt.compareSync(currentPassword, user.password_hash);
}

// Sign-in accepts the username or the account email. Usernames cannot contain '@' (USERNAME_RE),
// so the two namespaces never collide. The reserved webhook account is never a login.
function findLoginUser(identifier) {
  if (typeof identifier !== 'string') return null;
  const column = identifier.includes('@') ? 'email' : 'username';
  return db.prepare(`SELECT * FROM users WHERE ${column} = ? COLLATE NOCASE AND username != '__webhook__' AND is_bot = 0`).get(identifier) || null;
}

let fakeSaltSecret = null;
function getFakeSaltSecret() {
  if (!fakeSaltSecret) {
    db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('login_params_secret', ?)").run(crypto.randomBytes(32).toString('hex'));
    fakeSaltSecret = Buffer.from(db.prepare("SELECT value FROM meta WHERE key = 'login_params_secret'").get().value, 'hex');
  }
  return fakeSaltSecret;
}

function fakeSalt(username) {
  return crypto.createHmac('sha256', getFakeSaltSecret())
    .update(`mc-login-salt|${username.replace(/[A-Z]/g, (c) => c.toLowerCase())}`).digest().subarray(0, AUTH_SALT_BYTES).toString('base64');
}

// Unknown names (and the reserved webhook account) answer like split accounts with a stable salt,
// so this endpoint does not single out which names are split. Legacy accounts are distinguishable;
// username existence is already public (registration 409, user search) - see the spec.
function loginParams(rawUsername) {
  const username = typeof rawUsername === 'string' ? rawUsername : '';
  const user = findLoginUser(username);
  if (user && user.auth_mode !== 'split') return { v: 1, mode: 'password', salt: null };
  return { v: 1, mode: 'split', salt: user ? user.auth_salt : fakeSalt(username) };
}

module.exports = {
  PLAIN_REFUSED, isAuthKey, isAuthSalt, splitKeyProblem, credentialProblem, credentialColumns, setCredential,
  checkLogin, verifyCurrentCredential, loginParams, findLoginUser,
};
