'use strict';

const { db } = require('../db');
const totp = require('./totp');

// A TOTP code, or one of the account's single-use recovery codes (burned on success).
function checkSecondFactor(user, code) {
  if (totp.verifyToken(user.totp_secret, code)) return true;
  const recoveryCodes = JSON.parse(user.totp_recovery_codes || '[]');
  const idx = recoveryCodes.indexOf(String(code || '').trim().toLowerCase());
  if (idx === -1) return false;
  recoveryCodes.splice(idx, 1);
  db.prepare('UPDATE users SET totp_recovery_codes = ? WHERE id = ?').run(JSON.stringify(recoveryCodes), user.id);
  return true;
}

module.exports = { checkSecondFactor };
