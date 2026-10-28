// Parsing for bot slash commands typed in the composer. Built-in commands (/me, /nick ...) are
// handled elsewhere; this only knows about the definitions bots registered.

// Splits on whitespace, keeping "double quoted" text together.
export function tokenize(text) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  let m;
  while ((m = re.exec(text))) out.push({ value: m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2], start: m.index });
  return out;
}

// "/roll <sides:integer> [note] [secret:boolean]" - what the autocomplete shows.
export function usageOf(def) {
  const opts = (def.options || []).map((o) => {
    const label = o.type === 'string' ? o.name : `${o.name}:${o.type}`;
    return o.required ? `<${label}>` : `[${label}]`;
  });
  return `/${def.name}${opts.length ? ' ' + opts.join(' ') : ''}`;
}

// Options are positional, in the order the bot declared them. A last string option takes the rest
// of the line, so "/note some free text" needs no quotes. Any option also accepts "name:value".
export function parseInvocation(def, rest) {
  const defs = def.options || [];
  const named = new Map(defs.map((o) => [o.name, o]));
  const text = String(rest || '').trim();
  const options = {};
  const positional = [];
  for (const tok of tokenize(text)) {
    const i = tok.value.indexOf(':');
    const key = i > 0 ? tok.value.slice(0, i) : null;
    if (key && named.has(key) && !(key in options)) options[key] = tok.value.slice(i + 1);
    else positional.push(tok);
  }
  const free = defs.filter((o) => !(o.name in options));
  for (let i = 0; i < free.length && i < positional.length; i++) {
    const o = free[i];
    if (i === free.length - 1 && o.type === 'string') {
      options[o.name] = text.slice(positional[i].start).trim().replace(/^"([^"]*)"$/, '$1');
      break;
    }
    options[o.name] = positional[i].value;
  }
  return options;
}

// The first missing required option, or null.
export function missingRequired(def, options) {
  const miss = (def.options || []).find((o) => o.required && (options[o.name] === undefined || options[o.name] === ''));
  return miss ? miss.name : null;
}
