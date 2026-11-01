'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

const RESTART_EXIT_CODE = 42;

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

// A terminal Ctrl+C reaches the whole foreground process group (Windows console and POSIX tty alike), so the
// child already has its SIGINT; forwarding another would make it skip its graceful shutdown. Windows has no
// working signal forwarding at all.
function forwardedSignals(platform) {
  return platform === 'win32' ? [] : ['SIGTERM', 'SIGHUP'];
}

function supervise(script, { stdio = 'inherit', platform = process.platform } = {}) {
  let child = null;
  let stopping = false;
  const forwarded = forwardedSignals(platform);
  const forward = (signal) => {
    stopping = true;
    if (child && forwarded.includes(signal)) child.kill(signal);
  };
  const signals = SIGNALS;
  for (const s of signals) process.on(s, forward);

  return new Promise((resolve) => {
    const launch = () => {
      child = spawn(process.execPath, [script], { stdio, env: { ...process.env, MESHCROWD_SUPERVISED: '1' } });
      child.on('error', () => { cleanup(); resolve(1); });
      child.on('exit', (code) => {
        if (code === RESTART_EXIT_CODE && !stopping) { launch(); return; }
        cleanup();
        resolve(code === RESTART_EXIT_CODE ? 0 : code === null ? 1 : code);
      });
    };
    const cleanup = () => { for (const s of signals) process.off(s, forward); };
    launch();
  });
}

module.exports = { supervise, forwardedSignals, RESTART_EXIT_CODE };

if (require.main === module) {
  const entry = path.join(__dirname, 'index.js');
  if (process.env.MESHCROWD_NO_SUPERVISOR === '1') require(entry);
  else supervise(entry).then((code) => process.exit(code));
}
