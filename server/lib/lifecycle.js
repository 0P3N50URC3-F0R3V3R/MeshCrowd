'use strict';

const logger = require('./logger');

const log = logger.scoped('lifecycle');

const RESTART_EXIT_CODE = 42;
const NOTICE_MARKS = [60, 30, 10, 5];

let closerTimeoutMs = 8000;
let watchdogMs = 20000;

let closers = [];
let pendingStop = null;
let running = null;
let closing = false;
let dbOverride = null;

function registerCloser(name, fn, opts = {}) {
  closers.push({ name, fn, resume: opts.resume || null, stopped: false });
}

function notify(text) {
  try {
    require('../socket/hub').broadcastAll({ type: 'server_notice', kind: 'lifecycle', text });
  } catch (err) {
    log.warn(`notice failed: ${err.message}`);
  }
}

async function runClosers() {
  for (const c of [...closers].reverse()) {
    if (c.stopped) continue;
    c.stopped = true;
    let timer;
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(() => { log.warn(`closer ${c.name} did not finish in ${closerTimeoutMs} ms, continuing`); resolve(); }, closerTimeoutMs);
    });
    try {
      await Promise.race([Promise.resolve().then(() => c.fn()), timedOut]);
    } catch (err) {
      log.error(`closer ${c.name} failed: ${err && err.message}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

function closeDb() {
  try {
    (dbOverride || require('../db').db).close();
  } catch { /* already closed by a restore */ }
}

function countdown(restart, seconds, announce) {
  const verb = restart ? 'restart' : 'stop';
  return new Promise((resolve) => {
    const timers = [];
    const say = (text) => { if (announce) notify(text); };
    const info = { restart, endsAt: Date.now() + seconds * 1000 };
    info.cancel = (silent) => {
      timers.forEach(clearTimeout);
      pendingStop = null;
      if (!silent) say(`Scheduled server ${verb} cancelled.`);
      resolve(false);
    };
    pendingStop = info;
    say(`The server will ${verb} in ${seconds} second${seconds === 1 ? '' : 's'}.`);
    for (const mark of NOTICE_MARKS) {
      if (mark < seconds) timers.push(setTimeout(() => say(`The server will ${verb} in ${mark} seconds.`), (seconds - mark) * 1000));
    }
    timers.push(setTimeout(() => { pendingStop = null; resolve(true); }, seconds * 1000));
  });
}

function shutdown({ restart = false, delaySeconds = 0, announce = true } = {}) {
  if (closing) {
    log.info('shutdown already in progress, waiting for it to finish');
    return running;
  }
  if (pendingStop) pendingStop.cancel(true);
  const p = (async () => {
    if (delaySeconds > 0 && !(await countdown(restart, delaySeconds, announce))) return;
    closing = true;
    const code = restart ? RESTART_EXIT_CODE : 0;
    const watchdog = setTimeout(() => {
      log.error('shutdown watchdog fired, forcing exit');
      closeDb();
      process.exit(code);
    }, watchdogMs);
    watchdog.unref();
    if (announce) notify(`The server is ${restart ? 'restarting' : 'stopping'} now.`);
    log.info(restart ? 'restarting' : 'stopping');
    await runClosers();
    closeDb();
    clearTimeout(watchdog);
    process.exit(code);
  })();
  running = p;
  const clear = () => { if (running === p) { running = null; closing = false; } };
  p.then(clear, clear);
  return p;
}

function pending() {
  return pendingStop ? { restart: pendingStop.restart, endsAt: pendingStop.endsAt } : null;
}

function cancel() {
  if (!pendingStop) return false;
  pendingStop.cancel(false);
  return true;
}

async function stopForRestore() {
  if (pendingStop) pendingStop.cancel(true);
  await runClosers();
  const stopped = closers.filter((c) => c.stopped);
  return {
    resume() {
      for (const c of stopped) {
        c.stopped = false;
        if (!c.resume) continue;
        try {
          Promise.resolve(c.resume()).catch((err) => log.error(`resume ${c.name} failed: ${err && err.message}`));
        } catch (err) {
          log.error(`resume ${c.name} failed: ${err && err.message}`);
        }
      }
    },
  };
}

const _test = {
  reset() { closers = []; pendingStop = null; running = null; closing = false; dbOverride = null; closerTimeoutMs = 8000; watchdogMs = 20000; },
  setTimeouts(o) { if (o.closer) closerTimeoutMs = o.closer; if (o.watchdog) watchdogMs = o.watchdog; },
  setDb(d) { dbOverride = d; },
};

module.exports = { registerCloser, shutdown, cancel, pending, stopForRestore, RESTART_EXIT_CODE, _test };
