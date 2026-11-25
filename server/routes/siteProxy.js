'use strict';

const express = require('express');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { db } = require('../db');
const siteFiles = require('../lib/siteFiles');
const siteProcesses = require('../lib/siteProcesses');
const siteViewToken = require('../lib/siteViewToken');
const { buildSiteCsp, SANDBOX } = require('../lib/siteCsp');
const siteStorage = require('../lib/siteStorage');
const { rewriteHtml, rewriteCss, rewriteLocation, shimTags, LOADER_JS } = require('../lib/siteRewrite');

const ASSET_DIR = path.join(__dirname, '..', 'assets');
const assetCache = new Map();
const asset = (name) => {
  if (!assetCache.has(name)) assetCache.set(name, fs.readFileSync(path.join(ASSET_DIR, name), 'utf8'));
  return assetCache.get(name);
};

const MAX_REQ_BODY = 1024 * 1024;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const FORWARD_REQ = ['accept', 'accept-language', 'content-type', 'content-length', 'user-agent'];
const MAX_STORAGE_BODY = 64 * 1024 * 1024;
const STRIP_RES = new Set(['access-control-allow-origin', 'access-control-allow-credentials', 'set-cookie', 'content-security-policy', 'x-frame-options', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']);

const plain = (res, status, text) => res.status(status).type('text').send(text);

// ctx: { siteId, userId, trusted }. An untrusted page gets the storage shims; a trusted one runs in the app origin with the real APIs.
function pageHtml(html, prefix, ctx) {
  if (ctx.trusted) return rewriteHtml(html, prefix);
  return rewriteHtml(html, prefix, shimTags(prefix, siteStorage.snapshot(ctx.siteId, ctx.userId), html));
}

function serveStatic(req, res, target, prefix, ctx) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return plain(res, 405, 'Method not allowed');
  if (target.ext === 'html' || target.ext === 'htm' || target.ext === 'css') {
    return fs.readFile(target.abs, 'utf8', (err, text) => {
      if (err) return plain(res, 404, 'Not found');
      if (target.ext === 'css') return res.type('css').send(rewriteCss(text, prefix));
      return res.type('html').send(pageHtml(text, prefix, ctx));
    });
  }
  return res.sendFile(target.abs, { dotfiles: 'deny' }, (err) => { if (err && !res.headersSent) plain(res, 404, 'Not found'); });
}

async function proxyPhp(req, res, siteId, target, prefix, ctx) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_REQ_BODY) return plain(res, 413, 'Request body too large');
  let lease;
  try {
    lease = await siteProcesses.acquire(siteId);
  } catch (e) {
    if (e.retryAfter) res.setHeader('Retry-After', String(e.retryAfter));
    return plain(res, e.status || 503, `This site is unavailable: ${e.message}`);
  }
  // 'close' fires when the response finishes or the client goes away, so the worker is always freed.
  res.once('close', lease.release);
  const { port } = lease;

  const q = req.originalUrl.indexOf('?');
  const search = q === -1 ? '' : req.originalUrl.slice(q);
  const upPath = `/${target.rel.split('/').map(encodeURIComponent).join('/')}${search}`;
  const headers = { host: `127.0.0.1:${port}`, 'accept-encoding': 'identity' };
  for (const h of FORWARD_REQ) if (req.headers[h]) headers[h] = req.headers[h];
  const reqPath = `/${target.rel}`;
  const viewerCookies = siteStorage.cookieHeader(siteId, ctx.userId, reqPath);
  if (viewerCookies) headers.cookie = viewerCookies;

  const up = http.request({ host: '127.0.0.1', port, method: req.method, path: upPath, headers, timeout: 20_000 }, (ur) => {
    siteStorage.applySetCookies(siteId, ctx.userId, ur.headers['set-cookie'], reqPath);
    const out = {};
    for (const [k, v] of Object.entries(ur.headers)) if (!STRIP_RES.has(k)) out[k] = v;
    if (out.location) out.location = rewriteLocation(String(out.location), prefix);
    if (!/^text\/html/i.test(String(ur.headers['content-type'] || ''))) {
      res.writeHead(ur.statusCode, out);
      return ur.pipe(res);
    }
    const chunks = [];
    let size = 0;
    ur.on('data', (c) => {
      size += c.length;
      if (size > MAX_HTML_BYTES) { ur.destroy(); if (!res.headersSent) plain(res, 502, 'Response too large'); } else chunks.push(c);
    });
    ur.on('end', () => {
      if (res.headersSent) return;
      const html = pageHtml(Buffer.concat(chunks).toString('utf8'), prefix, ctx);
      out['content-length'] = Buffer.byteLength(html);
      res.writeHead(ur.statusCode, out);
      res.end(html);
    });
  });
  up.on('timeout', () => up.destroy(new Error('timeout')));
  up.on('error', () => { if (!res.headersSent) plain(res, 502, 'The site did not respond.'); else res.destroy(); });

  if (req.method === 'GET' || req.method === 'HEAD') return up.end();
  let n = 0;
  req.on('data', (c) => { n += c.length; if (n > MAX_REQ_BODY) { up.destroy(); req.destroy(); } });
  req.pipe(up);
}

