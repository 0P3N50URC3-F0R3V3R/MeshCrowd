'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { Client } = require('ssh2');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const { db } = require('../db');
const accounts = require('../lib/accounts');
const totp = require('../lib/totp');
const logger = require('../lib/logger');
const { SITE_PERMISSIONS } = require('../lib/permissions');
const { createRegistry } = require('../console/registry');
const { registerAll } = require('../console/bootstrap');
const guard = require('../lib/security/guard');
const sshAuth = require('../console/sshAuth');
const ssh = require('../console/ssh');

const PW = 'sup3r-secret-pw-xyz';
const logged = [];
logger.subscribe((e) => logged.push(`${e.level} ${e.category} ${e.message}`));

guard.noteFailure = () => {};
const realCheck = guard.check;

const registry = createRegistry();
registerAll(registry);

const mk = async (username) => (await accounts.createAccount({ username, email: `${username}@t.local`, password: PW })).userId;
const grant = (uid) => {
  const rid = Number(db.prepare('INSERT INTO site_roles (name, color, permissions, position) VALUES (?, ?, ?, ?)')
    .run(`R${uid}`, '#000000', SITE_PERMISSIONS.MANAGE_CONSOLE, 1).lastInsertRowid);
  db.prepare('INSERT INTO user_site_roles (user_id, role_id) VALUES (?, ?)').run(uid, rid);
  return rid;
};

let server; let port; let ownerId; const open = [];
test.before(async () => {
  ownerId = await mk('root1');
  server = await ssh.start({ ssh: { port: 0, listenAddress: '127.0.0.1', maxSessions: 2, idleTimeoutMinutes: 15 } }, { registry, authTimeoutMs: 3000 });
  port = server.port;
});
test.beforeEach(() => {
  sshAuth._test.reset();
  sshAuth._test.setLimiter({ capacity: 1000, refillPerSec: 1000 });
});
test.after(async () => {
  for (const c of open) c.end();
  await server.stop();
  db.close();
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function connect(username, password, extra = {}) {
  return new Promise((resolve, reject) => {
    const c = new Client();
    c.on('ready', () => { open.push(c); resolve(c); });
    c.on('error', reject);
    c.connect({ host: '127.0.0.1', port, username, password, readyTimeout: 5000, ...extra });
  });
}

function shell(c) {
  return new Promise((resolve, reject) => {
    c.shell({ term: 'xterm', cols: 100, rows: 30 }, (err, stream) => {
      if (err) return reject(err);
      let text = '';
      let closed = false;
      stream.on('data', (d) => { text += d.toString('utf8'); });
      stream.on('close', () => { closed = true; });
      const waitFor = async (re, ms = 4000) => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
          if (re.test(text)) return text;
          await new Promise((r) => setTimeout(r, 20));
        }
        throw new Error(`timeout waiting for ${re}, got: ${JSON.stringify(text)}`);
      };
      resolve({ stream, text: () => text, clear: () => { text = ''; }, waitFor, isClosed: () => closed });
    });
  });
}

const rejected = (fn) => new Promise((resolve) => fn((err) => resolve(err || null)));

