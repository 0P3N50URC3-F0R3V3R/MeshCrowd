'use strict';

const { db } = require('../db');

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

// Server verification levels: how established an account must be before it may post.
// Everything here is local (account and membership age); there is no outside check.
const LEVELS = {
  0: { accountMs: 0, memberMs: 0 },
  1: { accountMs: 5 * MIN, memberMs: 0 },
  2: { accountMs: 5 * MIN, memberMs: 10 * MIN },
  3: { accountMs: 7 * DAY, memberMs: 10 * MIN },
};

const isLevel = (n) => Number.isInteger(n) && Object.hasOwn(LEVELS, n);

const age = (iso) => Date.now() - new Date(iso).getTime();

function humanWait(ms) {
  const m = Math.ceil(ms / MIN);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.ceil(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'}`;
  const d = Math.ceil(h / 24);
  return `${d} day${d === 1 ? '' : 's'}`;
}

// null when the user may post, otherwise { status, body } for the response.
function verificationBlock(serverId, userId) {
  const server = db.prepare('SELECT verification_level, owner_id FROM servers WHERE id = ?').get(serverId);
  if (!server || !server.verification_level) return null;
  if (server.owner_id === userId) return null;
  const u = db.prepare('SELECT created_at, is_bot FROM users WHERE id = ?').get(userId);
  if (!u || u.is_bot) return null;
  // Anyone holding a role besides @everyone has been vetted by a moderator.
  if (db.prepare('SELECT 1 FROM member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.server_id = ? AND mr.user_id = ? AND r.is_default = 0').get(serverId, userId)) return null;
  const rule = LEVELS[server.verification_level];
  const member = db.prepare('SELECT joined_at FROM server_members WHERE server_id = ? AND user_id = ?').get(serverId, userId);
  const accountWait = rule.accountMs - age(u.created_at);
  const memberWait = member ? rule.memberMs - age(member.joined_at) : 0;
  const wait = Math.max(accountWait, memberWait);
  if (wait <= 0) return null;
  const reason = accountWait >= memberWait ? 'your account is too new for this server' : 'you joined this server too recently';
  return {
    status: 403,
    body: { error: `This server requires verification: ${reason}. Try again in ${humanWait(wait)}.`, code: 'verification', retryAfterMs: Math.ceil(wait) },
  };
}

module.exports = { LEVELS, isLevel, verificationBlock };
