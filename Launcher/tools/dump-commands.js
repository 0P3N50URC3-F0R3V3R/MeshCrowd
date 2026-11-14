'use strict';
// Dumps the server console command registry to Launcher/Resources/commands.json.
// Run with a scratch data dir:  DISMESH_DATA_DIR=<tmp> node Launcher/tools/dump-commands.js
const fs = require('node:fs');
const path = require('node:path');
const registry = require('../../server/console/registry');
require('../../server/console/bootstrap').registerAll(registry);
const out = registry.listFor({ kind: 'local' }).map((d) => ({
  name: d.name,
  aliases: d.aliases || [],
  area: d.area,
  summary: d.summary,
  usage: d.usage,
  examples: d.examples || [],
  audit: !!d.audit,
  local: !!d.local,
}));
const dest = path.join(__dirname, '..', 'Resources', 'commands.json');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(out, null, 2));
console.log(`${out.length} commands -> ${dest}`);
process.exit(0);
