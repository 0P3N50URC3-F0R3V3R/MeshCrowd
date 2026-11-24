'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.DISMESH_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

// Sessions are opaque random tokens looked up server-side (see lib/session.js) — there is
// nothing to sign, so no secret is needed here.
const DEFAULTS = {
  port: 8080,
  httpsPort: 8443,
  publicHost: 'localhost',
  useHttps: true,
  // Bring-your-own certificate: paths (absolute, or relative to the project root) to a PEM
  // cert/key pair. Leave both empty to keep auto-generating/reusing the self-signed cert under
  // data/certs/ as before.
  serverCrt: '',
  serverKey: '',
  maxUploadMb: 25,
  // Max characters in one plaintext message (100-100000). Restart-only; encrypted DMs keep a fixed 4000.
  maxMessageChars: 15000,
  // Who may create an account: "open" (anyone), "closed" (nobody; admins can still add users) or
  // "invite" (only with a valid invite link/code). Editable in Admin Panel > Overview; the first
  // account on an empty instance is always allowed.
  registrationMode: 'open',
  // Empty by default: voice channels default to LAN-only, zero calls to any external service.
  // Self-hosters whose participants aren't all on the same local network/subnet (WAN access,
  // separate VLANs, restrictive NAT/firewalls) need at least a STUN entry here for WebRTC ICE
  // to find a path between peers at all — e.g. [{ "urls": "stun:stun.l.google.com:19302" }].
  iceServers: [],
  // Optional: LAN/VPN subnets (CIDR, e.g. ["26.0.0.0/8", "192.168.3.0/24"]) that voice peers should
  // reach each other on. Empty = automatic (nothing filtered). When set, private-range addresses
  // outside these subnets (Docker/WSL/other adapters) are not tried, so ICE settles on the VPN path
  // faster. STUN/TURN stay available as fallback either way.
  lanNetworks: [],
  // Mesh federation between instances. Off by default; a stand-alone server never opens any
  // federation route or worker. Passport identity works regardless of this flag.
  federation: { enabled: false },
  // Extra origins (e.g. "https://chat.example.com") a Passport may be signed for, on top of the
  // ones derived from publicHost/port/httpsPort. See lib/passportOrigin.js.
  passportOrigins: [],
  // Express "trust proxy" setting (false, true, a hop count or a subnet string). Set it when
  // running behind a reverse proxy so req.ip / req.protocol reflect the real client; otherwise
  // every user shares the proxy's IP for rate limiting and audit.
  trustProxy: false,
  // UnifiedPush endpoints are addresses users hand to the server, which then POSTs to them. Private
  // addresses (a ntfy on your LAN) are refused unless the operator turns this on.
  pushAllowPrivateEndpoints: false,
  // Own public HTTPS origin federation peers use to reach this instance. Defaults to publicHost:httpsPort;
  // override when the instance sits behind a reverse proxy on a different externally-visible URL.
  federationPublicUrl: '',
  // Sites (PHP intranet servers). phpPath: explicit php binary; empty = runtime/php/php.exe, then PATH.
  // maxWorkers: parallel php processes per Site (php -S handles one request at a time), 1-16.
  sites: { phpPath: '', maxWorkers: 4 },
  // This server's identity on the login page and in tracker adverts. Images live under data/instance/.
  instance: { name: '', description: '', logoPath: '', iconPath: '' },
  // MeshSwarm trackers: advertise is off by default; the tracker list is a seed the owner can edit or extend.
  swarm: { advertise: false, trackers: ['https://nexnet.hu:19898'], intervalSeconds: 300 },
  // Download/project links shown in the web UI (https:// only; anything else is ignored). Replace the
  // https://# placeholders and restart the server. `server` is just recorded here; the UI shows the
  // other three.
  downloads: { server: 'https://#', clientDesktop: 'https://#', clientAndroid: 'https://#', website: 'https://#' },
  // Built-in STUN/TURN server so calls connect across routers and NAT without a third-party
  // service (see lib/turn/). Off by default: LAN-only installs never open a UDP port. Turn it on in
  // Admin Panel > Calls or with setup-turn.bat / setup-turn.sh, which also open the firewall.
  turn: {
    enabled: false,
    port: 3478, // UDP and TCP
    listenAddress: '0.0.0.0',
    tcp: true,
    // Public IPv4 of this machine as the internet sees it. Empty = use the first public address of
    // a local interface; set it when the server sits behind a router doing NAT.
    externalIp: '',
    // Host name or IP clients are told to use. Empty = externalIp, else publicHost, else the
    // address the browser used to reach this server.
    advertisedHost: '',
    // Dynamic WAN address: re-read the public IPv4 periodically and, when it changes, store it in
    // externalIp (the old one goes to previousIp) and restart the built-in server. Source: 'upnp'
    // asks the router, 'stun' asks the STUN server in autoIpStun, 'http' reads the URL in autoIpUrl.
    autoIp: false,
    autoIpSource: 'upnp',
    autoIpStun: '',
    autoIpUrl: '',
    autoIpIntervalMinutes: 5,
    previousIp: '',
    ipChangedAt: '',
    relayPortMin: 49152,
    relayPortMax: 49999,
    realm: 'meshcrowd',
    // Signing secret for the short-lived credentials handed to signed-in users. Generated on first start.
    secret: '',
    credentialTtlSeconds: 86400,
    // Relaying to private addresses (10.x, 192.168.x, loopback...) is refused unless this is on,
    // so a TURN server cannot be used to reach into the LAN it sits in.
    allowPrivatePeers: false,
    maxAllocations: 500,
    maxAllocationsPerUser: 20,
    maxKbps: 0, // per allocation, 0 = unlimited
  },
  // Voice topology. 'mesh' = browsers connect to each other directly (no server sees the media).
  // 'sfu' = media goes through the in-process mediasoup SFU, which scales to larger rooms but means
  // the server terminates DTLS-SRTP, so it relays and can decrypt the streams. Worker i listens on port+i;
  // workers 0 = min(cpu count, 4).
  voice: {
    mode: 'mesh',
    sfu: { port: 40000, workers: 0, announcedHost: '', maxKbpsPerUser: 0, enableTcp: true },
  },
  // Password the local console's `purge` command asks for before resetting the server to a factory
  // state. Empty = purge is disabled.
  purgePassword: '',
  logging: { level: 'info', keepDays: 30, maxFileMb: 10 },
  ssh: { enabled: false, port: 2222, listenAddress: '127.0.0.1', maxSessions: 3, idleTimeoutMinutes: 15, allowPublicKeys: false },
  backup: { keep: 7, schedule: '', maxFileMb: 5, includeSecrets: false, preRestoreKeep: 3 },
};

