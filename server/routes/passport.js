'use strict';

const express = require('express');
const { db } = require('../db');
const { createSession, destroyAllSessionsForUser, sessionCookie } = require('../lib/session');
const { toPublicUser } = require('../lib/publicUser');
const { requireAuth } = require('../middleware/auth');
const accounts = require('../lib/accounts');
const pendingLogin = require('../lib/pendingLogin');
const { checkSecondFactor } = require('../lib/secondFactor');
const hub = require('../socket/hub');
const {
  passportIdFromPublicKey, ID_RE, decodePublicKey, verifyChallenge, isValidBackupFor,
} = require('../lib/passportCrypto');
const challenges = require('../lib/passportChallenges');
const { isAllowedOrigin } = require('../lib/passportOrigin');
const splitAuth = require('../lib/splitAuth');
const { authAudit: audit } = require('../lib/authAudit');

const router = express.Router();

// The origin this request claims to have reached. The Host header is attacker-controlled, so it is
// only ever used when it is on the allow-list (see lib/passportOrigin.js); otherwise proofs fail.
function requestOrigin(req) {
  return `${req.protocol}://${String(req.get('host') || '').toLowerCase()}`;
}

// Stands in for the real key when the id is unknown so every failure runs the same work.
const DUMMY_KEY = Buffer.alloc(32, 7);

// Consumes the nonce first, always, so a nonce is single-use whatever else is wrong with the
// request and known/unknown/bad-signature paths cannot be told apart by replaying it.
function proofOk(req, purpose, publicKey, body) {
  const origin = requestOrigin(req);
  const fresh = challenges.consume(body.nonce, body.issuedAt, origin);
  const signed = verifyChallenge({
    publicKey: publicKey || DUMMY_KEY, purpose, origin, nonce: body.nonce, issuedAt: body.issuedAt, signature: body.signature,
  });
  return fresh && !!publicKey && signed && isAllowedOrigin(origin, req);
}

const INVALID = { error: 'invalid passport proof' };
const lockKeyFor = (passportId) => `id:${passportId || 'invalid'}`;

router.post('/challenge', (req, res) => {
  const origin = requestOrigin(req);
  if (!isAllowedOrigin(origin, req)) return res.status(400).json({ error: 'unrecognised server address' });
  res.json(challenges.issue(origin));
});

router.post('/register', (req, res) => {
  const b = req.body || {};
  // Web sign-ups are always split: this server must never receive the password itself.
  if (b.password !== undefined || b.authKey === undefined) return res.status(400).json({ error: 'invalid sign-in key' });
  const problem = accounts.validateNewAccount({ username: b.username, email: b.email, authKey: b.authKey, authSalt: b.authSalt });
  if (problem) return res.status(400).json({ error: problem });
  const publicKey = decodePublicKey(b.passportPublicKey);
  const e2eeKey = decodePublicKey(b.e2eePublicKey);
  if (!publicKey || !e2eeKey || !isValidBackupFor('split', b.backup)) return res.status(400).json({ error: 'invalid passport data' });

  const passportId = passportIdFromPublicKey(publicKey);
  if (!proofOk(req, 'register', publicKey, b)) {
    audit(null, passportId, 'register', false, req);
    return res.status(401).json(INVALID);
  }
  const existing = db.prepare('SELECT username FROM users WHERE passport_id = ?').get(passportId);
  if (existing) {
    audit(null, passportId, 'register', false, req);
    return res.status(409).json({ error: 'this passport already has an account on this server', username: existing.username });
  }
  if (accounts.findConflict(b)) {
    audit(null, passportId, 'register', false, req);
    return res.status(409).json({ error: 'username or email already taken' });
  }
  let created;
  try {
    created = accounts.createAccount({
      username: b.username, email: b.email, authKey: b.authKey, authSalt: b.authSalt, displayName: b.displayName,
      passport: { id: passportId, publicKey: b.passportPublicKey, e2eePublicKey: b.e2eePublicKey, backup: b.backup },
    });
  } catch (err) {
    if (!accounts.isUniqueViolation(err)) throw err;
    audit(null, passportId, 'register', false, req);
    return res.status(409).json({ error: 'username, email or passport already taken' });
  }
  const { userId, autoJoinServers } = created;
  const { token } = createSession(userId, req.headers['user-agent']);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  accounts.announceJoins(userId, autoJoinServers);
  audit(userId, passportId, 'register', true, req);
  res.setHeader('Set-Cookie', sessionCookie(req, token));
  res.status(201).json({ user: toPublicUser(user, { viewerIsSelf: true }) });
});

// Shared front half of login/recover: lockout, nonce, lookup, proof. Returns the user row or sends
// the failure response itself. Unknown ids and bad proofs are indistinguishable to the caller.
// Failure counters are NOT cleared here; the caller clears them once the whole request succeeded.
function authenticateById(req, res, purpose) {
  const b = req.body || {};
  const passportId = typeof b.passportId === 'string' && ID_RE.test(b.passportId) ? b.passportId : null;
  const lockKey = lockKeyFor(passportId);
  if (challenges.isLocked(lockKey)) {
    audit(null, passportId, `${purpose}_locked`, false, req);
    res.status(429).json({ error: 'too many attempts, try again later' });
    return null;
  }
  const user = passportId ? db.prepare('SELECT * FROM users WHERE passport_id = ?').get(passportId) : null;
  const publicKey = user ? decodePublicKey(user.passport_public_key) : null;
  if (!proofOk(req, purpose, publicKey, b)) {
    challenges.recordFailure(lockKey);
    audit(user?.id, passportId, purpose, false, req);
    res.status(401).json(INVALID);
    return null;
  }
  return user;
}

