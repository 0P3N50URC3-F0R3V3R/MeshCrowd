'use strict';

// Finds this machine's public IPv4 for the built-in TURN server, preferring sources the operator
// controls over third-party ones:
//   upnp - asks the router itself (UPnP Internet Gateway Device, GetExternalIPAddress); no data leaves the LAN
//   stun - asks a STUN server the operator names (their own, their ISP's, or any public one)
//   http - fetches a URL the operator names and takes the first public IPv4 in the reply
//          (a router status page, a small script on their own host, ...)

const dgram = require('node:dgram');
const http = require('node:http');
const https = require('node:https');
const { TurnClient } = require('./client');
const { isPrivate } = require('./server');

const isIpv4 = (s) => /^(\d{1,3})(\.\d{1,3}){3}$/.test(s) && s.split('.').every((n) => Number(n) <= 255);
const isPublicIpv4 = (s) => isIpv4(s) && !isPrivate(s) && !s.startsWith('0.');

const SEARCH_TARGETS = [
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
];

function ssdpDiscover(timeoutMs) {
  return new Promise((resolve) => {
    const found = new Set();
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const done = () => { try { sock.close(); } catch { /* closed */ } resolve([...found]); };
    const timer = setTimeout(done, timeoutMs);
    sock.on('error', () => { clearTimeout(timer); done(); });
    sock.on('message', (buf) => {
      const m = /^location:\s*(\S+)/im.exec(buf.toString('utf8'));
      if (m) found.add(m[1]);
    });
    sock.bind(0, () => {
      for (const st of SEARCH_TARGETS) {
        const msg = Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: ${st}\r\n\r\n`);
        sock.send(msg, 1900, '239.255.255.250', () => {});
      }
    });
  });
}

function request(url, { method = 'GET', headers = {}, body, timeoutMs = 3000, maxBytes = 1 << 20 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { reject(new Error('invalid URL')); return; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') { reject(new Error('URL must be http or https')); return; }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method, headers, timeout: timeoutMs, rejectUnauthorized: false }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { size += c.length; if (size > maxBytes) req.destroy(new Error('response too large')); else chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const WAN_SERVICE_RE = /<serviceType>\s*(urn:[^<]*:service:WAN(?:IP|PPP)Connection:\d+)\s*<\/serviceType>[\s\S]*?<controlURL>\s*([^<]+?)\s*<\/controlURL>/gi;

// Reads the device description at `loc` and asks its WAN connection service for the external address.
async function igdExternalIp(loc, { timeoutMs = 2500 } = {}) {
  const desc = await request(loc, { timeoutMs });
  for (const m of desc.body.matchAll(WAN_SERVICE_RE)) {
    const [, serviceType, controlUrl] = m;
    const url = new URL(controlUrl, loc).toString();
    const soap = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:GetExternalIPAddress xmlns:u="${serviceType}"/></s:Body></s:Envelope>`;
    const res = await request(url, {
      method: 'POST',
      headers: { 'content-type': 'text/xml; charset="utf-8"', soapaction: `"${serviceType}#GetExternalIPAddress"`, 'content-length': Buffer.byteLength(soap) },
      body: soap,
      timeoutMs,
    });
    const ip = /<NewExternalIPAddress>\s*([\d.]+)\s*<\/NewExternalIPAddress>/i.exec(res.body)?.[1];
    if (ip) return ip;
  }
  throw new Error('no WAN connection service in the device description');
}

async function upnpExternalIp({ timeoutMs = 2500 } = {}) {
  const locations = await ssdpDiscover(timeoutMs);
  if (!locations.length) throw new Error('no UPnP router answered (is UPnP enabled on the router?)');
  let lastErr = null;
  for (const loc of locations) {
    try { return await igdExternalIp(loc, { timeoutMs }); } catch (err) { lastErr = err; }
  }
  throw new Error(`router did not report an address (${lastErr.message})`);
}

async function stunExternalIp(server, { timeoutMs = 2500 } = {}) {
  const m = /^([^:\s]+)(?::(\d{1,5}))?$/.exec(String(server || '').trim());
  if (!m) throw new Error('STUN server must be host or host:port');
  const cl = new TurnClient({ host: m[1], port: Number(m[2] || 3478), timeoutMs });
  try {
    const me = await cl.binding();
    if (!me?.ip) throw new Error('STUN server gave no address');
    return me.ip;
  } finally { cl.close(); }
}

async function httpExternalIp(url, { timeoutMs = 3000 } = {}) {
  if (!url) throw new Error('no URL configured');
  const res = await request(url, { timeoutMs, maxBytes: 256 * 1024 });
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
  const ip = [...res.body.matchAll(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/g)].map((m) => m[1]).find(isPublicIpv4);
  if (!ip) throw new Error('no public IPv4 address found in the reply');
  return ip;
}

// Returns { ip } or throws. The result must be a public address: a private or CGNAT one means the
// router itself sits behind another NAT, and relaying would not work with it.
async function detectWanIp(turnCfg, opts) {
  const source = turnCfg.autoIpSource;
  let ip;
  if (source === 'upnp') ip = await upnpExternalIp(opts);
  else if (source === 'stun') ip = await stunExternalIp(turnCfg.autoIpStun, opts);
  else if (source === 'http') ip = await httpExternalIp(turnCfg.autoIpUrl, opts);
  else throw new Error(`unknown source "${source}"`);
  if (!isIpv4(ip)) throw new Error(`"${ip}" is not an IPv4 address`);
  if (!isPublicIpv4(ip)) throw new Error(`${ip} is not a public address (the router may be behind another NAT)`);
  return ip;
}

module.exports = { detectWanIp, upnpExternalIp, igdExternalIp, stunExternalIp, httpExternalIp, isPublicIpv4, isIpv4 };
