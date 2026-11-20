'use strict';

const { db } = require('../db');
const challenges = require('./passportChallenges');

const IP_MAX_FAILURES = 5;
const ACCOUNT_MAX_FAILURES = 20;
const LOCKOUT_MS = 15 * 60_000;

// Failed password guesses are counted per account + client IP, so guessing from one address locks that
// address only and can never lock the owner out. Across all addresses a soft cap applies: once it trips,
// only IPs that already hold a session of the account may still try. Unknown names are counted the same
// way, so nothing here tells an existing account from a missing one.
function keys(user, identifier, ip) {
  const subject = user ? `u${user.id}` : `n${String(identifier).toLowerCase()}`;
  return { ip: `login-ip:${subject}:${ip}`, account: `login-acct:${subject}` };
}

const knownIp = (user, ip) => !!user && !!db.prepare('SELECT 1 FROM sessions WHERE user_id = ? AND ip = ? LIMIT 1').get(user.id, ip || '');

function isBlocked(user, identifier, ip) {
  const k = keys(user, identifier, ip);
  if (challenges.isLocked(k.ip)) return true;
  return challenges.isLocked(k.account) && !knownIp(user, ip);
}

function recordFailure(user, identifier, ip) {
  const k = keys(user, identifier, ip);
  challenges.recordFailure(k.ip, IP_MAX_FAILURES, LOCKOUT_MS);
  challenges.recordFailure(k.account, ACCOUNT_MAX_FAILURES, LOCKOUT_MS);
}

function recordSuccess(user, identifier, ip) {
  challenges.clearFailures(keys(user, identifier, ip).ip);
}

module.exports = { isBlocked, recordFailure, recordSuccess, IP_MAX_FAILURES, ACCOUNT_MAX_FAILURES };
