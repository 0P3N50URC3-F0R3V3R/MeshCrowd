'use strict';

const { db } = require('../../db');
const config = require('../../lib/config');
const logger = require('../../lib/logger');
const presence = require('../../lib/presence');
const lifecycle = require('../../lib/lifecycle');
const metrics = require('../../lib/metrics');
const backup = require('../../lib/backup');
const hub = require('../../socket/hub');
const { version } = require('../../../package.json');
const { logAdmin } = require('../userOps');

const CLEAR = '\x1b[H\x1b[2J';

function takeYes(args) {
  return { yes: args.includes('--yes'), rest: args.filter((a) => a !== '--yes') };
}

function duration(totalSeconds) {
  const s = Math.floor(totalSeconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${d ? `${d}d ` : ''}${d || h ? `${h}h ` : ''}${m}m ${s % 60}s`;
}

function table(rows) {
  const width = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `${k.padEnd(width)}  ${v}`).join('\n');
}

function parseSeconds(text, usage, min) {
  if (text === undefined) return null;
  const n = Number(text);
  if (!/^\d+(\.\d+)?$/.test(text) || n < min || n > 86400) throw new Error(`usage: ${usage}`);
  return n;
}

function lifecycleCommand(restart) {
  const verb = restart ? 'restart' : 'stop';
  const usage = `server ${verb} [seconds] [--yes]`;
  return {
    name: `server ${verb}`,
    area: 'server',
    summary: restart ? 'Restart the server (needs the supervisor: npm start or start-server)' : 'Stop the server',
    usage,
    examples: [`server ${verb}`, `server ${verb} 60`, `server ${verb} --yes`],
    async run(args, ctx) {
      const { yes, rest } = takeYes(args);
      const delaySeconds = parseSeconds(rest[0], usage, 0) || 0;
      if (lifecycle.pending()) throw new Error('a stop or restart is already scheduled, use server cancel first');
      const when = delaySeconds > 0 ? `in ${delaySeconds} seconds` : 'now';
      if (!yes && !(await ctx.confirm(`${restart ? 'Restart' : 'Stop'} the server ${when}?`))) return 'cancelled';
      logAdmin(ctx, `requested server ${verb} ${when}`);
      ctx.writeln(`${restart ? 'restarting' : 'stopping'} ${when}${delaySeconds > 0 ? ' (server cancel to abort)' : ''}`);
      if (restart && process.env.MESHCROWD_SUPERVISED !== '1') {
        ctx.writeln('note: not running under the supervisor, the server will stop and not come back');
      }
      lifecycle.shutdown({ restart, delaySeconds, announce: true }).catch((err) => logger.error('[lifecycle]', err));
    },
  };
}

function statsText() {
  const s = metrics.snapshot();
  return table([
    ['cpu', `${s.cpuPercent}%`],
    ['load avg', s.loadAvg.join(' ')],
    ['memory', `rss ${s.memory.rssMb} MB, heap ${s.memory.heapUsedMb}/${s.memory.heapTotalMb} MB, system free ${s.memory.systemFreeMb}/${s.memory.systemTotalMb} MB`],
    ['event loop lag', `${s.eventLoopLagMs} ms`],
    ['uptime', duration(s.uptimeSeconds)],
    ['online', `${s.online.users} users, ${s.online.connections} connections`],
    ['requests/min', `${s.http.requestsPerMinute} (5xx: ${s.http.errors5xxPerMinute})`],
    ['db', `${s.db.sizeMb} MB, wal ${s.db.walSizeMb} MB`],
    ['turn allocations', s.turn.allocations],
    ['warn/error (1h)', `${s.logs.warnLastHour} / ${s.logs.errorLastHour}`],
  ]);
}

function watchStats(usage) {
  return async function run(args, ctx) {
    const seconds = parseSeconds(args[0], usage, 0.1) || 2;
    if (typeof ctx.onInterrupt !== 'function') return statsText();
    let done = false;
    let wake = null;
    const off = ctx.onInterrupt(() => { done = true; if (wake) wake(); });
    try {
      while (!done) {
        ctx.write(CLEAR);
        ctx.writeln(statsText());
        ctx.writeln('');
        ctx.writeln(`refreshing every ${seconds}s, q or Ctrl+C to stop`);
        let timer;
        await new Promise((resolve) => { wake = resolve; timer = setTimeout(resolve, seconds * 1000); });
        clearTimeout(timer);
        wake = null;
      }
    } finally {
      off();
    }
  };
}

function lastBackup() {
  try {
    const b = backup.listBackups()[0];
    return b ? `${b.createdAt} (${b.reason})` : 'none';
  } catch {
    return 'unknown';
  }
}

module.exports = function register(registry) {
  registry.register(lifecycleCommand(false));
  registry.register(lifecycleCommand(true));

  registry.register({
    name: 'server cancel',
    area: 'server',
    summary: 'Abort a pending stop or restart countdown',
    usage: 'server cancel',
    examples: ['server cancel'],
    run(args, ctx) {
      if (!lifecycle.cancel()) return 'nothing scheduled';
      logAdmin(ctx, 'cancelled the scheduled server stop');
      return 'cancelled';
    },
  });

  registry.register({
    name: 'status',
    area: 'server',
    summary: 'Show version, uptime, memory, online users, ports and feature state',
    usage: 'status',
    examples: ['status'],
    run() {
      const cfg = config.load();
      const m = metrics.snapshot();
      const ports = [cfg.useHttps ? `https ${cfg.httpsPort}, http redirect ${cfg.port}` : `http ${cfg.port}`];
      if (cfg.turn && cfg.turn.enabled) ports.push(`turn ${cfg.turn.port}`);
      if (cfg.ssh && cfg.ssh.enabled) ports.push(`ssh ${cfg.ssh.port}`);
      const turn = require('../../lib/turn/manager').status();
      return table([
        ['version', version],
        ['uptime', duration(process.uptime())],
        ['memory', `rss ${m.memory.rssMb} MB`],
        ['online', `${m.online.users} users, ${m.online.connections} connections`],
        ['ports', ports.join(', ')],
        ['ssh', cfg.ssh && cfg.ssh.enabled ? `enabled on ${cfg.ssh.listenAddress}:${cfg.ssh.port}` : 'disabled'],
        ['turn', !turn.enabled ? 'disabled' : turn.running ? `running, ${turn.allocations} allocations` : `not running${turn.error ? ` (${turn.error})` : ''}`],
        ['federation', cfg.federation && cfg.federation.enabled ? 'enabled' : 'disabled'],
        ['log level', logger.getLevel()],
        ['last backup', lastBackup()],
        ['supervisor', process.env.MESHCROWD_SUPERVISED === '1' ? 'yes' : 'no'],
      ]);
    },
  });

  registry.register({
    name: 'announce',
    area: 'server',
    summary: 'Show a notice to every online user',
    usage: 'announce <text>',
    examples: ['announce "Maintenance in 10 minutes"'],
    run(args, ctx) {
      const text = args.join(' ').trim();
      if (!text) throw new Error('usage: announce <text>');
      const n = hub.broadcastAll({ type: 'server_notice', kind: 'announce', text });
      logAdmin(ctx, `announced: ${text}`);
      return `sent to ${n} online user${n === 1 ? '' : 's'}`;
    },
  });

  registry.register({
    name: 'list',
    area: 'server',
    summary: 'List online users (optionally filtered by a substring)',
    usage: 'list [filter]',
    examples: ['list', 'list ali'],
    run(args) {
      const filter = (args[0] || '').toLowerCase();
      const roleStmt = db.prepare('SELECT sr.name FROM user_site_roles usr JOIN site_roles sr ON sr.id = usr.role_id WHERE usr.user_id = ? ORDER BY sr.name');
      const userStmt = db.prepare('SELECT id, username, display_name FROM users WHERE id = ?');
      const rows = [];
      for (const id of presence.onlineUserIds()) {
        const u = userStmt.get(id);
        if (!u) continue;
        if (filter && !u.username.toLowerCase().includes(filter) && !(u.display_name || '').toLowerCase().includes(filter)) continue;
        rows.push({ id: u.id, username: u.username, name: u.display_name || '', conns: presence.connectionCount(id), roles: roleStmt.all(id).map((r) => r.name).join(', ') });
      }
      rows.sort((a, b) => a.username.localeCompare(b.username));
      const conns = rows.reduce((n, r) => n + r.conns, 0);
      const total = `${rows.length} user${rows.length === 1 ? '' : 's'} online, ${conns} connection${conns === 1 ? '' : 's'}`;
      if (!rows.length) return total;
      const w = (key) => Math.max(...rows.map((r) => String(r[key]).length));
      const lines = rows.map((r) => `${String(r.id).padStart(w('id'))}  ${r.username.padEnd(w('username'))}  ${r.name.padEnd(w('name'))}  ${String(r.conns).padStart(2)}  ${r.roles}`.trimEnd());
      return [...lines, total].join('\n');
    },
  });

  registry.register({
    name: 'stats',
    area: 'server',
    summary: 'Show CPU, memory, event loop, request, database and log statistics',
    usage: 'stats',
    examples: ['stats'],
    run() { return statsText(); },
  });

  registry.register({
    name: 'stats watch',
    area: 'server',
    summary: 'Refresh stats in place until q or Ctrl+C',
    usage: 'stats watch [seconds]',
    examples: ['stats watch', 'stats watch 5'],
    run: watchStats('stats watch [seconds]'),
  });
};
