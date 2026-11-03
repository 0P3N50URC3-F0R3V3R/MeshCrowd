'use strict';

const { db } = require('../../db');
const accounts = require('../../lib/accounts');
const splitAuth = require('../../lib/splitAuth');
const pendingLogin = require('../../lib/pendingLogin');
const { destroyAllSessionsForUser } = require('../../lib/session');
const { getSitePermissionBits, canUseConsole } = require('../../lib/siteAuth');
const { SITE_PERMISSIONS, hasSiteStrict } = require('../../lib/permissions');
const presence = require('../../lib/presence');
const hub = require('../../socket/hub');
const {
  findUser, actorId, canGrant, assertCanModify, assertSafeToRemove, assertNotLastConsole, logAdmin, setDisabled, authAuditConsole,
} = require('../userOps');

const PERMISSION_NAMES = Object.entries(SITE_PERMISSIONS);

function findRole(ref) {
  if (!ref) throw new Error('missing role');
  const role = /^\d+$/.test(ref)
    ? db.prepare('SELECT * FROM site_roles WHERE id = ?').get(Number(ref))
    : db.prepare('SELECT * FROM site_roles WHERE name = ? COLLATE NOCASE').get(ref);
  if (!role) throw new Error(`no such role: ${ref}`);
  return role;
}

function permissionList(bits) {
  return PERMISSION_NAMES.filter(([, v]) => bits & v).map(([k]) => k).join(', ') || 'none';
}

async function passwordFor(given, ctx, prompt) {
  const password = given !== undefined ? given : await ctx.ask(prompt, { secret: true });
  const problem = splitAuth.credentialProblem({ password });
  if (problem) throw new Error(problem);
  return password;
}

