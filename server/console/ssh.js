'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const readline = require('node:readline');
const { Writable } = require('node:stream');
const { Server, utils } = require('ssh2');
const logger = require('../lib/logger');
const guard = require('../lib/security/guard');
const sshAuth = require('./sshAuth');
const { version } = require('../../package.json');

const log = logger.scoped('ssh');

const PROMPT = 'meshcrowd> ';
const AUTH_METHODS = ['password', 'keyboard-interactive'];
const MAX_AUTH_TRIES = 3;
const MAX_LINE = 4096;
const HOST_KEY_FILE = 'ssh_host_ed25519';

// The remote terminal is untrusted ground for escape sequences (log lines and user names contain attacker-chosen
// text): only colour, erase and cursor movement survive. Query sequences like ESC[6n would make the terminal type
// a reply into the admin's input line.
const OUT_FILTER = /(\x1b\[[0-9;]*[mKJHABCDGf])|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u0080-\u009f]/g;
const toWire = (s) => String(s).replace(OUT_FILTER, (m, keep) => keep || '').replace(/\r?\n/g, '\r\n');

let activeServer = null;

function isLoopback(addr) {
  return addr === 'localhost' || addr === '::1' || /^127\./.test(addr);
}

function dataDirOf(opts) {
  return opts.dataDir || process.env.DISMESH_DATA_DIR || path.join(__dirname, '..', '..', 'data');
}

function loadHostKey(dir) {
  const file = path.join(dir, HOST_KEY_FILE);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dir, { recursive: true });
    const { private: priv } = utils.generateKeyPairSync('ed25519');
    fs.writeFileSync(file, priv, { mode: 0o600, flag: 'wx' });
    log.info(`[ssh] generated a new host key at ${file}`);
  } else if (process.platform !== 'win32') {
    try {
      if (fs.statSync(file).mode & 0o077) {
        fs.chmodSync(file, 0o600);
        log.warn(`[ssh] host key ${file} was readable by others, permissions tightened to 0600`);
      }
    } catch { /* fail closed below if unreadable */ }
  }
  const pem = fs.readFileSync(file);
  const key = utils.parseKey(pem);
  if (key instanceof Error) throw new Error(`ssh host key ${file} is unusable: ${key.message}`);
  const fingerprint = `SHA256:${crypto.createHash('sha256').update(key.getPublicSSH()).digest('base64').replace(/=+$/, '')}`;
  return { pem, fingerprint };
}

function startShell({ channel, session, registry, closeSession, touch, cols: initialCols, recheck }) {
  const out = new Writable({
    decodeStrings: false,
    write(chunk, enc, cb) {
      if (!channel.destroyed && channel.writable) channel.write(toWire(chunk));
      cb();
    },
  });
  out.columns = initialCols;

  const rl = readline.createInterface({
    input: channel,
    output: out,
    prompt: PROMPT,
    terminal: true,
    historySize: 200,
    removeHistoryDuplicates: true,
    completer: (line) => (pendingAsk ? [[], line] : [registry.completions(line.trimStart(), session), line]),
  });

  const interrupts = new Set();
  let stopped = false;
  let pendingAsk = null;
  let muted = false;
  let chain = Promise.resolve();

  const writeToOutput = rl._writeToOutput.bind(rl);
  rl._writeToOutput = (s) => {
    if (interrupts.size) return;
    if (!muted) return writeToOutput(s);
    const prompt = rl.getPrompt();
    if (s.length >= prompt.length && s.startsWith(prompt)) writeToOutput(prompt);
  };

  function clearTyped() {
    if (rl.line) rl.write(null, { ctrl: true, name: 'u' });
  }

  function ask(question, { secret = false } = {}) {
    return new Promise((resolve, reject) => {
      pendingAsk = { resolve, reject };
      rl.setPrompt(`${question} `);
      rl.prompt();
      muted = secret;
    });
  }

  const ctx = {
    session,
    write: (t) => { out.write(t); },
    writeln: (t) => { out.write(`${t}\n`); },
    ask,
    async confirm(question) {
      return /^y(es)?$/i.test((await ask(`${question} [y/N]`)).trim());
    },
    close() { closeSession('exit'); },
    onInterrupt(fn) {
      interrupts.add(fn);
      return () => { interrupts.delete(fn); };
    },
  };

  function fireInterrupts() {
    for (const fn of [...interrupts]) {
      try { fn(); } catch (e) { log.error('[ssh] interrupt handler failed:', e); }
    }
  }

  function runLine(line) {
    chain = chain
      .then(async () => {
        if (!recheck()) {
          ctx.writeln('access revoked: the console permission was removed from this account, closing the session');
          closeSession('permission lost');
          return;
        }
        await registry.execute(line, ctx);
      })
      .catch((e) => log.error('[ssh] command failed:', e))
      .then(() => {
        if (stopped) return;
        rl.setPrompt(PROMPT);
        rl.prompt();
      });
  }

  rl.on('line', (line) => {
    touch();
    if (pendingAsk) {
      const { resolve } = pendingAsk;
      const secret = muted;
      pendingAsk = null;
      muted = false;
      if (secret) {
        if (rl.history[0] === line) rl.history.shift();
        out.write('\n');
      }
      rl.setPrompt(PROMPT);
      resolve(line);
      return;
    }
    if (interrupts.size) {
      if (line.trim() === 'q') fireInterrupts();
      return;
    }
    if (line.length > MAX_LINE) {
      ctx.writeln('error: line too long');
      rl.prompt();
      return;
    }
    const masked = registry.historyForm && registry.historyForm(line);
    if (masked && rl.history[0] === line) rl.history[0] = masked;
    runLine(line);
  });

  channel.on('data', touch);
  rl.input.on('keypress', (ch) => {
    if (ch === 'q' && interrupts.size) {
      clearTyped();
      fireInterrupts();
    }
  });

  rl.on('SIGINT', () => {
    touch();
    if (pendingAsk) {
      const { reject } = pendingAsk;
      pendingAsk = null;
      muted = false;
      rl.setPrompt(PROMPT);
      clearTyped();
      out.write('\n');
      reject(new Error('cancelled'));
      return;
    }
    if (interrupts.size) {
      clearTyped();
      fireInterrupts();
      return;
    }
    clearTyped();
    out.write('^C\n');
    rl.prompt();
  });

  function stop() {
    if (stopped) return;
    stopped = true;
    interrupts.clear();
    if (pendingAsk) pendingAsk.reject(new Error('session closed'));
    pendingAsk = null;
    rl.close();
  }
  rl.on('close', () => { stop(); closeSession('eof'); });

  out.write(`MeshCrowd ${version} console over ssh. Type help for commands, exit or Ctrl+D to leave\n`);
  rl.prompt();

  return {
    stop,
    rl,
    resize(cols) {
      if (Number.isInteger(cols) && cols >= 20 && cols <= 1000) out.columns = cols;
    },
  };
}

