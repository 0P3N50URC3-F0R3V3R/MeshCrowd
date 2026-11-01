'use strict';

const readline = require('node:readline');
const logger = require('../lib/logger');
const { createLogFeed } = require('./logFeed');
const { version } = require('../../package.json');

const PROMPT = 'meshcrowd> ';
const CLEAR_LINE = '\r\x1b[K';
const DOUBLE_PRESS_MS = 2000;

const SESSION = Object.freeze({ kind: 'local', userId: null, username: 'console' });

// The local console is trusted (no login): it is the server window itself. It always streams the live log at the
// current level; `log tail` is only meaningful for ssh sessions.
function start({ stdin, stdout, registry, onExit, color, terminal, session = SESSION }) {
  const useColor = color ?? (!!stdout.isTTY && !process.env.NO_COLOR);
  const rl = readline.createInterface({
    input: stdin,
    output: stdout,
    prompt: PROMPT,
    terminal: terminal ?? !!stdout.isTTY,
    historySize: 200,
    removeHistoryDuplicates: true,
    completer: (line) => (pendingAsk ? [[], line] : [registry.completions(line.trimStart(), session), line]),
  });

  const interrupts = new Set();
  let stopped = false;
  let idle = false;
  let pendingAsk = null;
  let muted = false;
  let lastCtrlC = 0;
  let chain = Promise.resolve();

  // Readline echoes every keystroke through _writeToOutput; while muted only the prompt itself may be redrawn.
  const writeToOutput = rl._writeToOutput.bind(rl);
  rl._writeToOutput = (s) => {
    if (!muted) return writeToOutput(s);
    const prompt = rl.getPrompt();
    if (s.length >= prompt.length && s.startsWith(prompt)) writeToOutput(prompt);
  };

  function printAbove(text) {
    stdout.write(`${CLEAR_LINE}${text}\n`);
    if (idle || pendingAsk) rl.prompt(true);
  }

  const feed = createLogFeed({ write: printAbove, minLevel: () => logger.getLevel(), color: useColor });
  logger.setConsoleOutput(false);
  feed.start();

  function clearTyped() {
    if (rl.line) rl.write(null, { ctrl: true, name: 'u' });
  }

  function ask(question, { secret = false } = {}) {
    return new Promise((resolve, reject) => {
      pendingAsk = { resolve, reject, secret };
      rl.setPrompt(`${question} `);
      rl.prompt();
      muted = secret;
    });
  }

  const ctx = {
    session,
    liveLog: true,
    write: (t) => { stdout.write(t); },
    writeln: (t) => { stdout.write(`${t}\n`); },
    ask,
    async confirm(question) {
      return /^y(es)?$/i.test((await ask(`${question} [y/N]`)).trim());
    },
    close() { stop(); stdout.write('console closed, the server keeps running\n'); },
    onInterrupt(fn) {
      interrupts.add(fn);
      return () => { interrupts.delete(fn); };
    },
  };

  function fireInterrupts() {
    for (const fn of [...interrupts]) {
      try { fn(); } catch (e) { logger.error('[console] interrupt handler failed:', e); }
    }
  }

  function scrubHistory(line) {
    const masked = registry.historyForm && registry.historyForm(line);
    if (masked && rl.history[0] === line) rl.history[0] = masked;
  }

  function runLine(line) {
    chain = chain
      .then(async () => {
        idle = false;
        await registry.execute(line, ctx);
      })
      .catch((e) => logger.error('[console]', e))
      .then(() => {
        if (stopped) return;
        idle = true;
        rl.setPrompt(PROMPT);
        rl.prompt();
      });
  }

  rl.on('line', (line) => {
    if (pendingAsk) {
      const { resolve, secret } = pendingAsk;
      pendingAsk = null;
      muted = false;
      if (secret) {
        rl.history.shift();
        stdout.write('\n');
      }
      rl.setPrompt(PROMPT);
      resolve(line);
      return;
    }
    if (interrupts.size) {
      if (line.trim() === 'q') fireInterrupts();
      return;
    }
    scrubHistory(line);
    runLine(line);
  });

  if (rl.terminal) {
    stdin.on('keypress', (ch) => {
      if (ch === 'q' && interrupts.size) {
        fireInterrupts();
        clearTyped();
      }
    });
  }

  rl.on('SIGINT', () => {
    if (pendingAsk) {
      const { reject } = pendingAsk;
      pendingAsk = null;
      muted = false;
      rl.setPrompt(PROMPT);
      clearTyped();
      stdout.write('\n');
      reject(new Error('cancelled'));
      return;
    }
    if (interrupts.size) {
      fireInterrupts();
      clearTyped();
      return;
    }
    const now = Date.now();
    if (now - lastCtrlC <= DOUBLE_PRESS_MS) {
      lastCtrlC = 0;
      stdout.write('\n');
      if (onExit) onExit();
      return;
    }
    lastCtrlC = now;
    clearTyped();
    printAbove('(press Ctrl+C again within 2 seconds to stop the server, or type exit to close this console)');
  });

  function stop() {
    if (stopped) return;
    stopped = true;
    feed.stop();
    logger.setConsoleOutput(true);
    interrupts.clear();
    if (pendingAsk) pendingAsk.reject(new Error('console closed'));
    pendingAsk = null;
    rl.close();
  }

  rl.on('close', stop);

  stdout.write(`MeshCrowd ${version} console. Type help for commands\n`);
  idle = true;
  rl.prompt();

  return { stop, rl };
}

module.exports = { start, SESSION, PROMPT };