test('host key is created with its fingerprint and reused on the next start', () => {
  assert.match(server.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
  const file = path.join(tmpDir, 'ssh_host_ed25519');
  assert.ok(fs.existsSync(file));
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('login, help, exit', async () => {
  const c = await connect('root1', PW);
  const sh = await shell(c);
  await sh.waitFor(/meshcrowd> /);
  sh.clear();
  sh.stream.write('help\r');
  await sh.waitFor(/log tail/);
  assert.ok(!/ssh kick/.test(sh.text()), 'local-only commands are hidden over ssh');
  assert.ok(sh.text().includes('\r\n'));
  sh.clear();
  sh.stream.write('ssh status\r');
  await sh.waitFor(/`ssh status` is only available in the local server console/);
  sh.clear();
  sh.stream.write('frobnicate\r');
  await sh.waitFor(/unknown command: frobnicate/);
  sh.stream.write('exit\r');
  await new Promise((r) => c.on('close', r));
});

test('wrong user and wrong password fail identically on the client', async () => {
  const a = await connect('ghost', PW).catch((e) => e);
  const b = await connect('root1', 'wrong-wrong-wrong').catch((e) => e);
  assert.ok(a instanceof Error && b instanceof Error);
  assert.equal(a.message, b.message);
  assert.equal(a.level, b.level);
  assert.match(a.message, /authentication methods failed/);
});

test('publickey and none are not offered', async () => {
  const methods = await new Promise((resolve) => {
    const c = new Client();
    c.on('error', () => {});
    c.on('close', () => {});
    c.on('ready', () => resolve(['ready']));
    c.on('handshake', () => {});
    c.connect({ host: '127.0.0.1', port, username: 'root1', authHandler: (left, partial, cb) => {
      if (left === null) return cb('none');
      resolve(left);
      return false;
    } });
  });
  assert.deepEqual([...methods].sort(), ['keyboard-interactive', 'password']);
});

test('exec, sftp and port forwards are refused', async () => {
  const c = await connect('root1', PW);
  const execErr = await rejected((done) => c.exec('echo pwned', (err) => done(err)));
  assert.ok(execErr, 'exec must fail');
  const sftpErr = await rejected((done) => c.sftp((err) => done(err)));
  assert.ok(sftpErr, 'sftp must fail');
  const outErr = await rejected((done) => c.forwardOut('127.0.0.1', 1111, '127.0.0.1', 22, (err) => done(err)));
  assert.ok(outErr, 'direct-tcpip must fail');
  const inErr = await rejected((done) => c.forwardIn('127.0.0.1', 0, (err) => done(err)));
  assert.ok(inErr, 'tcpip-forward must fail');
  const sh = await shell(c);
  await sh.waitFor(/meshcrowd> /);
  c.end();
});

test('a shell without a pty is refused', async () => {
  const c = await connect('root1', PW);
  const raw = await new Promise((resolve) => {
    c.shell(false, (e) => resolve(e || null));
  });
  assert.ok(raw instanceof Error);
  c.end();
});

test('maxSessions is enforced and a closed session frees its slot', async () => {
  const a = await connect('root1', PW);
  const b = await connect('root1', PW);
  const third = await connect('root1', PW).catch((e) => e);
  assert.ok(third instanceof Error);
  assert.equal(server.sessions().length, 2);
  a.end();
  for (let i = 0; i < 50 && server.sessions().length > 1; i++) await new Promise((r) => setTimeout(r, 20));
  const again = await connect('root1', PW);
  again.end();
  b.end();
});

test('revoking the permission closes the session on the next command', async () => {
  const uid = await mk('temp1');
  const rid = grant(uid);
  const c = await connect('temp1', PW);
  const sh = await shell(c);
  await sh.waitFor(/meshcrowd> /);
  sh.stream.write('help\r');
  await sh.waitFor(/log tail/);
  db.prepare('DELETE FROM user_site_roles WHERE role_id = ?').run(rid);
  sh.clear();
  sh.stream.write('help\r');
  await sh.waitFor(/access revoked/);
  assert.ok(!/log tail/.test(sh.text()));
  await new Promise((r) => c.on('close', r));
});

test('a disabled account is closed on the next command', async () => {
  const uid = await mk('temp2');
  grant(uid);
  const c = await connect('temp2', PW);
  const sh = await shell(c);
  await sh.waitFor(/meshcrowd> /);
  db.prepare('UPDATE users SET is_disabled = 1 WHERE id = ?').run(uid);
  sh.stream.write('help\r');
  await sh.waitFor(/access revoked/);
  await new Promise((r) => c.on('close', r));
});

test('account without the flag cannot log in', async () => {
  await mk('plain2');
  const err = await connect('plain2', PW).catch((e) => e);
  assert.ok(err instanceof Error);
});

test('totp account logs in through keyboard-interactive with a recovery code', async () => {
  const uid = await mk('totp2');
  grant(uid);
  const secret = totp.generateSecret();
  const codes = totp.generateRecoveryCodes(2);
  db.prepare('UPDATE users SET totp_enabled = 1, totp_secret = ?, totp_recovery_codes = ? WHERE id = ?').run(secret, JSON.stringify(codes), uid);
  const viaPassword = await connect('totp2', PW).catch((e) => e);
  assert.ok(viaPassword instanceof Error, 'plain password auth is refused for a 2fa account');
  const asked = [];
  const c = new Client();
  c.on('keyboard-interactive', (name, instr, lang, prompts, finish) => {
    asked.push(prompts.map((p) => p.prompt));
    finish([prompts[0].prompt.startsWith('Password') ? PW : codes[0]]);
  });
  await new Promise((resolve, reject) => {
    c.on('ready', resolve);
    c.on('error', reject);
    c.connect({ host: '127.0.0.1', port, username: 'totp2', tryKeyboard: true, readyTimeout: 5000 });
  });
  open.push(c);
  assert.deepEqual(asked.flat(), ['Password: ', 'Verification code: ']);
  c.end();
});

test('idle sessions are closed', async () => {
  const quick = await ssh.start({ ssh: { port: 0, listenAddress: '127.0.0.1', maxSessions: 2, idleTimeoutMinutes: 0.01 } }, { registry, authTimeoutMs: 3000 });
  const c = new Client();
  await new Promise((resolve, reject) => {
    c.on('ready', resolve);
    c.on('error', reject);
    c.connect({ host: '127.0.0.1', port: quick.port, username: 'root1', password: PW });
  });
  const sh = await shell(c);
  await sh.waitFor(/meshcrowd> /);
  await sh.waitFor(/idle timeout/, 3000);
  await new Promise((r) => c.on('close', r));
  await quick.stop();
});

test('tab completion hides local-only commands, log tail streams until q, Ctrl+D leaves', async () => {
  const c = await connect('root1', PW);
  const sh = await shell(c);
  await sh.waitFor(/meshcrowd> /);
  sh.clear();
  sh.stream.write('ss\t');
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!/ssh/.test(sh.text()), 'ssh commands are local-only');
  sh.stream.write('\x15log tail\r');
  await sh.waitFor(/tailing the log/);
  logger.scoped('probe').warn('probe-line-123');
  await sh.waitFor(/probe-line-123/);
  sh.stream.write('q');
  await sh.waitFor(/stopped/);
  sh.clear();
  logger.scoped('probe').warn('probe-after-stop');
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!/probe-after-stop/.test(sh.text()));
  sh.stream.write('\x04');
  await new Promise((r) => c.on('close', r));
});

test('kick disconnects a session; stop closes everything', async () => {
  const c = await connect('root1', PW);
  const sh = await shell(c);
  await sh.waitFor(/meshcrowd> /);
  const [s] = server.sessions();
  assert.equal(s.username, 'root1');
  assert.equal(server.kick(s.id), true);
  await new Promise((r) => c.on('close', r));
  assert.equal(server.kick(9999), false);
});

test('terminal escape sequences from command output are filtered', () => {
  const dirty = 'a\x1b]52;c;ZXZpbA==\x07b\x1b[6nc\x1b[31mred\x1b[0m\x9bd\x00e\n';
  assert.equal(ssh.toWire(dirty), 'a]52;c;ZXZpbA==b[6nc\x1b[31mred\x1b[0mde\r\n');
});

test('the password never reaches the log', async () => {
  await connect('root1', 'sup3r-secret-pw-xyz-wrong').catch(() => {});
  assert.ok(logged.some((l) => /login failed/.test(l)));
  assert.ok(!logged.some((l) => l.includes('sup3r-secret-pw-xyz')));
  const logDir = path.join(tmpDir, 'logs');
  if (fs.existsSync(logDir)) {
    for (const f of fs.readdirSync(logDir)) assert.ok(!fs.readFileSync(path.join(logDir, f), 'utf8').includes('sup3r-secret-pw-xyz'));
  }
});

test('a non-loopback listen address logs a warning naming it', async () => {
  logged.length = 0;
  const wide = await ssh.start({ ssh: { port: 0, listenAddress: '0.0.0.0', maxSessions: 1, idleTimeoutMinutes: 1 } }, { registry });
  assert.ok(logged.some((l) => /^warn ssh .*0\.0\.0\.0/.test(l)));
  await wide.stop();
});

const cfgFor = (maxSessions = 2) => ({ ssh: { port: 0, listenAddress: '127.0.0.1', maxSessions, idleTimeoutMinutes: 15 } });
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
};

