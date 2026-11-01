'use strict';

const config = require('../../lib/config');
const logger = require('../../lib/logger');
const { createLogFeed, formatEntry } = require('../logFeed');
const { logAdmin } = require('../userOps');

const LEVELS = ['debug', 'info', 'warn', 'error'];

function kb(bytes) {
  return bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
}

// Stop channel for log tail: ctx.onInterrupt (q or Ctrl+C in a terminal) or, in a plain ctx, ctx.signal (AbortSignal).
function waitForStop(ctx) {
  return new Promise((resolve) => {
    let off = null;
    const done = () => { if (off) off(); resolve(); };
    if (typeof ctx.onInterrupt === 'function') {
      off = ctx.onInterrupt(done);
    } else {
      if (ctx.signal.aborted) return done();
      ctx.signal.addEventListener('abort', done, { once: true });
      off = () => ctx.signal.removeEventListener('abort', done);
    }
  });
}

module.exports = function register(registry) {
  registry.register({
    name: 'log tail',
    area: 'log',
    summary: 'Stream the live log until q or Ctrl+C (the server window always streams it)',
    usage: 'log tail [level]',
    examples: ['log tail', 'log tail warn'],
    async run(args, ctx) {
      if (args.length > 1 || (args[0] && !LEVELS.includes(args[0]))) throw new Error(`usage: log tail [${LEVELS.join('|')}]`);
      if (ctx.liveLog) return `the live log is already shown in this window at level ${logger.getLevel()} (log level <level> changes it)`;
      if (typeof ctx.onInterrupt !== 'function' && !ctx.signal) return 'log tail needs an interactive terminal';
      const level = args[0] || logger.getLevel();
      ctx.writeln(`tailing the log at ${level} and above, press q to stop`);
      const feed = createLogFeed({ write: (line) => ctx.writeln(line), minLevel: level, color: ctx.session.kind === 'ssh' });
      feed.start();
      try {
        await waitForStop(ctx);
      } finally {
        feed.stop();
      }
      return 'stopped';
    },
  });

  registry.register({
    name: 'log show',
    area: 'log',
    summary: 'Show the last log entries from today\'s log files',
    usage: 'log show [n=50] [level]',
    examples: ['log show', 'log show 100 warn'],
    run(args, ctx) {
      const usage = `usage: log show [n=50] [${LEVELS.join('|')}]`;
      let n = 50;
      let level = 'debug';
      if (args.length > 2) throw new Error(usage);
      for (const a of args) {
        if (/^\d+$/.test(a)) {
          n = Number(a);
          if (n < 1 || n > 5000) throw new Error(usage);
        } else if (LEVELS.includes(a)) level = a;
        else throw new Error(usage);
      }
      const entries = logger.readRecent(n, level);
      if (!entries.length) return 'no log entries';
      for (const e of entries) ctx.writeln(formatEntry(e));
    },
  });

  registry.register({
    name: 'log level',
    area: 'log',
    summary: 'Show or set the log level (applies now and is saved to config)',
    usage: 'log level [debug|info|warn|error]',
    examples: ['log level', 'log level debug'],
    run(args, ctx) {
      if (args.length > 1 || (args[0] && !LEVELS.includes(args[0]))) throw new Error(`usage: log level [${LEVELS.join('|')}]`);
      if (!args.length) return `log level: ${logger.getLevel()}`;
      logger.setLevel(args[0]);
      config.save({ logging: { level: args[0] } });
      logAdmin(ctx, `set log level to ${args[0]}`);
      return `log level set to ${args[0]}`;
    },
  });

  registry.register({
    name: 'log files',
    area: 'log',
    summary: 'List the log files and their sizes',
    usage: 'log files',
    run(args, ctx) {
      const files = logger.listFiles();
      if (!files.length) return 'no log files';
      const width = Math.max(...files.map((f) => f.name.length));
      for (const f of files) ctx.writeln(`${f.name.padEnd(width)}  ${kb(f.sizeBytes)}`);
    },
  });
};
