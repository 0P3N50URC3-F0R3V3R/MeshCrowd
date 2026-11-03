'use strict';

const config = require('../../lib/config');
const backup = require('../../lib/backup');

function takeYes(args) {
  return { yes: args.includes('--yes'), rest: args.filter((a) => a !== '--yes') };
}

function needName(args, usage) {
  if (!args[0]) throw new Error(`usage: ${usage}`);
  return args[0];
}

function size(bytes) {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
}

module.exports = function register(registry) {
  registry.register({
    name: 'backup create',
    area: 'backup',
    audit: true,
    summary: 'Create a backup now (database, config, small media)',
    usage: 'backup create',
    examples: ['backup create'],
    async run() {
      const b = await backup.createBackup({ reason: 'manual' });
      const pruned = backup.pruneBackups();
      return `created ${b.name} (${b.files} files, ${size(b.sizeBytes)})${pruned ? `, pruned ${pruned} old` : ''}`;
    },
  });

  registry.register({
    name: 'backup list',
    area: 'backup',
    summary: 'List backups, newest first',
    usage: 'backup list',
    examples: ['backup list'],
    run() {
      const list = backup.listBackups();
      if (!list.length) return 'no backups';
      return list.map((b) => `${b.name}  ${size(b.sizeBytes).padStart(9)}  ${b.reason}`).join('\n');
    },
  });

  registry.register({
    name: 'backup delete',
    area: 'backup',
    audit: true,
    summary: 'Delete a backup',
    usage: 'backup delete <name> [--yes]',
    examples: ['backup delete backup-20261031-120000-000-manual.zip'],
    async run(args, ctx) {
      const { yes, rest } = takeYes(args);
      const name = needName(rest, 'backup delete <name> [--yes]');
      backup.checkName(name);
      if (!yes && !(await ctx.confirm(`Delete ${name}?`))) return 'cancelled';
      backup.deleteBackup(name);
      return `deleted ${name}`;
    },
  });

  registry.register({
    name: 'backup verify',
    area: 'backup',
    summary: 'Check a backup against its manifest hashes',
    usage: 'backup verify <name>',
    examples: ['backup verify backup-20261031-120000-000-manual.zip'],
    async run(args) {
      const name = needName(args, 'backup verify <name>');
      const v = await backup.verifyBackup(name);
      return v.ok ? `${name}: ok` : `${name}: FAILED\n${v.problems.map((p) => `  ${p}`).join('\n')}`;
    },
  });

  registry.register({
    name: 'backup keep',
    area: 'backup',
    audit: true,
    summary: 'Set how many normal backups to keep (1-100) and prune',
    usage: 'backup keep <n>',
    examples: ['backup keep 14'],
    run(args) {
      const n = Number(args[0]);
      if (!/^\d+$/.test(args[0] || '') || n < 1 || n > 100) throw new Error('backup keep must be an integer between 1 and 100');
      config.save({ backup: { keep: n } });
      const pruned = backup.pruneBackups();
      return `keeping the newest ${n} backups${pruned ? `, pruned ${pruned}` : ''}`;
    },
  });

  registry.register({
    name: 'backup auto',
    area: 'backup',
    audit: true,
    summary: 'Schedule a daily backup at HH:MM (server local time), or turn it off',
    usage: 'backup auto <HH:MM|off>',
    examples: ['backup auto 03:30', 'backup auto off'],
    run(args) {
      const v = args[0];
      if (v !== 'off' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v || '')) throw new Error('usage: backup auto <HH:MM|off>');
      config.save({ backup: { schedule: v === 'off' ? '' : v } });
      backup.startScheduler();
      return v === 'off' ? 'automatic backups off' : `automatic backup daily at ${v}`;
    },
  });

  registry.register({
    name: 'backup restore',
    area: 'backup',
    audit: true,
    summary: 'Replace the database, media and config from a backup, then restart the server',
    usage: 'backup restore <name> [--yes]',
    examples: ['backup restore backup-20261031-120000-000-manual.zip'],
    local: true,
    async run(args, ctx) {
      const { yes, rest } = takeYes(args);
      const name = needName(rest, 'backup restore <name> [--yes]');
      if (!yes && !(await ctx.confirm(`Restore ${name}? The server stops, a pre-restore backup is made, then it restarts.`))) return 'cancelled';
      const lifecycle = require('../../lib/lifecycle');
      const { resume } = await lifecycle.stopForRestore();
      try {
        await backup.restoreBackup(name);
      } catch (e) {
        if (!e.liveDbClosed) { resume(); throw e; }
        ctx.writeln(`error: ${e.message}`);
        await lifecycle.shutdown({ restart: true, announce: false });
        return;
      }
      ctx.writeln(`restored ${name}, restarting`);
      await lifecycle.shutdown({ restart: true, announce: false });
    },
  });
};
