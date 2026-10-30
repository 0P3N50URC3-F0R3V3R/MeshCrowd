'use strict';

const { db } = require('../db');
const { load } = require('./config');
const invites = require('./serverInvites');

const MODES = ['open', 'closed', 'invite'];

function getMode() {
  const mode = load().registrationMode;
  return MODES.includes(mode) ? mode : 'open';
}

// The first account becomes the site owner (accounts.createAccountRows), so a fresh instance must
// stay signable whatever the mode says.
function hasUsers() {
  return db.prepare("SELECT COUNT(*) AS c FROM users WHERE username != '__webhook__' AND is_bot = 0").get().c > 0;
}

// null = may register; otherwise { status, error } for the response. In 'invite' mode the body must
// carry a live invite code of this instance (server invite, vanity code or channel invite).
function check(inviteCode) {
  const mode = getMode();
  if (mode === 'open' || !hasUsers()) return null;
  if (mode === 'closed') return { status: 403, error: 'registration is closed' };
  const code = typeof inviteCode === 'string' ? inviteCode.trim() : '';
  if (!code || code.includes('@')) return { status: 403, error: 'registration requires an invite link' };
  const peek = invites.peekCode(code);
  if (!peek || peek.dead) return { status: 403, error: 'invalid or expired invite code' };
  return null;
}

module.exports = { MODES, getMode, check };
