'use strict';

const { db } = require('../../db');
const guard = require('../../lib/security/guard');
const { parseEntry } = require('../../lib/security/ipMatch');
const hub = require('../../socket/hub');
const { findUser, actorId, assertCanModify, logAdmin, setDisabled } = require('../userOps');

function parseMinutes(text) {
  if (text === undefined) return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid minutes: ${text}`);
  return Math.ceil(n);
}

module.exports = function register(registry) {
  registry.register({
    name: 'kick',
    area: 'moderation',
    summary: 'Disconnect a user\'s live connections (the account stays enabled)',
    usage: 'kick <user>',
    examples: ['kick alice'],
    run(args, ctx) {
      const target = findUser(args[0]);
      assertCanModify(ctx, target);
      hub.disconnectUser(target.id, 4000, 'kicked by an administrator');
      logAdmin(ctx, `kicked ${target.username}`);
      return `kicked ${target.username}`;
    },
  });

  registry.register({
    name: 'ban',
    area: 'moderation',
    summary: 'Disable an account and end its sessions',
    usage: 'ban <user> [reason] [--yes]',
    examples: ['ban alice spamming', 'ban alice --yes'],
    async run(rawArgs, ctx) {
      const yes = rawArgs.includes('--yes');
      const args = rawArgs.filter((a) => a !== '--yes');
      const target = findUser(args[0]);
      assertCanModify(ctx, target);
      if (!yes && !(await ctx.confirm(`Ban account ${target.username}?`))) return 'cancelled';
      setDisabled(ctx, target, true, 'ban');
      logAdmin(ctx, `ban reason for ${target.username}: ${args.slice(1).join(' ') || '(none)'}`);
      return `banned ${target.username}`;
    },
  });

  registry.register({
    name: 'unban',
    area: 'moderation',
    summary: 'Re-enable a banned account',
    usage: 'unban <user>',
    examples: ['unban alice'],
    run(args, ctx) {
      const target = findUser(args[0]);
      setDisabled(ctx, target, false, 'unban');
      return `unbanned ${target.username}`;
    },
  });

  registry.register({
    name: 'ipban',
    area: 'moderation',
    summary: 'Ban an IP, range or CIDR, optionally for a number of minutes',
    usage: 'ipban <ip|cidr> [minutes] [reason]',
    examples: ['ipban 10.0.0.0/24 5 scanning', 'ipban 192.0.2.7'],
    run(args, ctx) {
      if (!args[0]) throw new Error('usage: ipban <ip|cidr> [minutes] [reason]');
      const minutes = parseMinutes(args[1]);
      const ban = guard.addBan(args[0], { reason: args.slice(2).join(' '), minutes, userId: actorId(ctx) });
      logAdmin(ctx, `ipban ${ban.entry}${minutes ? ` for ${minutes} min` : ''}`);
      return `banned ${ban.entry}${ban.expires_at ? ` until ${ban.expires_at}` : ' permanently'}`;
    },
  });

  registry.register({
    name: 'ipunban',
    area: 'moderation',
    summary: 'Remove an IP ban',
    usage: 'ipunban <ip|cidr>',
    examples: ['ipunban 10.0.0.0/24'],
    run(args, ctx) {
      const parsed = parseEntry(args[0]);
      const ban = parsed && db.prepare('SELECT id, entry FROM ip_bans WHERE entry = ?').get(parsed.entry);
      if (!ban) throw new Error(`no such ban: ${args[0] || ''}`);
      guard.removeBan(ban.id);
      logAdmin(ctx, `ipunban ${ban.entry}`);
      return `removed ban ${ban.entry}`;
    },
  });

  registry.register({
    name: 'ipbans',
    area: 'moderation',
    summary: 'List IP bans',
    usage: 'ipbans',
    run() {
      guard.sweepExpired();
      const rows = db.prepare('SELECT entry, reason, source, expires_at FROM ip_bans ORDER BY id').all();
      if (!rows.length) return 'no IP bans';
      return rows.map((b) => `${b.entry}  ${b.source}  ${b.expires_at ? `until ${b.expires_at}` : 'permanent'}${b.reason ? `  ${b.reason}` : ''}`).join('\n');
    },
  });
};