test('silent sockets are destroyed after the auth timeout and free their slots', async () => {
  const s = await ssh.start(cfgFor(), { registry, authTimeoutMs: 1500, maxConnectionsPerIp: 10 });
  const socks = [1, 2, 3].map(() => net.connect(s.port, '127.0.0.1'));
  const closed = socks.map((sock) => new Promise((r) => { sock.on('error', () => {}); sock.on('close', r); sock.resume(); }));
  assert.ok(await until(() => s.connections() === 3));
  await Promise.all(closed);
  assert.ok(await until(() => s.connections() === 0));
  const c = new Client();
  await new Promise((resolve, reject) => {
    c.on('ready', resolve);
    c.on('error', reject);
    c.on('close', () => reject(new Error('closed')));
    c.connect({ host: '127.0.0.1', port: s.port, username: 'root1', password: PW });
  });
  c.end();
  await s.stop();
});

test('a per-address cap refuses the fourth concurrent socket', async () => {
  const s = await ssh.start(cfgFor(), { registry, authTimeoutMs: 5000, maxConnectionsPerIp: 3 });
  const socks = [];
  for (let i = 0; i < 3; i++) {
    const sock = net.connect(s.port, '127.0.0.1');
    sock.on('error', () => {});
    socks.push(sock);
    await new Promise((r) => sock.once('connect', r));
  }
  assert.ok(await until(() => s.connections() === 3));
  const fourth = net.connect(s.port, '127.0.0.1');
  fourth.on('error', () => {});
  fourth.resume();
  await new Promise((r) => fourth.on('close', r));
  assert.equal(s.connections(), 3);
  assert.ok(socks.every((x) => !x.destroyed));
  for (const x of socks) x.destroy();
  assert.ok(await until(() => s.connections() === 0));
  await s.stop();
});