let unreadableLogged = false;
let writeFailLogged = false;
let fallbackSecret = '';

function readFile() {
  try {
    return { text: fs.readFileSync(CONFIG_PATH, 'utf8') };
  } catch (err) {
    if (err.code === 'ENOENT') return { text: null };
    return { error: err };
  }
}

// Keeps the operator's permissions (e.g. chmod 600: the file holds the TURN secret); a new file is 0600.
function fileMode() {
  try {
    return fs.statSync(CONFIG_PATH).mode & 0o777;
  } catch {
    return 0o600;
  }
}

// Write to a temp file in the same directory and rename it over the target, so a reader (the
// Launcher, another load()) never sees a half-written config.json.
function writeAtomic(text) {
  const mode = fileMode();
  const tmp = `${CONFIG_PATH}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, CONFIG_PATH);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    // Windows refuses the rename while another process has the file open; a plain write still works.
    if (!['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err;
    fs.writeFileSync(CONFIG_PATH, text);
  }
}

// A crash between the temp write and the rename leaves a temp file behind; called at server start.
function sweepTempFiles(maxAgeMs = 60_000) {
  const dir = path.dirname(CONFIG_PATH);
  const prefix = `${path.basename(CONFIG_PATH)}.`;
  let names;
  try { names = fs.readdirSync(dir); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(prefix) || !/^config\.json\.\d+\.\d+\.tmp$/.test(name)) continue;
    const file = path.join(dir, name);
    try {
      if (Date.now() - fs.statSync(file).mtimeMs < maxAgeMs) continue;
      fs.rmSync(file, { force: true });
      removed++;
    } catch { /* gone meanwhile */ }
  }
  return removed;
}

function parse(text) {
  const file = JSON.parse(text);
  return { ...DEFAULTS, ...file, turn: { ...DEFAULTS.turn, ...(file.turn || {}) }, voice: { ...DEFAULTS.voice, ...(file.voice || {}), sfu: { ...DEFAULTS.voice.sfu, ...((file.voice || {}).sfu || {}) } }, downloads: { ...DEFAULTS.downloads, ...(file.downloads || {}) }, logging: { ...DEFAULTS.logging, ...(file.logging || {}) }, ssh: { ...DEFAULTS.ssh, ...(file.ssh || {}) }, backup: { ...DEFAULTS.backup, ...(file.backup || {}) }, instance: { ...DEFAULTS.instance, ...(file.instance || {}) }, swarm: { ...DEFAULTS.swarm, ...(file.swarm || {}) } };
}

function unreadable(why) {
  if (!unreadableLogged) console.error(`[config] could not read data/config.json (${why}), using defaults and leaving the file untouched`);
  unreadableLogged = true;
  if (!fallbackSecret) fallbackSecret = require('node:crypto').randomBytes(32).toString('hex');
  return { ...DEFAULTS, turn: { ...DEFAULTS.turn, secret: fallbackSecret } };
}

// Merges defaults into the file's content and writes it back only when that adds something
// (defaults for new keys, a generated TURN secret). Throws when the text does not parse.
function merged(text) {
  const cfg = text === null ? { ...DEFAULTS } : parse(text);
  if (!cfg.turn.secret) cfg.turn = { ...cfg.turn, secret: require('node:crypto').randomBytes(32).toString('hex') };
  const out = JSON.stringify(cfg, null, 2);
  if (out !== text) writeAtomic(out);
  return cfg;
}

// A file that cannot be read or parsed is never overwritten: the operator may be mid-edit, and
// replacing it with defaults would lose the TURN secret, ports and everything else. load() is on hot
// paths, so that case returns defaults instead of throwing.
function load() {
  const { text, error } = readFile();
  if (error) return unreadable(error.code || error.message);
  let cfg;
  try {
    cfg = parse(text === null ? '{}' : text);
  } catch (err) {
    return unreadable(err.message);
  }
  try {
    cfg = merged(text);
  } catch (err) {
    if (!writeFailLogged) console.error(`[config] could not update data/config.json (${err.code || err.message}), using it as it is`);
    writeFailLogged = true;
    if (!cfg.turn.secret) cfg.turn = { ...cfg.turn, secret: fallbackSecret || (fallbackSecret = require('node:crypto').randomBytes(32).toString('hex')) };
  }
  unreadableLogged = false;
  return cfg;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function parses(text) {
  try { JSON.parse(text); return true; } catch { return false; }
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function mergeDeep(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = isObj(v) && isObj(out[k]) ? mergeDeep(out[k], v) : v;
  return out;
}

// Merges `patch` into data/config.json (nested objects recursively, so { turn: { port: 1 } } and
// { voice: { sfu: { port: 1 } } } keep the sibling settings) and returns the stored result. Callers
// re-read with load().
// An unparseable file is moved aside to config.json.corrupt-<time> first instead of being lost. It is
// read a second time after a short pause, so a file another writer is just finishing is not mistaken
// for a corrupt one. A file that cannot be read at all makes save() throw rather than overwrite it.
function save(patch) {
  const first = readFile();
  if (first.error) throw first.error;
  if (first.text !== null && !parses(first.text)) {
    sleepSync(100);
    const again = readFile();
    if (again.error) throw again.error;
    if (again.text !== null && !parses(again.text)) {
      const aside = `${CONFIG_PATH}.corrupt-${Date.now()}`;
      fs.renameSync(CONFIG_PATH, aside);
      console.error(`[config] data/config.json could not be parsed; moved it to ${path.basename(aside)} before saving`);
    }
  }
  const { text, error } = readFile();
  if (error) throw error;
  const cfg = mergeDeep(merged(text), patch);
  writeAtomic(JSON.stringify(cfg, null, 2));
  return cfg;
}

module.exports = { load, save, sweepTempFiles, CONFIG_PATH, DEFAULTS };
