'use strict';

const express = require('express');
const QRCode = require('qrcode');
const { db } = require('../db');
const { createSession, destroySession, sessionCookie } = require('../lib/session');
const { toPublicUser } = require('../lib/publicUser');
const { requireAuth } = require('../middleware/auth');
const totp = require('../lib/totp');
const pendingLogin = require('../lib/pendingLogin');
const accounts = require('../lib/accounts');
const { checkSecondFactor } = require('../lib/secondFactor');
const splitAuth = require('../lib/splitAuth');
const { isValidBackupFor } = require('../lib/passportCrypto');
const challenges = require('../lib/passportChallenges');
const { authAudit } = require('../lib/authAudit');
const hub = require('../socket/hub');
const registration = require('../lib/registration');

const router = express.Router();

// Two credential shapes: { password } (legacy; the native Android app) or { authKey, authSalt }
// (split; derived in the browser - docs/superpowers/specs/2026-10-01-split-password-design.md).
router.post('/register', (req, res) => {
  const { username, password, authKey, authSalt, email, displayName, inviteCode } = req.body || {};
  const blocked = registration.check(inviteCode);
  if (blocked) return res.status(blocked.status).json({ error: blocked.error });
  const problem = accounts.validateNewAccount({ username, email, password, authKey, authSalt });
  if (problem) return res.status(400).json({ error: problem });
  if (accounts.findConflict({ username, email })) {
    return res.status(409).json({ error: 'username or email already taken' });
  }
  let created;
  try {
    created = accounts.createAccount({ username, email, password, authKey, authSalt, displayName });
  } catch (err) {
    if (accounts.isUniqueViolation(err)) return res.status(409).json({ error: 'username or email already taken' });
    throw err;
  }
  const { userId, autoJoinServers } = created;
  const { token } = createSession(userId, req.headers['user-agent']);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  accounts.announceJoins(userId, autoJoinServers);
  res.setHeader('Set-Cookie', sessionCookie(req, token));
  res.status(201).json({ user: toPublicUser(user, { viewerIsSelf: true }) });
});

// First step of a web sign-in: which credential the name expects and, for split accounts, the
// Argon2 salt. See splitAuth.loginParams for what this does and does not reveal.
router.get('/login-params', (req, res) => {
  const { username } = req.query;
  if (typeof username !== 'string' || username.length < 1 || username.length > 254) {
    return res.status(400).json({ error: 'username required' });
  }
  res.set('Cache-Control', 'no-store');
  res.json(splitAuth.loginParams(username));
});

router.post('/login', (req, res) => {
  const { username, password, authKey } = req.body || {};
  if (typeof username !== 'string' || username.length < 1 || username.length > 254
    || (typeof password !== 'string' && typeof authKey !== 'string')
    || (typeof password === 'string' && password.length > 1024)) {
    return res.status(400).json({ error: 'username and password required' });
  }
  const user = splitAuth.findLoginUser(username);
  const outcome = splitAuth.checkLogin(user, { password, authKey });
  if (outcome !== 'ok') {
    return res.status(401).json({ error: outcome === 'plain_refused' ? splitAuth.PLAIN_REFUSED : 'invalid credentials' });
  }
  if (user.is_disabled) {
    return res.status(403).json({ error: 'account disabled' });
  }
  if (user.totp_enabled) {
    return res.json({ requiresTotp: true, pendingToken: pendingLogin.create(user.id) });
  }
  const { token } = createSession(user.id, req.headers['user-agent']);
  res.setHeader('Set-Cookie', sessionCookie(req, token));
  res.json({ user: toPublicUser(user, { viewerIsSelf: true }) });
});