test('a peer that never answers the close is destroyed after the grace period', async () => {
  const s = await ssh.start(cfgFor(), { registry, authTimeoutMs: 5000, closeGraceMs: 300 });
  const raw = net.connect({ host: '127.0.0.1', port: s.port, allowHalfOpen: true });
  raw.on('error', () => {});
  await new Promise((r) => raw.once('connect', r));
  const c = new Client();
  c.on('error', () => {});
  await new Promise((resolve, reject) => {
    c.on('ready', resolve);
    c.on('error', reject);
    c.connect({ sock: raw, username: 'root1', password: PW });
  });
  raw.end = () => {};
  raw.destroy = () => {};
  const [sess] = s.sessions();
  assert.equal(s.kick(sess.id), true);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(s.connections(), 1, 'the socket is still held while the peer has not closed');
  assert.ok(await until(() => s.connections() === 0, 2000), 'forced shut after the grace period');
  await s.stop();
});

test('a blocked address is dropped before the ssh handshake', async () => {
  const s = await ssh.start(cfgFor(), { registry });
  guard.check = () => ({ blocked: true, source: 'ban' });
  try {
    const sock = net.connect(s.port, '127.0.0.1');
    sock.on('error', () => {});
    sock.resume();
    await new Promise((r) => sock.on('close', r));
    assert.equal(s.connections(), 0);
  } finally {
    guard.check = realCheck;
  }
  await s.stop();
});

test('sockets that never send the ssh banner are dropped after the pre-banner deadline, a normal login is not', async () => {
  const s = await ssh.start(cfgFor(), { registry, authTimeoutMs: 5000, preBannerMs: 300, maxConnectionsPerIp: 10 });
  const started = Date.now();
  const silent = net.connect(s.port, '127.0.0.1');
  silent.on('error', () => {});
  silent.resume();
  const closed = new Promise((r) => silent.on('close', r));
  const c = new Client();
  await new Promise((resolve, reject) => {
    c.on('ready', resolve);
    c.on('error', reject);
    c.on('close', () => reject(new Error('closed')));
    c.connect({ host: '127.0.0.1', port: s.port, username: 'root1', password: PW });
  });
  await closed;
  assert.ok(Date.now() - started < 3000, 'well before the 5 s login deadline');
  assert.ok(await until(() => s.connections() === 1), 'the logged in client keeps its connection');
  c.end();
  await s.stop();
});

test('hitting the global connection cap drops the socket and warns once per minute', async () => {
  logged.length = 0;
  const s = await ssh.start(cfgFor(), { registry, authTimeoutMs: 5000, maxConnections: 2, maxConnectionsPerIp: 10 });
  const socks = [];
  for (let i = 0; i < 4; i++) {
    const sock = net.connect(s.port, '127.0.0.1');
    sock.on('error', () => {});
    sock.resume();
    socks.push(sock);
    await new Promise((r) => sock.once('connect', r));
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(await until(() => s.connections() === 2));
  assert.equal(logged.filter((l) => /^warn ssh .*connection limit of 2/.test(l)).length, 1);
  for (const x of socks) x.destroy();
  await s.stop();
});
