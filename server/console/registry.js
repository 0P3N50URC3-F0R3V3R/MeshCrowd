'use strict';

const { parseLine } = require('./parser');
const logger = require('../lib/logger');

const SECRET_NAME = '(?:[a-z0-9]+-)*(?:password|passwd|token|secret|key)';
const SECRET_FLAG = new RegExp(`^--?${SECRET_NAME}$`, 'i');
const SECRET_FLAG_EQ = new RegExp(`^(--?${SECRET_NAME})=`, 'i');

function describeError(e) {
  try {
    if (e && typeof e.message === 'string' && e.message) return e.message;
    return String(e);
  } catch {
    return 'unknown error';
  }
}

function distance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function maskArgs(args, secretArgs) {
  if (secretArgs) return args.map(() => '***');
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const eq = SECRET_FLAG_EQ.exec(args[i]);
    if (eq) out.push(`${eq[1]}=***`);
    else if (SECRET_FLAG.test(args[i])) {
      out.push(args[i]);
      if (i + 1 < args.length) { out.push('***'); i++; }
    } else out.push(args[i]);
  }
  return out;
}

function createRegistry() {
  const defs = [];
  const byName = new Map();
  const log = logger.scoped('console');

  function register(def) {
    const names = [def.name, ...(def.aliases || [])];
    for (const n of names) {
      if (byName.has(n)) throw new Error(`console command already registered: ${n}`);
    }
    defs.push(def);
    for (const n of names) byName.set(n, def);
  }

  function reset() {
    defs.length = 0;
    byName.clear();
  }

  function allowed(def, session) {
    return !(def.local && session.kind === 'ssh');
  }

  function listFor(session) {
    return defs.filter((d) => allowed(d, session));
  }

  function resolve(tokens) {
    for (let n = tokens.length; n >= 1; n--) {
      const def = byName.get(tokens.slice(0, n).join(' '));
      if (def) return { def, args: tokens.slice(n) };
    }
    return null;
  }

  function completions(prefix, session) {
    return [...byName.entries()]
      .filter(([n, def]) => n.startsWith(prefix) && (!session || allowed(def, session)))
      .map(([n]) => n)
      .sort();
  }

  function suggest(word, session) {
    const names = listFor(session).flatMap((d) => [d.name, ...(d.aliases || [])]);
    let best = null;
    let bestDist = Infinity;
    for (const n of names) {
      const first = n.split(' ')[0];
      const d = distance(word.toLowerCase(), first.toLowerCase());
      if (d < bestDist) { best = first; bestDist = d; }
    }
    return bestDist <= Math.max(2, Math.floor(word.length / 2)) ? best : null;
  }

  // What readline should keep in history for a line: a masked form when the command takes secrets inline.
  function historyForm(line) {
    let found;
    try { found = resolve(parseLine(line)); } catch { return null; }
    if (!found || !found.args.length) return null;
    const flag = found.def.secretArgs;
    const secret = typeof flag === 'function' ? flag(found.args) : flag;
    return secret ? `${found.def.name} ***` : null;
  }

  async function execute(line, ctx) {
    let tokens;
    try {
      tokens = parseLine(line);
    } catch (e) {
      ctx.writeln(`error: ${e.message}`);
      return;
    }
    if (!tokens.length) return;
    const found = resolve(tokens);
    if (!found || !allowed(found.def, ctx.session)) {
      const hint = suggest(tokens[0], ctx.session);
      ctx.writeln(`unknown command: ${tokens[0]}${hint ? `, did you mean ${hint}?` : ''} try help`);
      return;
    }
    const { def, args } = found;
    log.info(`${ctx.session.username} ran: ${[def.name, ...maskArgs(args, def.secretArgs)].join(' ')}`);
    try {
      const result = await def.run(args, ctx);
      if (typeof result === 'string') ctx.writeln(result);
    } catch (e) {
      ctx.writeln(`error: ${describeError(e)}`);
    }
  }

  return { register, reset, execute, completions, listFor, resolve, suggest, historyForm };
}

const registry = createRegistry();

module.exports = { ...registry, createRegistry };
