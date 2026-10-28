'use strict';

const crypto = require('node:crypto');

const IMPORTMAP_RE = /<script\s+type=["']importmap["'][^>]*>([\s\S]*?)<\/script>/i;

function buildCsp(indexHtml) {
  const scriptSrc = ["'self'", "'wasm-unsafe-eval'"];
  const m = IMPORTMAP_RE.exec(indexHtml);
  // Browsers hash the parsed text, and HTML parsing normalizes CRLF/CR to LF — so must we (web/index.html may be CRLF on disk).
  if (m) scriptSrc.push(`'sha256-${crypto.createHash('sha256').update(m[1].replace(/\r\n?/g, '\n'), 'utf8').digest('base64')}'`);
  return `default-src 'self'; script-src ${scriptSrc.join(' ')}; style-src 'self' 'unsafe-inline'; ` +
    "img-src 'self' data: blob:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
}

module.exports = { buildCsp };
