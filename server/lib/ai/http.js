'use strict';

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { isPrivateOrLoopback, pinnedLookup } = require('../federationSsrf');

class AiHttpError extends Error {
  constructor(message) { super(message); this.name = 'AiHttpError'; }
}

function validateBaseUrl(raw) {
  let u;
  try { u = new URL(String(raw ?? '').trim()); } catch { throw new AiHttpError('invalid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new AiHttpError('URL must be http or https');
  if (!u.hostname) throw new AiHttpError('invalid URL');
  if (u.username || u.password) throw new AiHttpError('URL must not contain credentials');
  if (u.search || u.hash) throw new AiHttpError('URL must not contain a query or fragment');
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

const hostOf = (u) => (u.hostname.startsWith('[') ? u.hostname.slice(1, -1) : u.hostname);

// Resolves with the response stream. Redirects are never followed. With allowPrivate false the
// resolved address is pinned to a public one (same guard federation uses); site-tier providers
// are set by the site admin on purpose and may be on localhost, a LAN or a VPN.
function aiRequest(url, { method = 'GET', headers = {}, body, signal, allowPrivate = false } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { reject(new AiHttpError('invalid URL')); return; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') { reject(new AiHttpError('URL must be http or https')); return; }
    const host = hostOf(u);
    if (!allowPrivate && net.isIP(host) && isPrivateOrLoopback(host)) { reject(new AiHttpError('address is not public')); return; }
    const payload = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const transport = u.protocol === 'https:' ? https : http;
    const req = transport.request(u, {
      method,
      signal,
      headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}), ...headers },
      ...(allowPrivate ? {} : { lookup: pinnedLookup }),
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.destroy();
        reject(new AiHttpError('redirects are not followed'));
        return;
      }
      resolve(res);
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function readBody(res, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of res) {
    size += chunk.length;
    if (size > maxBytes) { res.destroy(); throw new AiHttpError('response too large'); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function* readLines(res, maxLine = 65536) {
  res.setEncoding('utf8');
  let buf = '';
  for await (const chunk of res) {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      yield line;
    }
    if (buf.length > maxLine) { res.destroy(); throw new AiHttpError('stream line too large'); }
  }
  if (buf) yield buf.replace(/\r$/, '');
}

module.exports = { AiHttpError, validateBaseUrl, aiRequest, readBody, readLines };
