'use strict';

const express = require('express');
const http = require('node:http');
const fs = require('node:fs');
const { db } = require('../db');
const { attachUser: realAttachUser } = require('../middleware/auth');
const siteFiles = require('../lib/siteFiles');
const siteProcesses = require('../lib/siteProcesses');
const { buildSiteCsp } = require('../lib/siteCsp');
const { rewriteHtml, rewriteCss, rewriteLocation, LOADER_JS } = require('../lib/siteRewrite');

const MAX_REQ_BODY = 1024 * 1024;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const FORWARD_REQ = ['accept', 'accept-language', 'content-type', 'content-length', 'user-agent'];
const STRIP_RES = new Set(['set-cookie', 'content-security-policy', 'x-frame-options', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']);

const plain = (res, status, text) => res.status(status).type('text').send(text);

function serveStatic(req, res, target, prefix) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return plain(res, 405, 'Method not allowed');
  if (target.ext === 'html' || target.ext === 'htm' || target.ext === 'css') {
    return fs.readFile(target.abs, 'utf8', (err, text) => {
      if (err) return plain(res, 404, 'Not found');
      if (target.ext === 'css') return res.type('css').send(rewriteCss(text, prefix));
      return res.type('html').send(rewriteHtml(text, prefix));
    });
  }
  return res.sendFile(target.abs, { dotfiles: 'deny' }, (err) => { if (err && !res.headersSent) plain(res, 404, 'Not found'); });
}

async function proxyPhp(req, res, siteId, target, prefix) {
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

  const up = http.request({ host: '127.0.0.1', port, method: req.method, path: upPath, headers, timeout: 20_000 }, (ur) => {
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
      const html = rewriteHtml(Buffer.concat(chunks).toString('utf8'), prefix);
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

function createRouter({ attachUser = realAttachUser } = {}) {
  const router = express.Router();
  router.use(attachUser);

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
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'self'");
    const site = db.prepare("SELECT id, site_csp_origins FROM servers WHERE id = ? AND kind = 'site'").get(Number(req.params.id));
    if (!site) return plain(res, 404, 'Not found');
    if (!req.user) return plain(res, 401, 'Sign in to MeshCrowd to view this site.');
    const member = db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(site.id, req.user.id);
    if (!member) return plain(res, 403, 'You are not a member of this site.');

    let origins = [];
    try { origins = JSON.parse(site.site_csp_origins); } catch { /* keep none */ }
    res.setHeader('Content-Security-Policy', buildSiteCsp(origins));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-cache');

    const prefix = `/site/${site.id}`;
    const rel = req.params[0] || '';
    if (rel === '__site.js') return res.type('application/javascript').send(LOADER_JS);

    const target = siteFiles.resolveServeTarget(site.id, rel);
    if (!target) return plain(res, 404, 'Not found');
    const pathOnly = req.originalUrl.split('?')[0];
    if (target.viaDir && !pathOnly.endsWith('/')) {
      const q = req.originalUrl.indexOf('?');
      return res.redirect(302, `${pathOnly}/${q === -1 ? '' : req.originalUrl.slice(q)}`);
    }
    if (target.kind === 'static') return serveStatic(req, res, target, prefix);
    return proxyPhp(req, res, site.id, target, prefix);
  });

  return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
