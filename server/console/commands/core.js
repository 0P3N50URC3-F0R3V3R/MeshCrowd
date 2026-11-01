'use strict';

function describe(def) {
  const lines = [`${def.name}${def.aliases && def.aliases.length ? ` (${def.aliases.join(', ')})` : ''}`];
  lines.push(`  usage: ${def.usage}`, `  ${def.summary}`);
  if (def.examples && def.examples.length) {
    lines.push('  examples:', ...def.examples.map((e) => `    ${e}`));
  }
  return lines.join('\n');
}

function listArea(defs, area) {
  const width = Math.max(...defs.map((d) => d.name.length));
  return [`${area}:`, ...defs.map((d) => `  ${d.name.padEnd(width)}  ${d.summary}`)];
}

module.exports = function register(registry) {
  registry.register({
    name: 'help',
    area: 'general',
    summary: 'List commands, or show details for a command or area',
    usage: 'help [command|area]',
    examples: ['help', 'help account', 'help account create'],
    run(args, ctx) {
      const visible = registry.listFor(ctx.session);
      const areas = new Map();
      for (const d of visible) {
        if (!areas.has(d.area)) areas.set(d.area, []);
        areas.get(d.area).push(d);
      }
      if (!args.length) {
        const out = [];
        for (const [area, defs] of areas) out.push(...listArea(defs, area), '');
        out.push('type help <command> for details');
        return out.join('\n');
      }
      const query = args.join(' ');
      const found = registry.resolve(args);
      if (found && !found.args.length && visible.includes(found.def)) return describe(found.def);
      if (areas.has(query)) return listArea(areas.get(query), query).join('\n');
      const hint = registry.suggest(args[0], ctx.session);
      return `unknown command: ${query}${hint ? `, did you mean ${hint}?` : ''} try help`;
    },
  });

  registry.register({
    name: 'exit',
    aliases: ['quit'],
    area: 'general',
    summary: 'Close this console session',
    usage: 'exit',
    run(args, ctx) { ctx.close(); },
  });
};