module.exports = function register(registry) {
  registry.register({
    name: 'account list',
    area: 'account',
    summary: 'List accounts, optionally filtered by username or email',
    usage: 'account list [filter]',
    examples: ['account list', 'account list ali'],
    run(args) {
      const like = `%${(args[0] || '').replace(/[\\%_]/g, '\\$&')}%`;
      const rows = db.prepare(
        `SELECT id, username, email, is_disabled FROM users
          WHERE username != '__webhook__' AND is_bot = 0 AND (username LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\')
          ORDER BY id LIMIT 200`,
      ).all(like, like);
      if (!rows.length) return 'no matching accounts';
      return rows.map((u) => `${String(u.id).padStart(4)}  ${u.username}  ${u.email}${u.is_disabled ? '  [disabled]' : ''}`).join('\n');
    },
  });

  registry.register({
    name: 'account info',
    area: 'account',
    summary: 'Show details of an account',
    usage: 'account info <user>',
    examples: ['account info alice'],
    run(args) {
      const u = findUser(args[0]);
      const roles = db.prepare(
        'SELECT sr.name FROM user_site_roles usr JOIN site_roles sr ON sr.id = usr.role_id WHERE usr.user_id = ? ORDER BY sr.position DESC',
      ).all(u.id).map((r) => r.name);
      const sessions = db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE user_id = ?').get(u.id).c;
      return [
        `id:        ${u.id}`,
        `username:  ${u.username}`,
        `display:   ${u.display_name}`,
        `email:     ${u.email}`,
        `sign-in:   ${u.auth_mode || 'password'}`,
        `disabled:  ${u.is_disabled ? 'yes' : 'no'}`,
        `online:    ${presence.isOnline(u.id) ? 'yes' : 'no'}`,
        `sessions:  ${sessions}`,
        `created:   ${u.created_at}`,
        `roles:     ${roles.join(', ') || 'none'}`,
        `perms:     ${permissionList(getSitePermissionBits(u.id))}`,
      ].join('\n');
    },
  });

  registry.register({
    name: 'account create',
    area: 'account',
    audit: true,
    summary: 'Create a password-mode account (prompts for the password when omitted)',
    usage: 'account create <username> <email> [password]',
    examples: ['account create alice alice@example.com'],
    secretArgs: true,
    async run(args, ctx) {
      const [username, email, given] = args;
      if (!username || !email) throw new Error('usage: account create <username> <email> [password]');
      const problem = accounts.validateNewAccount({ username, email, password: 'placeholder-ok' });
      if (problem) throw new Error(problem);
      if (accounts.findConflict({ username, email })) throw new Error('username or email already exists');
      const password = await passwordFor(given, ctx, 'Password (min 8 chars): ');
      const { userId, autoJoinServers } = accounts.createAccount({ username, email, password });
      accounts.announceJoins(userId, autoJoinServers);
      authAuditConsole(userId, 'console_create', true, actorId(ctx));
      logAdmin(ctx, `created account ${username}`);
      return `created account ${username} (id ${userId})`;
    },
  });

  registry.register({
    name: 'account passwd',
    area: 'account',
    audit: true,
    summary: 'Reset an account password; ends its sessions and live connections',
    usage: 'account passwd <user> [password]',
    examples: ['account passwd alice'],
    secretArgs: true,
    async run(args, ctx) {
      const target = findUser(args[0]);
      assertCanModify(ctx, target);
      if (target.auth_mode === 'split') {
        throw new Error('this account uses strengthened sign-in; its password cannot be set from the server');
      }
      const password = await passwordFor(args[1], ctx, `New password for ${target.username}: `);
      accounts.inTransaction(() => {
        splitAuth.setCredential(target.id, { password });
        destroyAllSessionsForUser(target.id);
      });
      pendingLogin.removeForUser(target.id);
      hub.disconnectUser(target.id);
      authAuditConsole(target.id, 'console_reset', true, actorId(ctx));
      logAdmin(ctx, `reset password of ${target.username}`);
      return `password reset for ${target.username}; sessions ended`;
    },
  });

  registry.register({
    name: 'account delete',
    area: 'account',
    audit: true,
    summary: 'Permanently delete an account',
    usage: 'account delete <user> [--yes]',
    examples: ['account delete alice', 'account delete alice --yes'],
    async run(args, ctx) {
      const yes = args.includes('--yes');
      const target = findUser(args.filter((a) => a !== '--yes')[0]);
      assertCanModify(ctx, target);
      assertSafeToRemove(ctx, target, 'delete');
      if (!yes && !(await ctx.confirm(`Permanently delete account ${target.username}?`))) return 'cancelled';
      try {
        db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
      } catch (e) {
        if (!/FOREIGN KEY/i.test(String(e && e.message))) throw e;
        authAuditConsole(target.id, 'console_delete', false, actorId(ctx));
        throw new Error(`${target.username} owns servers or has content and cannot be deleted; use \`ban ${target.username}\` instead`);
      }
      destroyAllSessionsForUser(target.id);
      hub.disconnectUser(target.id);
      authAuditConsole(null, 'console_delete', true, actorId(ctx));
      logAdmin(ctx, `deleted account ${target.username} (id ${target.id})`);
      return `deleted account ${target.username}`;
    },
  });

  registry.register({
    name: 'account disable',
    area: 'account',
    audit: true,
    summary: 'Disable an account and end its sessions',
    usage: 'account disable <user>',
    examples: ['account disable alice'],
    run(args, ctx) {
      const target = findUser(args[0]);
      setDisabled(ctx, target, true, 'disable');
      return `disabled ${target.username}`;
    },
  });

  registry.register({
    name: 'account enable',
    area: 'account',
    audit: true,
    summary: 'Re-enable a disabled account',
    usage: 'account enable <user>',
    examples: ['account enable alice'],
    run(args, ctx) {
      const target = findUser(args[0]);
      setDisabled(ctx, target, false, 'enable');
      return `enabled ${target.username}`;
    },
  });

  registry.register({
    name: 'account roles',
    area: 'account',
    summary: 'List site roles',
    usage: 'account roles',
    run() {
      const rows = db.prepare('SELECT id, name, permissions FROM site_roles ORDER BY position DESC').all();
      if (!rows.length) return 'no site roles';
      return rows.map((r) => `${String(r.id).padStart(3)}  ${r.name}  ${permissionList(r.permissions)}`).join('\n');
    },
  });

  for (const grant of [true, false]) {
    const verb = grant ? 'setrole' : 'unsetrole';
    registry.register({
      name: `account ${verb}`,
      aliases: [grant ? 'account grant' : 'account revoke'],
      area: 'account',
      audit: true,
      summary: grant ? 'Give an account a site role' : 'Remove a site role from an account',
      usage: `account ${verb} <user> <role>`,
      examples: [`account ${verb} alice Moderator`],
      run(args, ctx) {
        const target = findUser(args[0]);
        const role = findRole(args[1]);
        if (!canGrant(ctx, role.permissions)) {
          throw new Error('cannot change a role with permissions you do not hold');
        }
        assertCanModify(ctx, target);
        if (!grant && (role.permissions & SITE_PERMISSIONS.MANAGE_CONSOLE) && canUseConsole(target.id)) {
          const left = db.prepare(
            'SELECT sr.permissions FROM user_site_roles usr JOIN site_roles sr ON sr.id = usr.role_id WHERE usr.user_id = ? AND usr.role_id != ?',
          ).all(target.id, role.id).reduce((acc, r) => acc | r.permissions, 0);
          if (!hasSiteStrict(left, SITE_PERMISSIONS.MANAGE_CONSOLE)) {
            if (ctx.session.kind === 'ssh' && target.id === ctx.session.userId) {
              throw new Error('you cannot remove your own console permission; use the local console');
            }
            assertNotLastConsole(ctx, target, 'remove the console permission from');
          }
        }
        if (grant) db.prepare('INSERT OR IGNORE INTO user_site_roles (user_id, role_id) VALUES (?, ?)').run(target.id, role.id);
        else db.prepare('DELETE FROM user_site_roles WHERE user_id = ? AND role_id = ?').run(target.id, role.id);
        authAuditConsole(target.id, `console_${verb}`, true, actorId(ctx));
        logAdmin(ctx, `${verb} role ${role.name} on ${target.username}`);
        return `${grant ? 'granted' : 'removed'} ${role.name} ${grant ? 'to' : 'from'} ${target.username}`;
      },
    });
  }

  // Recovery path: the web admin panel and ssh cannot hand out MANAGE_CONSOLE to someone who lacks it, so on an
  // install where nobody holds it the host operator (local window only) must be able to add or remove it.
  registry.register({
    name: 'account roleperm',
    area: 'account',
    audit: true,
    local: true,
    summary: 'Add or remove the console permission (MANAGE_CONSOLE) on a site role; local window only',
    usage: 'account roleperm <role> +console|-console [--yes]',
    examples: ['account roleperm Owner +console'],
    async run(args, ctx) {
      const yes = args.includes('--yes');
      const [ref, change, extra] = args.filter((a) => a !== '--yes');
      if (!ref || !['+console', '-console'].includes(change) || extra !== undefined) {
        throw new Error('usage: account roleperm <role> +console|-console [--yes]');
      }
      const role = findRole(ref);
      const add = change === '+console';
      const verb = add ? 'Give' : 'Remove';
      if (!yes && !(await ctx.confirm(`${verb} the console permission ${add ? 'to' : 'from'} role ${role.name}?`))) return 'cancelled';
      const bits = add ? role.permissions | SITE_PERMISSIONS.MANAGE_CONSOLE : role.permissions & ~SITE_PERMISSIONS.MANAGE_CONSOLE;
      db.prepare('UPDATE site_roles SET permissions = ? WHERE id = ?').run(bits, role.id);
      logAdmin(ctx, `${add ? 'added' : 'removed'} MANAGE_CONSOLE ${add ? 'to' : 'from'} role ${role.name} (id ${role.id})`);
      return `${add ? 'added' : 'removed'} the console permission ${add ? 'to' : 'from'} ${role.name}`;
    },
  });
};
