'use strict';

const { db } = require('../db');
const totp = require('./totp');
const challenges = require('./passportChallenges');

const lastStep = new Map(); // userId -> newest accepted TOTP step

function useTotpCode(user, code) {
  const step = user.totp_secret ? totp.matchStep(user.totp_secret, code) : null;
  if (step === null || step <= (lastStep.get(user.id) || 0)) return false;
  lastStep.set(user.id, step);
  return true;
}

function useRecoveryCode(user, code) {
  const recoveryCodes = JSON.parse(user.totp_recovery_codes || '[]');
  const idx = recoveryCodes.indexOf(String(code || '').trim().toLowerCase());
  if (idx === -1) return false;
  recoveryCodes.splice(idx, 1);
  db.prepare('UPDATE users SET totp_recovery_codes = ? WHERE id = ?').run(JSON.stringify(recoveryCodes), user.id);
  return true;
}

// A TOTP code (each step usable once), or one of the account's single-use recovery codes (burned on success).
function checkSecondFactor(user, code) {
  return useTotpCode(user, code) || useRecoveryCode(user, code);
}

// 'ok' | 'bad' | 'locked'. TOTP guesses are capped per account AND client address, so someone who
// only knows the password can lock out their own address but never the real owner on another one.
// A recovery code (40 random bits, single use) is honoured even while the address is locked, so the
// owner always has a way in.
function checkSecondFactorLimited(user, code, ip = '') {
  const key = `2fa:${user.id}:${ip}`;
  if (useRecoveryCode(user, code)) {
    challenges.clearFailures(key);
    return 'ok';
  }
  if (challenges.isLocked(key)) return 'locked';
  if (!useTotpCode(user, code)) {
    challenges.recordFailure(key);
    return 'bad';
  }
  challenges.clearFailures(key);
  return 'ok';
}

module.exports = { checkSecondFactor, checkSecondFactorLimited };
