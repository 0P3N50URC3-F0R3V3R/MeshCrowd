'use strict';

const { db } = require('../db');
const logger = require('../lib/logger');
const { SITE_PERMISSIONS, hasSite, hasSiteStrict } = require('../lib/permissions');
const { getSitePermissionBits, canUseConsole } = require('../lib/siteAuth');
const { destroyAllSessionsForUser } = require('../lib/session');
const { authAuditConsole } = require('../lib/authAudit');
const hub = require('../socket/hub');

const log = logger.scoped('admin');

function findUser(ref) {
  if (!ref) throw new Error('missing user');
  const column = ref.includes('@') ? 'email' : 'username';
  const user = db.prepare(`SELECT * FROM users WHERE ${column} = ? COLLATE NOCASE AND username != '__webhook__' AND is_bot = 0`).get(ref);
  if (!user) throw new Error(`no such user: ${ref}`);
  return user;
}

function actorId(ctx) {
  return ctx.session.kind === 'ssh' ? ctx.session.userId || null : null;
}

// Same ceiling as assertCanGrant in routes/admin.js; the local console is the host operator and may always.
function canGrant(ctx, permissionBits) {
  if (ctx.session.kind !== 'ssh') return true;
  const mine = ctx.session.userId ? getSitePermissionBits(ctx.session.userId) : 0;
  if ((permissionBits & SITE_PERMISSIONS.MANAGE_CONSOLE) && !hasSiteStrict(mine, SITE_PERMISSIONS.MANAGE_CONSOLE)) return false;
  if (hasSite(mine, SITE_PERMISSIONS.SITE_ADMINISTRATOR)) return true;
  return (permissionBits & ~mine) === 0;
}

function assertCanModify(ctx, target) {
  if (!canGrant(ctx, getSitePermissionBits(target.id))) {
    throw new Error('cannot modify a user with permissions you do not hold');
  }
}

function otherEnabledConsoleUser(excludeId) {
  const rows = db.prepare("SELECT id FROM users WHERE is_disabled = 0 AND is_bot = 0 AND username != '__webhook__' AND id != ?").all(excludeId);
  return rows.some((r) => canUseConsole(r.id));
}

// Over ssh an operator must not be able to lock the console out by accident; the local console is the recovery path
// and stays unrestricted.
function assertNotSelf(ctx, target, verb) {
  if (ctx.session.kind === 'ssh' && target.id === ctx.session.userId) {
    throw new Error(`you cannot ${verb} yourself; use the local console`);
  }
}

function assertNotLastConsole(ctx, target, verb) {
  if (ctx.session.kind !== 'ssh') return;
  if (target.is_disabled || !canUseConsole(target.id) || otherEnabledConsoleUser(target.id)) return;
  throw new Error(`you cannot ${verb} ${target.username}: it is the last enabled account with console access; use the local console`);
}

function assertSafeToRemove(ctx, target, verb) {
  assertNotSelf(ctx, target, verb);
  assertNotLastConsole(ctx, target, verb);
}

function logAdmin(ctx, message) {
  log.info(`${ctx.session.username} ${message}`);
}

function setDisabled(ctx, target, disabled, verb) {
  assertCanModify(ctx, target);
  if (disabled) assertSafeToRemove(ctx, target, verb);
  db.prepare('UPDATE users SET is_disabled = ? WHERE id = ?').run(disabled ? 1 : 0, target.id);
  if (disabled) {
    destroyAllSessionsForUser(target.id);
    hub.disconnectUser(target.id);
  }
  authAuditConsole(target.id, `console_${verb}`, true, actorId(ctx));
  logAdmin(ctx, `${verb} account ${target.username}`);
}

module.exports = { findUser, actorId, canGrant, assertCanModify, assertNotSelf, assertNotLastConsole, assertSafeToRemove, logAdmin, setDisabled, authAuditConsole };