// The shims' persistence calls. Bodies are text/plain JSON so the page's fetch needs no CORS preflight.
function storageEndpoint(req, res, rel, ctx) {
  const idb = rel === '__idb';
  if (req.method === 'GET' && idb) {
    const text = siteStorage.getIdb(ctx.siteId, ctx.userId);
    if (text === null) return res.status(204).end();
    return res.type('text/plain').send(text);
  }
  if (req.method !== 'POST') return plain(res, 405, 'Method not allowed');
  const limit = idb ? siteStorage.LIMITS.maxIdbBytes + 1024 : MAX_STORAGE_BODY;
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > limit) return plain(res, 413, 'Request body too large');
  return express.text({ type: () => true, limit })(req, res, (err) => {
    if (err) return plain(res, err.status || 400, 'Bad request');
    try {
      const body = typeof req.body === 'string' ? req.body : '';
      if (idb) siteStorage.putIdb(ctx.siteId, ctx.userId, body);
      else {
        let ops;
        try { ops = JSON.parse(body); } catch { throw new siteStorage.StorageError(400, 'bad json'); }
        siteStorage.applyOps(ctx.siteId, ctx.userId, ops);
      }
      return res.status(204).end();
    } catch (e) {
      if (e instanceof siteStorage.StorageError) return plain(res, e.status, e.message);
      throw e;
    }
  });
}

function createRouter() {
  const router = express.Router();

  router.all('/:id', (req, res, next) => {
    const url = req.originalUrl;
    const q = url.indexOf('?');
    const pathOnly = q === -1 ? url : url.slice(0, q);
    if (pathOnly.endsWith('/')) return next();
    res.redirect(302, `${pathOnly}/${q === -1 ? '' : url.slice(q)}`);
  });

  router.all('/:id/*', async (req, res) => {
    // Even the error pages must be frameable by the app, or the iframe shows a browser "refused to connect" page.
    res.removeHeader('X-Frame-Options');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Content-Security-Policy', `${SANDBOX}; default-src 'none'; frame-ancestors 'self'`);
    // The page runs in an opaque origin, so its own fetch/XHR to this server is cross-origin and needs CORS to
    // read the answer. Safe: no cookie is ever accepted here, the path token is the only credential.
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE');
      res.setHeader('Access-Control-Allow-Headers', String(req.headers['access-control-request-headers'] || 'content-type').slice(0, 500));
      res.setHeader('Access-Control-Max-Age', '600');
      return res.status(204).end();
    }
    const site = db.prepare("SELECT id, site_csp_origins, site_trusted FROM servers WHERE id = ? AND kind = 'site'").get(Number(req.params.id));
    if (!site) return plain(res, 404, 'Not found');
    // The app session cookie is deliberately ignored here: access is the per-site token in the path.
    const first = (req.params[0] || '').split('/')[0];
    const viewer = first.startsWith('~') ? siteViewToken.verify(first.slice(1), site.id) : null;
    if (!viewer) return plain(res, 401, 'Open this site from inside MeshCrowd.');
    const member = db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(site.id, viewer.userId);
    if (!member) return plain(res, 403, 'You are not a member of this site.');

    let origins = [];
    try { origins = JSON.parse(site.site_csp_origins); } catch { /* keep none */ }
    const trusted = !!site.site_trusted;
    res.setHeader('Content-Security-Policy', buildSiteCsp(origins, { trusted }));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-cache');

    const prefix = `/site/${site.id}/${first}`;
    const rel = (req.params[0] || '').slice(first.length + 1);
    if (req.params[0] === first) { const q = req.originalUrl.indexOf('?'); return res.redirect(302, `${prefix}/${q === -1 ? '' : req.originalUrl.slice(q)}`); }
    if (rel === '__site.js') return res.type('application/javascript').send(LOADER_JS);
    if (rel === '__shim.js' || rel === '__idb.js') return res.type('application/javascript').send(asset(rel === '__shim.js' ? 'site-shim.js' : 'site-idb.js'));
    const ctx = { siteId: site.id, userId: viewer.userId, trusted };
    if (rel === '__storage' || rel === '__idb') return storageEndpoint(req, res, rel, ctx);

    const target = siteFiles.resolveServeTarget(site.id, rel);
    if (!target) return plain(res, 404, 'Not found');
    const pathOnly = req.originalUrl.split('?')[0];
    if (target.viaDir && !pathOnly.endsWith('/')) {
      const q = req.originalUrl.indexOf('?');
      return res.redirect(302, `${pathOnly}/${q === -1 ? '' : req.originalUrl.slice(q)}`);
    }
    if (target.kind === 'static') return serveStatic(req, res, target, prefix, ctx);
    return proxyPhp(req, res, site.id, target, prefix, ctx);
  });

  return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
