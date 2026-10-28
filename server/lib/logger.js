'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('../db');

const LOG_DIR = path.join(DATA_DIR, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function logFilePath() {
  return path.join(LOG_DIR, `dismesh-${new Date().toISOString().slice(0, 10)}.log`);
}

function write(level, args) {
  const line = `[${new Date().toISOString()}] [${level}] ${args.map(formatArg).join(' ')}\n`;
  fs.appendFile(logFilePath(), line, () => {}); // best-effort; a log write must never crash the caller
  (level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log)(...args);
}

function formatArg(a) {
  if (a instanceof Error) return a.stack || a.message;
  return typeof a === 'string' ? a : JSON.stringify(a);
}

module.exports = {
  log: (...args) => write('INFO', args),
  warn: (...args) => write('WARN', args),
  error: (...args) => write('ERROR', args),
};