async function start(config, opts = {}) {
  const cfg = (config && config.ssh) || {};
  const registry = opts.registry;
  if (!registry) throw new Error('ssh.start needs a command registry');
  const authTimeoutMs = opts.authTimeoutMs ?? 30_000;
  const maxSessions = cfg.maxSessions ?? 3;
  const idleMs = (cfg.idleTimeoutMinutes ?? 15) * 60_000;
  const listenAddress = cfg.listenAddress ?? '127.0.0.1';
  const { pem, fingerprint } = loadHostKey(dataDirOf(opts));

  const graceMs = opts.closeGraceMs ?? 1500;
  const maxPerIp = opts.maxConnectionsPerIp ?? 3;
  const maxConnections = opts.maxConnections ?? Math.max(20, maxSessions * 4);
  const preBannerMs = Math.min(opts.preBannerMs ?? 10_000, authTimeoutMs);
  let lastCapWarn = 0;
  const sessions = new Map();
  const clients = new Set();
  const peers = new Map();
  const perIp = new Map();
  let nextId = 1;

  const server = new Server({ hostKeys: [pem], ident: 'MeshCrowd', keepaliveInterval: 30_000, keepaliveCountMax: 3 }, (client, info) => {
    const ip = String(info.ip || 'unknown').replace(/^::ffff:/, '');
    const peer = peers.get(`${info.ip}|${info.port}`);
    if (!peer) { client.end(); return; }
    clearTimeout(peer.bannerTimer);
    clients.add(client);
    let tries = 0;
    let entry = null;
    let shellStarted = false;
    let sessionChannels = 0;
    let shell = null;
    let idleTimer = null;
    let ended = false;

    // client.end() only sends a FIN and waits for the peer's, so a peer that never answers would keep the socket.
    const hardClose = () => {
      client.end();
      forceDestroy(peer.sock);
    };

    const touch = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (shell) closeSession('idle timeout', 'idle timeout reached, closing the session');
      }, idleMs);
      idleTimer.unref();
    };

    let channelRef = null;
    function closeSession(reason, notice) {
      if (ended) return;
      ended = true;
      if (notice && channelRef && channelRef.writable) channelRef.write(toWire(`\n${notice}\n`));
      if (shell) shell.stop();
      if (channelRef && !channelRef.destroyed) {
        try { channelRef.exit(0); } catch { /* channel already gone */ }
        channelRef.end();
      }
      setTimeout(hardClose, 50).unref();
      if (entry) log.info(`[ssh] closing session user=${entry.username} ip=${ip} reason=${reason}`);
    }

    client.on('error', (err) => log.debug(`[ssh] connection error ip=${ip}: ${err && err.message}`));
    client.on('close', () => {
      if (idleTimer) clearTimeout(idleTimer);
      clients.delete(client);
      if (shell) shell.stop();
      if (entry) {
        sessions.delete(entry.id);
        log.info(`[ssh] disconnect user=${entry.username} ip=${ip} after ${Math.round((Date.now() - entry.since) / 1000)}s`);
      }
    });

    function finish(ctx, result) {
      if (!result || !result.ok) return ctx.reject(AUTH_METHODS);
      if (sessions.size >= maxSessions) {
        log.warn(`[ssh] login refused user=${sshAuth.cleanName(result.user.username)} ip=${ip} reason=max_sessions`);
        return ctx.reject(AUTH_METHODS);
      }
      entry = { id: nextId++, userId: result.user.id, username: result.user.username, ip, since: Date.now(), client, close: closeSession };
      sessions.set(entry.id, entry);
      ctx.accept();
    }

    client.on('authentication', (ctx) => {
      if (ended || entry) return ctx.reject(AUTH_METHODS);
      if (ctx.method !== 'password' && ctx.method !== 'keyboard-interactive') return ctx.reject(AUTH_METHODS);
      if (++tries > MAX_AUTH_TRIES) {
        ctx.reject(AUTH_METHODS);
        hardClose();
        return;
      }
      const run = async () => {
        if (ctx.method === 'password') {
          finish(ctx, await sshAuth.authenticate({ username: ctx.username, password: ctx.password, ip, conn: client }));
          return;
        }
        ctx.prompt([{ prompt: 'Password: ', echo: false }], async (answers) => {
          if (!Array.isArray(answers)) return;
          try {
            const password = answers[0];
            const first = await sshAuth.authenticate({ username: ctx.username, password, ip, conn: client });
            if (!first.needTotp) return finish(ctx, first);
            ctx.prompt([{ prompt: 'Verification code: ', echo: true }], async (codes) => {
              if (!Array.isArray(codes)) return;
              try {
                finish(ctx, await sshAuth.authenticate({ username: ctx.username, password, totp: codes[0], ip, conn: client }));
              } catch (e) {
                log.error('[ssh] auth error:', e);
                ctx.reject(AUTH_METHODS);
              }
            });
          } catch (e) {
            log.error('[ssh] auth error:', e);
            ctx.reject(AUTH_METHODS);
          }
        });
      };
      run().catch((e) => {
        log.error('[ssh] auth error:', e);
        ctx.reject(AUTH_METHODS);
      });
    });

    client.on('request', (accept, reject, name) => {
      log.warn(`[ssh] rejected global request ${name} ip=${ip}`);
      if (reject) reject();
    });
    client.on('tcpip', (accept, reject, req) => {
      log.warn(`[ssh] rejected port forward to ${sshAuth.cleanName(req && req.destIP)}:${Number(req && req.destPort) || 0} ip=${ip}`);
      reject();
    });
    client.on('openssh.streamlocal', (accept, reject) => reject());

    client.on('ready', () => {
      if (!entry) { hardClose(); return; }
      log.info(`[ssh] session opened user=${entry.username} ip=${ip}`);
      client.on('session', (accept, reject) => {
        if (shellStarted || ++sessionChannels > 4) return reject();
        const sess = accept();
        let cols = 80;
        let hasPty = false;

        const deny = (what) => (acceptReq, rejectReq) => {
          log.warn(`[ssh] rejected ${what} request user=${entry.username} ip=${ip}`);
          if (rejectReq) rejectReq();
        };
        sess.on('exec', deny('exec'));
        sess.on('subsystem', deny('subsystem'));
        sess.on('env', deny('env'));
        sess.on('x11', deny('x11'));
        sess.on('auth-agent', deny('agent forwarding'));
        sess.on('signal', () => {});

        sess.on('pty', (acceptReq, rejectReq, req) => {
          if (hasPty) { if (rejectReq) rejectReq(); return; }
          hasPty = true;
          if (req && Number.isInteger(req.cols) && req.cols >= 20 && req.cols <= 1000) cols = req.cols;
          if (acceptReq) acceptReq();
        });
        sess.on('window-change', (acceptReq, rejectReq, req) => {
          if (shell && req) shell.resize(req.cols);
          else if (req && Number.isInteger(req.cols) && req.cols >= 20 && req.cols <= 1000) cols = req.cols;
          if (acceptReq) acceptReq();
        });
        sess.on('shell', (acceptReq, rejectReq) => {
          if (!acceptReq) return;
          if (shellStarted || !hasPty || !sshAuth.stillAllowed(entry.userId)) { if (rejectReq) rejectReq(); return; }
          shellStarted = true;
          clearTimeout(peer.timer);
          channelRef = acceptReq();
          channelRef.on('close', () => closeSession('channel closed'));
          channelRef.on('error', () => {});
          touch();
          shell = startShell({
            channel: channelRef,
            session: { kind: 'ssh', userId: entry.userId, username: entry.username },
            registry,
            closeSession,
            touch,
            cols,
            recheck: () => sshAuth.stillAllowed(entry.userId),
          });
        });
      });
    });
  });

  server.on('error', (e) => log.error('[ssh] server error:', e));
  server.maxConnections = maxConnections;

  function forceDestroy(sock) {
    if (sock.destroyed) return;
    const t = setTimeout(() => sock.destroy(), graceMs);
    t.unref();
    sock.once('close', () => clearTimeout(t));
  }

  // The TCP layer is ours: ssh2 only learns about a connection after the peer sent its SSH banner, so silent
  // sockets, per-address floods and banned addresses must be dealt with before injectSocket.
  const tcp = net.createServer((sock) => {
    const remote = sock.remoteAddress;
    if (!remote) { sock.destroy(); return; }
    sock.on('error', () => {});
    const bucket = sshAuth.ipBucket(remote);
    if (guard.check(remote).blocked) { log.debug(`[ssh] refused connection from blocked address ${remote}`); sock.destroy(); return; }
    const count = perIp.get(bucket) || 0;
    if (count >= maxPerIp) { log.debug(`[ssh] refused connection from ${remote}: too many concurrent connections`); sock.destroy(); return; }
    if (peers.size >= maxConnections) {
      if (Date.now() - lastCapWarn >= 60_000) {
        lastCapWarn = Date.now();
        log.warn(`[ssh] connection limit of ${maxConnections} reached, dropping connections (latest from ${remote})`);
      }
      sock.destroy();
      return;
    }
    perIp.set(bucket, count + 1);
    const key = `${remote}|${sock.remotePort}`;
    const peer = { sock, timer: null, bannerTimer: null };
    peers.set(key, peer);
    peer.timer = setTimeout(() => {
      log.warn(`[ssh] closing connection ip=${remote}: no shell within ${authTimeoutMs} ms`);
      sock.destroy();
    }, authTimeoutMs);
    peer.timer.unref();
    // Cleared by the ssh2 connection event, i.e. once the peer sent its banner; silent sockets must not hold a global slot.
    peer.bannerTimer = setTimeout(() => {
      log.debug(`[ssh] closing connection ip=${remote}: no ssh banner within ${preBannerMs} ms`);
      sock.destroy();
    }, preBannerMs);
    peer.bannerTimer.unref();
    sock.once('close', () => {
      clearTimeout(peer.timer);
      clearTimeout(peer.bannerTimer);
      peers.delete(key);
      const left = (perIp.get(bucket) || 1) - 1;
      if (left > 0) perIp.set(bucket, left); else perIp.delete(bucket);
    });
    server.injectSocket(sock);
  });
  tcp.on('error', (e) => log.error('[ssh] listener error:', e));

  await new Promise((resolve, reject) => {
    tcp.once('error', reject);
    tcp.listen(cfg.port ?? 2222, listenAddress, () => {
      tcp.removeListener('error', reject);
      resolve();
    });
  });

  const port = tcp.address().port;
  log.info(`[ssh] listening on ${listenAddress}:${port}, host key ${fingerprint}`);
  if (!isLoopback(listenAddress)) {
    log.warn(`[ssh] listening on ${listenAddress}:${port}, which is reachable beyond this machine. Anyone who can reach it can attempt to log in`);
  }

  const handle = {
    fingerprint,
    listenAddress,
    port,
    sessions: () => [...sessions.values()].map((s) => ({ id: s.id, userId: s.userId, username: s.username, ip: s.ip, since: s.since })),
    kick(id) {
      const s = sessions.get(Number(id));
      if (!s) return false;
      s.close('kicked', 'disconnected by the server operator');
      return true;
    },
    connections: () => peers.size,
    stop() {
      if (activeServer === handle) activeServer = null;
      return new Promise((resolve) => {
        for (const s of [...sessions.values()]) s.close('server stopping', 'server is shutting down');
        for (const c of clients) c.end();
        for (const { sock } of peers.values()) forceDestroy(sock);
        const force = setTimeout(() => { for (const { sock } of peers.values()) sock.destroy(); resolve(); }, graceMs + 500);
        force.unref();
        tcp.close(() => { clearTimeout(force); resolve(); });
      });
    },
  };
  activeServer = handle;
  return handle;
}

module.exports = { start, current: () => activeServer, toWire, isLoopback, _test: { startShell } };
