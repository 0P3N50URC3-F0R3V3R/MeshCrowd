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
// A limited invite (an extra server invite or a channel invite) is not just checked: it comes back
// as `invite` so account creation can consume one use and join the new account in the same
// transaction. The server's permanent code and vanity name have no use counter.
function admit(inviteCode) {
  const mode = getMode();
  if (mode === 'open' || !hasUsers()) return { blocked: null, invite: null };
  if (mode === 'closed') return { blocked: { status: 403, error: 'registration is closed' } };
  const code = typeof inviteCode === 'string' ? inviteCode.trim() : '';
  if (!code || code.includes('@')) return { blocked: { status: 403, error: 'registration requires an invite link' } };
  const peek = invites.peekCode(code);
  if (!peek || peek.dead) return { blocked: { status: 403, error: 'invalid or expired invite code' } };
  return { blocked: null, invite: peek.invite ? { kind: peek.kind, row: peek.invite, server: peek.server, channel: peek.channel || null } : null };
}

function check(inviteCode) {
  return admit(inviteCode).blocked;
}

module.exports = { MODES, getMode, check, admit };
