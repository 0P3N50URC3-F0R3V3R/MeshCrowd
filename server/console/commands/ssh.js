'use strict';

const config = require('../../lib/config');
const { current } = require('../ssh');
const { logAdmin } = require('../userOps');

function since(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

module.exports = function register(registry) {
  registry.register({
    name: 'ssh status',
    area: 'ssh',
    local: true,
    summary: 'Show the ssh console: host key fingerprint, listen address and active sessions',
    usage: 'ssh status',
    examples: ['ssh status'],
    run(args, ctx) {
      const srv = current();
      if (!srv) return `ssh console is not running (ssh.enabled is ${config.load().ssh.enabled ? 'true but it failed to start, see the log' : 'false'})`;
      ctx.writeln(`listening: ${srv.listenAddress}:${srv.port}`);
      ctx.writeln(`host key:  ${srv.fingerprint}`);
      const list = srv.sessions();
      if (!list.length) return 'no active sessions';
      ctx.writeln('sessions:');
      for (const s of list) ctx.writeln(`  #${s.id}  ${s.username}  ${s.ip}  ${since(s.since)} ago`);
    },
  });

  registry.register({
    name: 'ssh kick',
    area: 'ssh',
    audit: true,
    local: true,
    summary: 'Disconnect an ssh session by its number from ssh status',
    usage: 'ssh kick <n>',
    examples: ['ssh kick 1'],
    run(args, ctx) {
      if (args.length !== 1 || !/^\d+$/.test(args[0])) throw new Error('usage: ssh kick <n>');
      const srv = current();
      if (!srv || !srv.kick(args[0])) throw new Error(`no such ssh session: ${args[0]}`);
      logAdmin(ctx, `kicked ssh session ${args[0]}`);
      return `session ${args[0]} disconnected`;
    },
  });
};
