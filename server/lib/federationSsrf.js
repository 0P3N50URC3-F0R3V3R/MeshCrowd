'use strict';

const dns = require('node:dns/promises');
const net = require('node:net');

// IPv4/IPv6 ranges that must never be treated as a legitimate federation peer, even if an
// admin was tricked into pairing with one (handshake-time check) or a peer's public_url is
// later changed to point at one (checked again before every outbound call).
function isPrivateOrLoopback(ip) {
  const type = net.isIP(ip);
  if (type === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true;
    return false;
  }
  if (type === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;

    // IPv4-mapped (::ffff:x.x.x.x) or IPv4-compatible (::x.x.x.x) addresses
    if (lower.startsWith('::ffff:') || (lower.startsWith('::') && lower !== '::')) {
      let suffix;
      if (lower.startsWith('::ffff:')) {
        suffix = lower.slice(7); // remove '::ffff:'
      } else {
        suffix = lower.slice(2); // remove '::'
      }

      // Dotted-decimal form like ::ffff:169.254.169.254 or ::169.254.169.254
      if (suffix.includes('.')) {
        return isPrivateOrLoopback(suffix);
      }

      // Hex form like ::ffff:a9fe:a9fe or ::a9fe:a9fe; extract and check embedded IPv4
      const parts = suffix.split(':');
      if (parts.length === 2 && parts[0] && parts[1]) {
        try {
          const high = parseInt(parts[0], 16);
          const low = parseInt(parts[1], 16);
          const a = (high >> 8) & 0xff;
          const b = high & 0xff;
          const c = (low >> 8) & 0xff;
          const d = low & 0xff;
          const ipv4 = `${a}.${b}.${c}.${d}`;
          return isPrivateOrLoopback(ipv4);
        } catch {
          // Fall through to other checks
        }
      }
    }

    // fc00::/7 private
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;

    // fe80::/10 link-local: first group 0xfe80–0xfebf (10 fixed bits, 6 free bits in first group)
    const groups = lower.split(':');
    if (groups.length > 0 && groups[0]) {
      try {
        const firstGroup = parseInt(groups[0], 16);
        if (firstGroup >= 0xfe80 && firstGroup <= 0xfebf) return true;
      } catch {
        // Fall through
      }
    }

    return false;
  }
  return true; // couldn't parse as an IP at all — treat as unsafe
}

async function isSafePeerUrl(urlString) {
  // Test-only escape hatch for the two-instance integration harness (server/test/federationIntegration.test.js):
  // two real child processes on one test machine can only ever reach each other over loopback,
  // which this guard otherwise always rejects. Reads ONLY process.env, set exclusively on the
  // child processes that test file spawns — never anything from config.json, so there is no way
  // for a deployed instance's own config to turn this on. MUST NEVER be set outside a test process.
  if (process.env.DISMESH_FEDERATION_ALLOW_LOOPBACK === '1') return true;
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  let hostname = parsed.hostname;

  // Strip brackets from IPv6 literals so net.isIP can properly identify them
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    hostname = hostname.slice(1, -1);
  }

  if (net.isIP(hostname)) return !isPrivateOrLoopback(hostname);
  if (hostname === 'localhost') return false;
  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    return false;
  }
  return addresses.length > 0 && addresses.every((a) => !isPrivateOrLoopback(a.address));
}

const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;

// DNS lookup used as the socket's own resolver, so the address that gets validated is the exact one
// that gets connected to. Checking at pairing time and then letting fetch() resolve again would let a
// peer's DNS answer public at pairing and loopback/internal later (DNS rebinding).
function pinnedLookup(hostname, options, callback) {
  const wantAll = options && options.all;
  dns.lookup(hostname, { all: true }).then((addresses) => {
    const safe = addresses.filter((a) => !isPrivateOrLoopback(a.address));
    if (safe.length === 0 || safe.length !== addresses.length) {
      callback(Object.assign(new Error('peer resolves to a non-public address'), { code: 'EBLOCKED' }));
      return;
    }
    if (wantAll) callback(null, safe.map((a) => ({ address: a.address, family: a.family })));
    else callback(null, safe[0].address, safe[0].family);
  }, callback);
}

// fetch() replacement for every outbound call to a peer: https only, no redirects, resolver pinned
// and validated at connect time, bounded response. Returns a standard Response so callers are
// unchanged. The loopback escape hatch is the same test-only env var isSafePeerUrl honors.
function safeFetch(url, { method = 'GET', headers = {}, body, signal } = {}) {
  const allowLoopback = process.env.DISMESH_FEDERATION_ALLOW_LOOPBACK === '1';
  let parsed;
  try { parsed = new URL(url); } catch { return Promise.reject(new TypeError('invalid URL')); }
  const secure = parsed.protocol === 'https:';
  if (!allowLoopback && !secure) return Promise.reject(new TypeError('peer URL must be https'));
  if (!secure && parsed.protocol !== 'http:') return Promise.reject(new TypeError('unsupported protocol'));
  const host = parsed.hostname.startsWith('[') ? parsed.hostname.slice(1, -1) : parsed.hostname;
  if (!allowLoopback && net.isIP(host) && isPrivateOrLoopback(host)) return Promise.reject(new Error('peer address is not public'));

  const transport = secure ? require('node:https') : require('node:http');
  return new Promise((resolve, reject) => {
    const req = transport.request(url, {
      method, headers, signal,
      ...(allowLoopback ? {} : { lookup: pinnedLookup }),
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_RESPONSE_BYTES) { req.destroy(new Error('peer response too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        const status = res.statusCode;
        const noBody = status === 204 || status === 205 || status === 304;
        resolve(new Response(noBody ? null : Buffer.concat(chunks), { status, headers: res.headers['content-type'] ? { 'content-type': res.headers['content-type'] } : {} }));
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

module.exports = { isSafePeerUrl, isPrivateOrLoopback, safeFetch, pinnedLookup };