router.post('/login', (req, res) => {
  const user = authenticateById(req, res, 'login');
  if (!user) return;
  if (user.is_disabled) {
    audit(user.id, user.passport_id, 'login', false, req);
    return res.status(403).json({ error: 'account disabled' });
  }
  challenges.clearFailures(lockKeyFor(user.passport_id));
  if (user.totp_enabled) {
    const pendingToken = pendingLogin.create(user.id);
    audit(user.id, user.passport_id, 'login_totp_pending', true, req);
    return res.json({ requiresTotp: true, pendingToken });
  }
  const { token } = createSession(user.id, req.headers['user-agent']);
  audit(user.id, user.passport_id, 'login', true, req);
  res.setHeader('Set-Cookie', sessionCookie(req, token));
  res.json({ user: toPublicUser(user, { viewerIsSelf: true }) });
});

router.post('/recover', (req, res) => {
  const b = req.body || {};
  // Shape checks first so a malformed request does not burn a legitimate challenge.
  const keyProblem = splitAuth.splitKeyProblem({ authKey: b.newAuthKey, authSalt: b.newAuthSalt });
  if (keyProblem) return res.status(400).json({ error: keyProblem });
  if (!isValidBackupFor('split', b.backup)) return res.status(400).json({ error: 'invalid passport data' });
  const user = authenticateById(req, res, 'recover');
  if (!user) return;
  const lockKey = lockKeyFor(user.passport_id);
  if (user.is_disabled) {
    audit(user.id, user.passport_id, 'recover', false, req);
    return res.status(403).json({ error: 'account disabled' });
  }
  if (user.totp_enabled && !checkSecondFactor(user, b.code)) {
    challenges.recordFailure(lockKey);
    audit(user.id, user.passport_id, 'recover', false, req);
    return res.status(401).json({ error: 'authenticator code required', requiresTotp: true });
  }
  accounts.inTransaction(() => {
    // Recovery always leaves the account split (a legacy account is converted): the new password was
    // chosen in the browser and never sent. The recover screen tells the user about the Android app.
    splitAuth.setCredential(user.id, { authKey: b.newAuthKey, authSalt: b.newAuthSalt });
    accounts.saveBackup(user.id, b.backup);
    destroyAllSessionsForUser(user.id);
  });
  pendingLogin.removeForUser(user.id);
  hub.disconnectUser(user.id);
  challenges.clearFailures(lockKey);
  const { token } = createSession(user.id, req.headers['user-agent']);
  audit(user.id, user.passport_id, 'recover', true, req);
  res.setHeader('Set-Cookie', sessionCookie(req, token));
  res.json({ user: toPublicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id), { viewerIsSelf: true }) });
});

// For accounts that predate the Passport or were created by a client that does not know about it
// (the native Android app registers through the plain password endpoint). A session alone is not
// enough: binding a Passport grants a recovery path that outlives password changes and session
// revocation, so the current credential (password for legacy accounts, authKey for split ones; and the 2FA code when enabled) must be presented too.
router.post('/attach', requireAuth, (req, res) => {
  const b = req.body || {};
  const lockKey = `attach:${req.user.id}`;
  if (challenges.isLocked(lockKey)) {
    audit(req.user.id, null, 'attach_locked', false, req);
    return res.status(429).json({ error: 'too many attempts, try again later' });
  }
  if (req.user.passport_id) {
    audit(req.user.id, req.user.passport_id, 'attach', false, req);
    return res.status(409).json({ error: 'this account already has a passport' });
  }
  const publicKey = decodePublicKey(b.passportPublicKey);
  const e2eeKey = decodePublicKey(b.e2eePublicKey);
  if (!publicKey || !e2eeKey || !isValidBackupFor(req.user.auth_mode, b.backup)) return res.status(400).json({ error: 'invalid passport data' });
  const passportId = passportIdFromPublicKey(publicKey);
  // Proof first: the nonce is consumed even when the credential turns out wrong.
  const proved = proofOk(req, 'attach', publicKey, b);
  const credentialOk = splitAuth.verifyCurrentCredential(req.user, b);
  // Only after proof and credential checked out, so a bad request never burns a recovery code.
  const secondFactorOk = proved && credentialOk && (!req.user.totp_enabled || checkSecondFactor(req.user, b.code));
  if (!secondFactorOk) {
    challenges.recordFailure(lockKey);
    audit(req.user.id, passportId, 'attach', false, req);
    return res.status(401).json(INVALID);
  }
  try {
    if (db.prepare('SELECT 1 FROM users WHERE passport_id = ?').get(passportId)) {
      throw new Error('UNIQUE constraint failed: users.passport_id');
    }
    accounts.inTransaction(() => {
      db.prepare('UPDATE users SET passport_id = ?, passport_public_key = ?, e2ee_public_key = ? WHERE id = ?')
        .run(passportId, b.passportPublicKey, b.e2eePublicKey, req.user.id);
      accounts.saveBackup(req.user.id, b.backup);
    });
  } catch (err) {
    if (!accounts.isUniqueViolation(err)) throw err;
    audit(req.user.id, passportId, 'attach', false, req);
    return res.status(409).json({ error: 'this passport is already used by another account on this server' });
  }
  challenges.clearFailures(lockKey);
  audit(req.user.id, passportId, 'attach', true, req);
  res.json({ user: toPublicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id), { viewerIsSelf: true }) });
});

module.exports = router;
