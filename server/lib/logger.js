'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('../db');

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const DAY_MS = 24 * 60 * 60 * 1000;

let logDir = path.join(DATA_DIR, 'logs');
let level = null;
let maxFileMb = null;
let keepDays = null;
const listeners = new Set();
let toConsole = true;

// config.load() writes the config file, so it is read lazily and only once.
function settings() {
  if (level !== null) return;
  let cfg = {};
  try { cfg = require('./config').load().logging || {}; } catch { /* config unreadable: use defaults */ }
  level = LEVELS[cfg.level] !== undefined ? cfg.level : 'info';
  if (maxFileMb === null) maxFileMb = cfg.maxFileMb > 0 ? cfg.maxFileMb : 10;
  if (keepDays === null) keepDays = cfg.keepDays > 0 ? cfg.keepDays : 30;
}

try { fs.mkdirSync(logDir, { recursive: true }); } catch { /* log writes are best-effort */ }

function today() { return new Date().toISOString().slice(0, 10); }

function filesForDay(day) {
  let names;
  try { names = fs.readdirSync(logDir); } catch { return []; }
  const re = new RegExp(`^dismesh-${day}(?:\\.(\\d+))?\\.log$`);
  return names
    .map((name) => { const m = re.exec(name); return m && { name, idx: Number(m[1] || 0) }; })
    .filter(Boolean)
    .sort((a, b) => a.idx - b.idx)
    .map((f) => f.name);
}

function targetFile() {
  settings();
  const day = today();
  const files = filesForDay(day);
  const last = files.length ? files[files.length - 1] : `dismesh-${day}.log`;
  let size = 0;
  try { size = fs.statSync(path.join(logDir, last)).size; } catch { /* new file */ }
  if (size < maxFileMb * 1024 * 1024) return path.join(logDir, last);
  return path.join(logDir, `dismesh-${day}.${files.length}.log`);
}

function mask(text) {
  return String(text).replace(
    /(\b\w*(?:password|passwd|token|secret|authkey|key)["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&}]+)/gi,
    '$1***'
  );
}

function formatArg(a) {
  if (a instanceof Error) return a.stack || a.message;
  return typeof a === 'string' ? a : JSON.stringify(a);
}

function emit(lvl, category, args) {
  settings();
  if (LEVELS[lvl] < LEVELS[level]) return;
  const ts = new Date().toISOString();
  const message = mask(args.map(formatArg).join(' '));
  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(targetFile(), `[${ts}] [${lvl.toUpperCase()}] [${category}] ${message}\n`);
  } catch { /* a log write must never crash the caller */ }
  if (toConsole) (lvl === 'error' ? console.error : lvl === 'warn' ? console.warn : console.log)(...args);
  const entry = { ts, level: lvl, category, message };
  for (const fn of listeners) {
    try { fn(entry); } catch { /* a bad subscriber must not break logging */ }
  }
}

function scoped(category) {
  return {
    debug: (...args) => emit('debug', category, args),
    info: (...args) => emit('info', category, args),
    warn: (...args) => emit('warn', category, args),
    error: (...args) => emit('error', category, args),
  };
}

const app = scoped('app');

function setLevel(l) {
  if (LEVELS[l] === undefined) throw new Error(`invalid log level: ${l}`);
  settings();
  level = l;
}

function getLevel() {
  settings();
  return level;
}

// The interactive console renders the live feed itself, so it turns the plain stdout echo off while it runs.
function setConsoleOutput(on) { toConsole = !!on; }

function subscribe(fn) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

const LINE_RE = /^\[([^\]]+)\] \[(DEBUG|INFO|WARN|ERROR)\] \[([^\]]*)\] ?(.*)$/;

function readRecent(n, minLevel = 'debug') {
  const min = LEVELS[minLevel] ?? 0;
  const entries = [];
  for (const name of filesForDay(today())) {
    let text;
    try { text = fs.readFileSync(path.join(logDir, name), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      const m = LINE_RE.exec(line);
      if (m) entries.push({ ts: m[1], level: m[2].toLowerCase(), category: m[3], message: m[4] });
      else if (line && entries.length) entries[entries.length - 1].message += `\n${line}`;
    }
  }
  return entries.filter((e) => LEVELS[e.level] >= min).slice(-n);
}

function listFiles() {
  let names;
  try { names = fs.readdirSync(logDir); } catch { return []; }
  return names.filter((f) => /^dismesh-.*\.log$/.test(f)).sort().map((name) => {
    let sizeBytes = 0;
    try { sizeBytes = fs.statSync(path.join(logDir, name)).size; } catch { /* vanished */ }
    return { name, sizeBytes };
  });
}

function pruneOldFiles() {
  settings();
  const cutoff = Date.now() - keepDays * DAY_MS;
  let removed = 0;
  for (const { name } of listFiles()) {
    const file = path.join(logDir, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) { fs.unlinkSync(file); removed++; }
    } catch { /* best-effort */ }
  }
  return removed;
}

// Overrides the config-derived limits and the log directory; used by tests.
function configure(opts) {
  settings();
  if (opts.dir !== undefined) logDir = opts.dir;
  if (opts.maxFileMb !== undefined) maxFileMb = opts.maxFileMb;
  if (opts.keepDays !== undefined) keepDays = opts.keepDays;
}

pruneOldFiles();
setInterval(pruneOldFiles, DAY_MS).unref();

module.exports = {
  debug: (...args) => app.debug(...args),
  log: (...args) => app.info(...args),
  warn: (...args) => app.warn(...args),
  error: (...args) => app.error(...args),
  scoped, setConsoleOutput, setLevel, getLevel, subscribe, readRecent, listFiles, pruneOldFiles, mask, configure,
};
