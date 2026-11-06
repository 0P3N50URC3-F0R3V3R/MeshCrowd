'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../../lib/config');
const backup = require('../../lib/backup');
const logger = require('../../lib/logger');

const log = logger.scoped('purge');

const MEDIA_DIRS = ['avatars', 'attachments', 'servericons', 'channelicons', 'foldericons', 'banners', 'cards', 'emoji', 'stickers', 'sounds', 'webhookicons', 'threadicons', 'roleicons', 'notefiles', 'sites'];

function sameSecret(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

module.exports = function register(registry) {
  registry.register({
    name: 'purge',
    area: 'server',
    audit: true,
    local: true,
    summary: 'Reset the whole server to a factory state (all accounts, servers, messages and media), then restart',
    usage: 'purge',
    examples: ['purge'],
    async run(args, ctx) {
      const expected = config.load().purgePassword;
      if (!expected) throw new Error('purge is disabled: set "purgePassword" in data/config.json (or `config set purgePassword <value>`) and try again');
      const given = await ctx.ask('Wipe password:', { secret: true });
      if (!sameSecret(given, expected)) {
        log.warn(`${ctx.session.username} gave a wrong purge password`);
        throw new Error('wrong wipe password');
      }
      ctx.writeln('This deletes ALL accounts, servers, channels, messages, DMs and uploaded files. config.json, certificates and backups are kept.');
      if ((await ctx.ask('Type PURGE to continue:')).trim() !== 'PURGE') return 'cancelled';

      const lifecycle = require('../../lib/lifecycle');
      const { resume } = await lifecycle.stopForRestore();
      const dataDir = config.CONFIG_PATH ? path.dirname(config.CONFIG_PATH) : null;
      try {
        await backup.createBackup({ reason: 'pre-restore' });
        require('../../db').db.close();
      } catch (e) {
        resume();
        throw e;
      }
      const dbFile = path.join(dataDir, 'dismesh.db');
      for (const sfx of ['', '-wal', '-shm']) fs.rmSync(dbFile + sfx, { force: true });
      for (const dir of MEDIA_DIRS) fs.rmSync(path.join(dataDir, dir), { recursive: true, force: true });
      log.warn(`${ctx.session.username} purged the server to a factory state`);
      ctx.writeln('server purged, restarting');
      await lifecycle.shutdown({ restart: true, announce: false });
    },
  });
};
