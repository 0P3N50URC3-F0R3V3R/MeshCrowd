'use strict';

const logger = require('../lib/logger');

const RANK = { debug: 0, info: 1, warn: 2, error: 3 };
const COLOR = { debug: '\x1b[90m', warn: '\x1b[33m', error: '\x1b[31m' };
const RESET = '\x1b[0m';

function formatEntry(e, color = false) {
  const time = e.ts.slice(11, 19);
  const line = `${time} ${e.level.toUpperCase().padEnd(5)} [${e.category}] ${e.message}`;
  return color && COLOR[e.level] ? `${COLOR[e.level]}${line}${RESET}` : line;
}

// minLevel is a level name or a function returning one, so the local console can follow `log level` changes.
function createLogFeed({ write, minLevel = 'info', color = false }) {
  let off = null;
  const current = () => (typeof minLevel === 'function' ? minLevel() : minLevel);
  return {
    start() {
      if (off) return;
      off = logger.subscribe((e) => {
        if (RANK[e.level] >= (RANK[current()] ?? 0)) write(formatEntry(e, color), e);
      });
    },
    stop() {
      if (off) off();
      off = null;
    },
  };
}

module.exports = { createLogFeed, formatEntry };
