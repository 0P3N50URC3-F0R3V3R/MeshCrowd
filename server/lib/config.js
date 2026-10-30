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
};

function load() {
  let cfg = { ...DEFAULTS };
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const file = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      cfg = { ...cfg, ...file, turn: { ...DEFAULTS.turn, ...(file.turn || {}) }, downloads: { ...DEFAULTS.downloads, ...(file.downloads || {}) } };
    } catch (err) {
      console.error('[config] failed to parse data/config.json, using defaults:', err.message);
    }
  }
  if (!cfg.turn.secret) cfg.turn.secret = require('node:crypto').randomBytes(32).toString('hex');
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  return cfg;
}

// Merges `patch` into data/config.json (nested objects one level deep, so { turn: { port: 1 } }
// keeps the other turn settings) and returns the stored result. Callers re-read with load().
function save(patch) {
  const cfg = load();
  for (const [k, v] of Object.entries(patch)) {
    cfg[k] = v && typeof v === 'object' && !Array.isArray(v) && cfg[k] && typeof cfg[k] === 'object' ? { ...cfg[k], ...v } : v;
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  return cfg;
}

module.exports = { load, save, CONFIG_PATH, DEFAULTS };
