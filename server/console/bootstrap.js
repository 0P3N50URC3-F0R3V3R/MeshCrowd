'use strict';

const MODULES = ['core', 'account', 'moderation', 'config', 'backup', 'server', 'log', 'ssh'];

function registerAll(registry) {
  for (const name of MODULES) require(`./commands/${name}`)(registry);
}

module.exports = { registerAll };
