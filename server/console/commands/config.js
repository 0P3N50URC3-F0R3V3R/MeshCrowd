'use strict';

const config = require('../../lib/config');
const schema = require('../../lib/configSchema');
const logger = require('../../lib/logger');

const log = logger.scoped('config');

function getValue(cfg, key) {
  return key.split('.').reduce((o, p) => (o == null ? undefined : o[p]), cfg);
}

function patchFor(key, value) {
  return key.split('.').reduceRight((acc, p) => ({ [p]: acc }), value);
}

function show(key, value) {
  if (schema.lookup(key).secret) return '***';
  if (key === 'iceServers' && Array.isArray(value)) {
    return JSON.stringify(value.map((s) => (s && s.credential !== undefined ? { ...s, credential: '***' } : s)));
  }
  return JSON.stringify(value);
}

function applyLive(key, cfg) {
  if (key === 'logging.level') logger.setLevel(cfg.logging.level);
  else if (key === 'logging.keepDays') logger.configure({ keepDays: cfg.logging.keepDays });
  else if (key === 'logging.maxFileMb') logger.configure({ maxFileMb: cfg.logging.maxFileMb });
}

function change(ctx, key, value, verb) {
  const spec = schema.lookup(key);
  const before = show(key, getValue(config.load(), key));
  const cfg = config.save(patchFor(key, value));
  if (!spec.restart) applyLive(key, cfg);
  const after = show(key, value);
  log.warn(`${ctx.session.username} ${verb} ${key}: ${before} -> ${after}`);
  return `${key}: ${before} -> ${after} (${spec.restart ? 'restart required' : 'applied live'})`;
}

module.exports = function register(registry) {
  registry.register({
    name: 'config list',
    area: 'config',
    summary: 'List configuration values (secrets are shown as ***)',
    usage: 'config list [prefix]',
    examples: ['config list', 'config list logging'],
    run(args) {
      const cfg = config.load();
      const specs = schema.describe();
      const keys = Object.keys(specs).filter((k) => k.startsWith(args[0] || ''));
      if (!keys.length) throw new Error(`no config keys match: ${args[0]}`);
      return keys.map((k) => `${k} = ${show(k, getValue(cfg, k))}${specs[k].restart ? '' : '  (live)'}`).join('\n');
    },
  });

  registry.register({
    name: 'config get',
    area: 'config',
    summary: 'Show one configuration value',
    usage: 'config get <key>',
    examples: ['config get port'],
    run(args) {
      if (!args[0]) throw new Error('usage: config get <key>');
      return show(args[0], getValue(config.load(), args[0]));
    },
  });

  registry.register({
    name: 'config set',
    area: 'config',
    audit: true,
    summary: 'Validate and save a configuration value',
    usage: 'config set <key> <value>',
    examples: ['config set logging.level warn', 'config set registrationMode invite'],
    secretArgs: (args) => {
      try { return !!schema.lookup(args[0]).secret || args[0] === 'iceServers'; } catch { return false; }
    },
    run(args, ctx) {
      if (args.length < 2) throw new Error('usage: config set <key> <value>');
      return change(ctx, args[0], schema.coerce(args[0], args.slice(1).join(' ')), 'set');
    },
  });

  registry.register({
    name: 'config reset',
    area: 'config',
    audit: true,
    summary: 'Restore a configuration value to its default',
    usage: 'config reset <key>',
    examples: ['config reset logging.level'],
    run(args, ctx) {
      if (!args[0]) throw new Error('usage: config reset <key>');
      return change(ctx, args[0], schema.defaultOf(args[0]), 'reset');
    },
  });

  registry.register({
    name: 'config path',
    area: 'config',
    summary: 'Show the path of the configuration file',
    usage: 'config path',
    run() { return config.CONFIG_PATH; },
  });
};
