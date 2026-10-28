'use strict';

// Interactive setup for the built-in STUN/TURN server: writes the settings to data/config.json,
// opens the operating system firewall, explains the router port forwarding and proves the relay
// works. Run through setup-turn.bat (Windows) or setup-turn.sh (Linux/macOS).
//
//   node server/tools/setupTurn.js                 interactive
//   node server/tools/setupTurn.js --yes --ip 203.0.113.10 [--port 3478] [--relay-min 49152 --relay-max 49999]
//   node server/tools/setupTurn.js --status | --disable | --remove-firewall

const readline = require('node:readline/promises');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const config = require('../lib/config');
const manager = require('../lib/turn/manager');
const credentials = require('../lib/turn/credentials');
const { TurnServer } = require('../lib/turn/server');
const { TurnClient } = require('../lib/turn/client');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };

const RULE_PREFIX = 'MeshCrowd TURN';
const out = (s = '') => console.log(s);
const ok = (s) => out(`  [ok] ${s}`);
const warn = (s) => out(`  [!!] ${s}`);

function isAdmin() {
  if (process.platform === 'win32') return spawnSync('net', ['session'], { stdio: 'ignore' }).status === 0;
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

function run(cmd, cmdArgs) {
  const r = spawnSync(cmd, cmdArgs, { encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

function firewallPlan(t) {
  const range = `${t.relayPortMin}-${t.relayPortMax}`;
  if (process.platform === 'win32') {
    const rule = (name, proto, ports) => ['netsh', ['advfirewall', 'firewall', 'add', 'rule', `name=${RULE_PREFIX} ${name}`, 'dir=in', 'action=allow', `protocol=${proto}`, `localport=${ports}`]];
    return {
      tool: 'Windows Firewall',
      remove: [['netsh', ['advfirewall', 'firewall', 'delete', 'rule', `name=${RULE_PREFIX} UDP`]], ['netsh', ['advfirewall', 'firewall', 'delete', 'rule', `name=${RULE_PREFIX} TCP`]], ['netsh', ['advfirewall', 'firewall', 'delete', 'rule', `name=${RULE_PREFIX} relay`]]],
      add: [rule('UDP', 'UDP', t.port), ...(t.tcp ? [rule('TCP', 'TCP', t.port)] : []), rule('relay', 'UDP', range)],
    };
  }
  if (run('which', ['ufw']).ok) {
    return { tool: 'ufw', remove: [], add: [['ufw', ['allow', `${t.port}/udp`]], ...(t.tcp ? [['ufw', ['allow', `${t.port}/tcp`]]] : []), ['ufw', ['allow', `${t.relayPortMin}:${t.relayPortMax}/udp`]]] };
  }
  if (run('which', ['firewall-cmd']).ok) {
    return {
      tool: 'firewalld', remove: [],
      add: [['firewall-cmd', ['--permanent', `--add-port=${t.port}/udp`]], ...(t.tcp ? [['firewall-cmd', ['--permanent', `--add-port=${t.port}/tcp`]]] : []), ['firewall-cmd', ['--permanent', `--add-port=${t.relayPortMin}-${t.relayPortMax}/udp`]], ['firewall-cmd', ['--reload']]],
    };
  }
  return null;
}

function applyFirewall(t) {
  const plan = firewallPlan(t);
  if (!plan) { warn('No supported firewall tool found. If a firewall is active, allow the ports listed below yourself.'); return; }
  if (!isAdmin()) {
    warn(`Not running as administrator, so the ${plan.tool} was not changed. Run this setup as administrator, or allow the ports below yourself.`);
    return;
  }
  for (const [cmd, a] of plan.remove) run(cmd, a);
  let allOk = true;
  for (const [cmd, a] of plan.add) { const r = run(cmd, a); if (!r.ok) { allOk = false; warn(`${cmd} ${a.join(' ')} failed: ${r.out}`); } }
  if (allOk) ok(`${plan.tool}: opened ${t.port} (UDP${t.tcp ? ' and TCP' : ''}) and ${t.relayPortMin}-${t.relayPortMax} (UDP)`);
}

function removeFirewall(t) {
  const plan = firewallPlan(t);
  if (!plan || !plan.remove.length) { out('Nothing to remove automatically on this system. Remove the rules you added by hand.'); return; }
  if (!isAdmin()) { warn('Run as administrator to remove the firewall rules.'); return; }
  for (const [cmd, a] of plan.remove) run(cmd, a);
  ok('Firewall rules removed.');
}

function localAddresses() {
  const list = [];
  for (const addrs of Object.values(os.networkInterfaces())) for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) list.push(a.address);
  return list;
}

function portTable(t, ip) {
  out();
  out('Router port forwarding (only needed when this machine is behind a router and people');
  out('outside your network should be able to use the relay):');
  out(`  forward  UDP ${t.port}${t.tcp ? `  and  TCP ${t.port}` : ''}  ->  this machine (${localAddresses()[0] || 'its LAN address'})`);
  out(`  forward  UDP ${t.relayPortMin}-${t.relayPortMax}  ->  this machine`);
  if (ip) out(`  People then reach the relay at ${ip}.`);
}

async function selfTest(t) {
  // The real server may already be running on the port; only test when we can bind ourselves.
  const test = new TurnServer({ ...t, listenAddress: '127.0.0.1', port: 0, allowPrivatePeers: true });
  try { await test.start(); } catch (err) { warn(`Self-test skipped (${err.message}).`); return; }
  const c = credentials.issue(t.secret, 'setup', 120);
  const cl = new TurnClient({ host: '127.0.0.1', port: test.port, username: c.username, credential: c.credential });
  try {
    const me = await cl.binding();
    const a = await cl.allocate();
    if (me && a.ok) ok(`Self-test passed: STUN answers and a relay was allocated at ${a.relayed.ip}:${a.relayed.port}.`);
    else warn(`Self-test failed (allocate error ${a.code}).`);
  } catch (err) { warn(`Self-test failed: ${err.message}`); }
  cl.close();
  await test.stop();
}

async function main() {
  const cfg = config.load();
  const t = cfg.turn;

  if (flag('status')) {
    out(`Built-in STUN/TURN server: ${t.enabled ? 'enabled' : 'disabled'}`);
    out(`  port ${t.port} (UDP${t.tcp ? '+TCP' : ''}), relay ports ${t.relayPortMin}-${t.relayPortMax}`);
    out(`  external IP: ${t.externalIp || '(not set)'}`);
    out(`  private-address relaying: ${t.allowPrivatePeers ? 'allowed' : 'refused'}`);
    return;
  }
  if (flag('disable')) { config.save({ turn: { enabled: false } }); ok('Built-in STUN/TURN server disabled. Restart MeshCrowd (or press Save in Admin > Calls) to apply.'); return; }
  if (flag('remove-firewall')) { removeFirewall(t); return; }

  const nonInteractive = flag('yes');
  const rl = nonInteractive ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q, def) => {
    if (nonInteractive) return def;
    const a = (await rl.question(`${q}${def !== undefined && def !== '' ? ` [${def}]` : ''}: `)).trim();
    return a === '' ? def : a;
  };
  const yes = async (q, def = true) => {
    if (nonInteractive) return def;
    const a = (await rl.question(`${q} [${def ? 'Y/n' : 'y/N'}]: `)).trim().toLowerCase();
    return a === '' ? def : a.startsWith('y');
  };
  const port = (v, name, def) => { const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 65535) { warn(`${name} must be 1-65535, using ${def}`); return def; } return n; };

  out();
  out('MeshCrowd built-in STUN/TURN setup');
  out('----------------------------------');
  out('Chat and call signaling always go through this server. Only the audio and video');
  out('between people needs STUN/TURN, and only when two of them cannot reach each other');
  out('directly (different networks, routers, NAT). On one network calls need none of this.');
  out();

  if (!(await yes('Run the built-in STUN/TURN server?', true))) {
    config.save({ turn: { enabled: false } });
    ok('Left disabled.');
    rl?.close();
    return;
  }

  let ip = opt('ip') ?? t.externalIp;
  if (!ip && !nonInteractive) {
    out('The relay must know this machine\'s public IPv4 address (the one the internet sees).');
    out('Detecting it asks a public STUN server (stun.l.google.com) once. Nothing else is sent.');
    if (await yes('Detect the public address now?', true)) {
      ip = await manager.detectExternalIp();
      if (ip) ok(`Detected ${ip}`); else warn('Could not detect it.');
    }
    ip = await ask('External IP (leave empty to skip, for a LAN-only relay)', ip || '');
  }
  if (ip && !manager.isIpv4(ip)) { warn(`"${ip}" is not an IPv4 address, ignoring it.`); ip = ''; }

  const next = {
    enabled: true,
    externalIp: ip || '',
    port: port(opt('port') ?? await ask('Port (UDP and TCP)', t.port), 'port', t.port),
    tcp: t.tcp,
    relayPortMin: port(opt('relay-min') ?? await ask('First relay port (UDP)', t.relayPortMin), 'relay-min', t.relayPortMin),
    relayPortMax: port(opt('relay-max') ?? await ask('Last relay port (UDP)', t.relayPortMax), 'relay-max', t.relayPortMax),
  };
  if (next.relayPortMax - next.relayPortMin < 9) { warn('The relay range must hold at least 10 ports, using the defaults.'); next.relayPortMin = 49152; next.relayPortMax = 49999; }

  const saved = config.save({ turn: next }).turn;
  ok(`Saved to data/config.json (port ${saved.port}, relay ports ${saved.relayPortMin}-${saved.relayPortMax}${saved.externalIp ? `, external IP ${saved.externalIp}` : ''}).`);

  if (await yes('Open the firewall on this machine for these ports?', true)) applyFirewall(saved);
  portTable(saved, saved.externalIp);
  out();
  await selfTest(saved);
  out();
  out('Next: restart MeshCrowd, or open Admin Panel > Calls and press Save. Use the Test button');
  out('there to check the relay again. To test from outside, join a call from a phone on mobile data.');
  rl?.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
