'use strict';

const dns = require('node:dns').promises;
const http = require('node:http');
const https = require('node:https');
const { db } = require('../db');
const { serializeMessage } = require('./messages');
const { isPrivateOrLoopback: isPrivateIp } = require('./federationSsrf');

const FETCH_TIMEOUT_MS = 5000;
const MAX_BYTES = 512 * 1024;

function extractFirstUrl(content) {
  const m = String(content || '').match(/https?:\/\/[^\s<>"')]+/i);
  if (!m) return null;
  return m[0].replace(/[.,!?)\]}'"]+$/, '');
}

// Never let the message-composer become a vector for hitting internal services. The host is
// resolved once, that address is checked, and the socket connects to exactly that address: letting
// the HTTP client resolve again would let a rebinding DNS answer swap in an internal one.
async function fetchHtml(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost') return null;

  const { address, family } = await dns.lookup(host);
  if (isPrivateIp(address)) return null;
  const lookup = (_hostname, options, callback) => (options && options.all
    ? callback(null, [{ address, family }])
    : callback(null, address, family));

  const transport = parsed.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(url, {
      agent: false,
      lookup,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'user-agent': 'MeshCrowd-LinkPreview/1.0' },
    }, (res) => {
      // Redirects are never followed: one would re-point at a host that skipped the check above.
      const contentType = res.headers['content-type'] || '';
      if (res.statusCode < 200 || res.statusCode >= 300 || !contentType.includes('text/html')) {
        req.destroy();
        resolve(null);
        return;
      }
      let html = '';
      let bytes = 0;
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        bytes += Buffer.byteLength(chunk);
        html += chunk;
        if (bytes >= MAX_BYTES || /<\/head>/i.test(html)) {
          resolve(html);
          req.destroy();
        }
      });
      res.on('error', reject);
      res.on('close', () => resolve(html));
    });
    req.on('error', reject);
    req.end();
  });
}

function decodeEntities(s) {
  if (!s) return s;
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");
}

function extractMeta(html, prop) {
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${prop}["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return decodeEntities(m[1]);
  }
  return null;
}

function extractTitleTag(html) {
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return m ? decodeEntities(m[1].trim()) : null;
}

async function fetchEmbed(url) {
  const html = await fetchHtml(url);
  if (!html) return null;

  const title = extractMeta(html, 'og:title') || extractTitleTag(html);
  const description = extractMeta(html, 'og:description') || extractMeta(html, 'description');
  const siteName = extractMeta(html, 'og:site_name');
  let image = extractMeta(html, 'og:image');
  if (image) {
    try { image = new URL(image, url).toString(); } catch { image = null; }
    if (image && !/^https:\/\//i.test(image) && !/^http:\/\//i.test(image)) image = null;
  }

  if (!title && !description && !image) return null;
  return {
    url,
    title: title ? title.slice(0, 200) : null,
    description: description ? description.slice(0, 400) : null,
    image: image || null,
    siteName: siteName ? siteName.slice(0, 100) : null,
  };
}

// Fire-and-forget from the message-create route: never awaited by the request handler, so a
// slow or hanging remote host can't delay the response — the embed just pops in via WS once
// (if ever) it resolves.
async function maybeFetchAndAttachEmbed(message, broadcast) {
  if (message.eventType || message.isEncrypted) return;
  const url = extractFirstUrl(message.content);
  if (!url) return;

  let embed = null;
  try { embed = await fetchEmbed(url); } catch { embed = null; }
  if (!embed) return;

  const stillExists = db.prepare('SELECT id FROM messages WHERE id = ?').get(message.id);
  if (!stillExists) return;

  db.prepare('UPDATE messages SET embed = ? WHERE id = ?').run(JSON.stringify(embed), message.id);
  const updated = serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(message.id));
  broadcast({ type: 'message_update', message: updated });
}

module.exports = { maybeFetchAndAttachEmbed, extractFirstUrl, fetchEmbed, isPrivateIp };
