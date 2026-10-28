'use strict';

const { DEFAULTS } = require('./config');

// The Passport signs the server origin so a proof made for one server cannot be replayed on
// another. The Host header is client-controlled, so a request-derived origin is only trusted when
// it is on this allow-list: origins built from config (publicHost + port / httpsPort), anything
// listed in config `passportOrigins`, and loopback hosts on any port, but only when the TCP peer
// is itself loopback and trust proxy is off (the Host header is client-controlled, so a remote
// peer must never be able to claim a loopback origin).
// LAN or domain deployments must set `publicHost` (or list extra origins in `passportOrigins`),
// otherwise Passport challenges are refused with "unrecognised server address".

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

let cfg = DEFAULTS;
let cached = null;

function configure(config) {
  cfg = { ...DEFAULTS, ...config };
  cached = null;
}

function withPort(scheme, host, port, defaultPort) {
  return `${scheme}://${host}${Number(port) === defaultPort ? '' : `:${port}`}`;
}

function normalize(origin) {
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

function allowedOrigins() {
  if (cached) return cached;
  const host = String(cfg.publicHost || '').toLowerCase();
  const set = new Set();
  if (host) {
    const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    set.add(withPort('http', h, cfg.port, 80));
    set.add(withPort('https', h, cfg.httpsPort, 443));
  }
  for (const o of Array.isArray(cfg.passportOrigins) ? cfg.passportOrigins : []) {
    const n = typeof o === 'string' ? normalize(o) : null;
    if (n) set.add(n);
  }
  cached = set;
  return set;
}

function isLoopbackAddress(addr) {
  if (typeof addr !== 'string') return false;
  const a = addr.toLowerCase();
  return a === '::1' || /^127\.\d+\.\d+\.\d+$/.test(a) || /^::ffff:127\.\d+\.\d+\.\d+$/.test(a);
}

const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'forwarded', 'via'];

// A same-host reverse proxy with trustProxy unset makes every remote client look like a loopback
// peer, so any proxy header means the loopback peer is not the real client.
function peerIsTrustedLoopback(req) {
  if (!req || !req.socket || !isLoopbackAddress(req.socket.remoteAddress)) return false;
  const headers = req.headers || {};
  if (PROXY_HEADERS.some((h) => headers[h] !== undefined)) return false;
  const tp = req.app && typeof req.app.get === 'function' ? req.app.get('trust proxy') : false;
  return !tp;
}

function isAllowedOrigin(origin, req) {
  const n = typeof origin === 'string' ? normalize(origin) : null;
  if (!n || n !== origin) return false;
  if (LOOPBACK_HOSTS.has(new URL(n).hostname)) return peerIsTrustedLoopback(req);
  return allowedOrigins().has(n);
}

// Lines to log at boot: the accepted origins, plus a warning when the config looks like a deployment
// whose real address is not on the list (web sign-up then falls back to password-only accounts).
function bootLines(config) {
  const c = { ...DEFAULTS, ...config };
  const lines = [`[passport] accepted server origins: ${[...allowedOrigins()].join(', ') || '(none)'}`];
  const hostIsDefault = String(c.publicHost || 'localhost').toLowerCase() === 'localhost';
  const customCert = !!(c.serverCrt || c.serverKey);
  if (hostIsDefault && (customCert || c.trustProxy)) {
    lines.push('[passport] WARNING: publicHost is still "localhost" but a custom certificate or trustProxy is configured. Set publicHost (or passportOrigins) to the address users reach this server on, or Passport sign-up/login will be refused with "unrecognised server address".');
  }
  return lines;
}

module.exports = { configure, allowedOrigins, isAllowedOrigin, bootLines, peerIsTrustedLoopback };
