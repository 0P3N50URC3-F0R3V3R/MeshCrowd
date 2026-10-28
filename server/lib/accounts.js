'use strict';

const { db } = require('../db');
const { OWNER_SITE_PERMISSIONS } = require('./permissions');
const { postServerEvent } = require('./systemMessages');
const { broadcastToServer } = require('../socket/hub');
const { toPublicUser } = require('./publicUser');
const { singleLine } = require('./textSanitize');
const { credentialProblem, credentialColumns } = require('./splitAuth');
const { isValidBackupFor } = require('./passportCrypto');

const USERNAME_RE = /^[a-zA-Z0-9_.]{3,32}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateNewAccount({ username, email, password, authKey, authSalt }) {
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    return 'username must be 3-32 chars: letters, numbers, underscore, dot';
  }
  if (typeof email !== 'string' || !EMAIL_RE.test(email)) return 'invalid email';
  return credentialProblem({ password, authKey, authSalt });
}

function findConflict({ username, email }) {
  return !!db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE').get(username, email);
}

// The tag must match the account mode (spec: a split account only ever stores a split:v1 backup, a
// legacy account never does). authMode defaults to the stored row; pass it when the mode is about to change.
function saveBackup(userId, backup, authMode) {
  const mode = authMode || (db.prepare('SELECT auth_mode FROM users WHERE id = ?').get(userId) || {}).auth_mode;
  if (!isValidBackupFor(mode, backup)) throw new Error('backup does not match the account sign-in mode');
  db.prepare(
    `INSERT INTO e2ee_key_backups (user_id, encrypted_key, salt, nonce) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET encrypted_key = excluded.encrypted_key, salt = excluded.salt, nonce = excluded.nonce, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).run(userId, backup.encryptedKey, backup.salt, backup.nonce);
}

// Explicit opt-in for a user with no seed and no recoverable backup file (e.g. after an admin
// reset): discards the now-unrecoverable wrapped seed instead of re-wrapping it. Leaves
// users.passport_id untouched - the account keeps its Passport identity row.
function deleteBackup(userId) {
  db.prepare('DELETE FROM e2ee_key_backups WHERE user_id = ?').run(userId);
}

// node:sqlite has no db.transaction(); a throw inside fn rolls everything back.
function inTransaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* no transaction left to roll back */ }
    throw err;
  }
}

function isUniqueViolation(err) {
  return /UNIQUE constraint failed/i.test(String(err && err.message));
}

function createAccount(input) {
  const result = inTransaction(() => createAccountRows(input));
  // After COMMIT, so a rollback can never leave a join message behind.
  for (const s of result.autoJoinServers) postServerEvent(s.id, 'member_join', result.userId);
  return result;
}

function createAccountRows({ username, email, password, authKey, authSalt, displayName, passport }) {
  // Excludes the reserved webhook-messages placeholder account (db/index.js WEBHOOK_SYSTEM_USER_ID,
  // bootstrapped at startup before anyone ever registers) - otherwise it always occupies "user #1"
  // and no real registrant on a fresh instance would ever qualify as the first user/site owner.
  const isFirstUser = db.prepare("SELECT COUNT(*) AS c FROM users WHERE username != '__webhook__' AND is_bot = 0").get().c === 0;
  const cred = credentialColumns({ password, authKey, authSalt });
  const name = (displayName && singleLine(displayName, 64)) || username;

  const info = passport
    ? db.prepare(
      `INSERT INTO users (username, email, password_hash, auth_mode, auth_salt, display_name, passport_id, passport_public_key, e2ee_public_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(username, email, cred.passwordHash, cred.authMode, cred.authSalt, name, passport.id, passport.publicKey, passport.e2eePublicKey)
    : db.prepare('INSERT INTO users (username, email, password_hash, auth_mode, auth_salt, display_name) VALUES (?, ?, ?, ?, ?, ?)')
      .run(username, email, cred.passwordHash, cred.authMode, cred.authSalt, name);
  const userId = Number(info.lastInsertRowid);

  if (passport) saveBackup(userId, passport.backup, cred.authMode);

  if (isFirstUser) {
    const roleInfo = db.prepare(
      'INSERT INTO site_roles (name, color, permissions, position) VALUES (?, ?, ?, ?)',
    ).run('Owner', '#f04747', OWNER_SITE_PERMISSIONS, 100);
    db.prepare('INSERT INTO user_site_roles (user_id, role_id) VALUES (?, ?)').run(userId, roleInfo.lastInsertRowid);
  }

  // Public servers marked "auto-join" are the site's welcome/community spaces - every fresh
  // account lands in them immediately (still leavable afterwards, same as any membership).
  const autoJoinServers = db.prepare("SELECT id FROM servers WHERE visibility = 'public' AND auto_join = 1").all();
  for (const s of autoJoinServers) {
    db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(s.id, userId);
  }
  return { userId, autoJoinServers };
}

function announceJoins(userId, autoJoinServers) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  for (const s of autoJoinServers) {
    broadcastToServer(s.id, { type: 'member_join', serverId: s.id, user: toPublicUser(user, {}) });
  }
}

module.exports = {
  validateNewAccount, findConflict, createAccount, announceJoins, saveBackup, deleteBackup, inTransaction, isUniqueViolation,
};