// Second step of login for an account with 2FA enabled: the password already checked out (that's
// how `pendingToken` was minted), this only needs a valid TOTP code or an unused recovery code.
router.post('/login/2fa', (req, res) => {
  const { pendingToken, code } = req.body || {};
  // Non-consuming: a mistyped code must not burn the token, or the very next (correct) attempt
  // would fail with "login expired" instead of just being told the code was wrong.
  const userId = pendingLogin.peek(pendingToken);
  if (!userId) return res.status(401).json({ error: 'login expired, please sign in again' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user || !user.totp_enabled) return res.status(401).json({ error: 'login expired, please sign in again' });

  if (!checkSecondFactor(user, code)) return res.status(401).json({ error: 'invalid code' });

  pendingLogin.remove(pendingToken); // only now — the code is confirmed correct, so the pending login is used up
  const { token } = createSession(user.id, req.headers['user-agent']);
  res.setHeader('Set-Cookie', sessionCookie(req, token));
  res.json({ user: toPublicUser(user, { viewerIsSelf: true }) });
});

// --- 2FA management (already-authenticated) ---

router.post('/2fa/setup', requireAuth, async (req, res) => {
  if (req.user.totp_enabled) return res.status(400).json({ error: '2FA is already enabled' });
  const secret = totp.generateSecret();
  db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(secret, req.user.id);
  const url = totp.otpauthUrl(secret, { label: req.user.username });
  const qrDataUrl = await QRCode.toDataURL(url, { margin: 1, width: 240 });
  res.json({ secret, otpauthUrl: url, qrDataUrl });
});

// Confirms the code round-trips against the secret /setup just stored, then actually turns 2FA
// on. Splitting setup/enable means an abandoned setup (scanned the QR, never entered a code)
// leaves totp_enabled at 0 — login is unaffected either way.
router.post('/2fa/enable', requireAuth, (req, res) => {
  if (req.user.totp_enabled) return res.status(400).json({ error: '2FA is already enabled' });
  if (!req.user.totp_secret) return res.status(400).json({ error: 'call /2fa/setup first' });
  if (!totp.verifyToken(req.user.totp_secret, req.body?.code)) {
    return res.status(400).json({ error: 'invalid code' });
  }
  const recoveryCodes = totp.generateRecoveryCodes();
  db.prepare('UPDATE users SET totp_enabled = 1, totp_recovery_codes = ? WHERE id = ?')
    .run(JSON.stringify(recoveryCodes), req.user.id);
  res.json({ ok: true, recoveryCodes });
});

router.post('/2fa/disable', requireAuth, (req, res) => {
  if (!req.user.totp_enabled) return res.status(400).json({ error: '2FA is not enabled' });
  if (!checkSecondFactor(req.user, req.body?.code)) return res.status(400).json({ error: 'invalid code' });
  db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_recovery_codes = NULL WHERE id = ?').run(req.user.id);
  res.json({ ok: true });
});

// Re-entry of the password before opening the administration screens (mobile app).
router.post('/verify-password', requireAuth, (req, res) => {
  const lockKey = `pwverify:${req.user.id}`;
  if (challenges.isLocked(lockKey)) return res.status(429).json({ error: 'too many attempts, try again later' });
  if (!splitAuth.verifyCurrentCredential(req.user, req.body || {})) {
    challenges.recordFailure(lockKey);
    return res.status(401).json({ error: 'current password is incorrect' });
  }
  challenges.clearFailures(lockKey);
  res.json({ ok: true });
});

router.post('/change-password', requireAuth, (req, res) => {
  const b = req.body || {};
  const user = req.user;
  const split = user.auth_mode === 'split';
  // A stolen session cookie would otherwise let an attacker brute-force a split account's authKey
  // here instead of through /upgrade-credentials, which already locks (same key namespace style).
  const lockKey = `pwchange:${user.id}`;
  if (challenges.isLocked(lockKey)) {
    return res.status(429).json({ error: 'too many attempts, try again later' });
  }
  if (split ? typeof b.newAuthKey !== 'string' : (typeof b.currentPassword !== 'string' || typeof b.newPassword !== 'string')) {
    return res.status(400).json({
      error: split ? 'this account uses strengthened sign-in: currentAuthKey, newAuthKey and newAuthSalt required' : 'currentPassword and newPassword required',
    });
  }
  if (!splitAuth.verifyCurrentCredential(user, b)) {
    challenges.recordFailure(lockKey);
    return res.status(401).json({ error: 'current password is incorrect' });
  }
  const next = split ? { authKey: b.newAuthKey, authSalt: b.newAuthSalt } : { password: b.newPassword };
  const problem = split ? splitAuth.splitKeyProblem(next) : splitAuth.credentialProblem(next);
  if (problem) return res.status(400).json({ error: problem });
  // Explicit opt-in for a user with no seed on this device and no backup file to restore from (the
  // realistic case an admin reset creates): drops the now-unrecoverable backup instead of requiring
  // a re-wrapped one. users.passport_id is untouched either way.
  const dropBackup = b.dropBackup === true && b.backup === undefined;
  // Otherwise the seed backup is wrapped with a key derived from the password, so it must be
  // re-wrapped in the same request or the user could never unwrap it again after the next login.
  if (user.passport_id && !dropBackup && !isValidBackupFor(user.auth_mode, b.backup)) {
    return res.status(400).json({ error: 're-wrapped passport backup required' });
  }
  accounts.inTransaction(() => {
    splitAuth.setCredential(user.id, next);
    if (user.passport_id) {
      if (dropBackup) accounts.deleteBackup(user.id);
      else accounts.saveBackup(user.id, b.backup);
    }
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(user.id, req.sessionToken);
  });
  // Sockets are not tied to a session, so the only way to drop the signed-out sessions' live
  // sockets is to close all of the user's sockets; the current tab reconnects with its still-valid cookie.
  pendingLogin.removeForUser(user.id);
  hub.disconnectUser(user.id, 4002, 'password changed');
  challenges.clearFailures(lockKey);
  res.json({ ok: true });
});

// Legacy -> split, only on the user's explicit request (Settings -> Passport). Overwrites the
// bcrypt(password) hash: keeping it would leave the server a password verifier to brute-force and
// keep plaintext sign-in open. The new password must differ from the current one (checked in the
// browser): the server has seen the current one at every legacy sign-in.
router.post('/upgrade-credentials', requireAuth, (req, res) => {
  const b = req.body || {};
  const user = req.user;
  const lockKey = `upgrade:${user.id}`;
  const fail = (status, body, countsAsFailure = false) => {
    if (countsAsFailure) challenges.recordFailure(lockKey);
    authAudit(user.id, user.passport_id, 'upgrade', false, req);
    return res.status(status).json(body);
  };
  if (challenges.isLocked(lockKey)) {
    authAudit(user.id, user.passport_id, 'upgrade_locked', false, req);
    return res.status(429).json({ error: 'too many attempts, try again later' });
  }
  if (user.auth_mode === 'split') return fail(409, { error: 'sign-in is already strengthened' });
  const problem = splitAuth.splitKeyProblem({ authKey: b.authKey, authSalt: b.authSalt });
  if (problem) return fail(400, { error: problem });
  const backupOk = user.passport_id ? isValidBackupFor('split', b.backup) : b.backup === undefined;
  if (!backupOk) return fail(400, { error: 're-wrapped passport backup required' });
  const passwordOk = splitAuth.verifyCurrentCredential(user, { currentPassword: b.currentPassword });
  // Only after the password checked out, so a wrong password never burns a recovery code.
  const secondFactorOk = passwordOk && (!user.totp_enabled || checkSecondFactor(user, b.code));
  if (passwordOk && user.totp_enabled && !b.code) return fail(401, { error: 'invalid credentials', requiresTotp: true });
  if (!secondFactorOk) {
    return fail(401, { error: 'invalid credentials', ...(user.totp_enabled ? { requiresTotp: true } : {}) }, true);
  }
  accounts.inTransaction(() => {
    splitAuth.setCredential(user.id, { authKey: b.authKey, authSalt: b.authSalt });
    if (user.passport_id) accounts.saveBackup(user.id, b.backup);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(user.id, req.sessionToken);
  });
  pendingLogin.removeForUser(user.id);
  hub.disconnectUser(user.id, 4002, 'credentials changed');
  challenges.clearFailures(lockKey);
  authAudit(user.id, user.passport_id, 'upgrade', true, req);
  res.json({ user: toPublicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id), { viewerIsSelf: true }) });
});

router.post('/logout', requireAuth, (req, res) => {
  destroySession(req.sessionToken);
  res.setHeader('Set-Cookie', 'dismesh_session=; Path=/; HttpOnly; Max-Age=0');
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: toPublicUser(req.user, { viewerIsSelf: true }) });
});

module.exports = router;
