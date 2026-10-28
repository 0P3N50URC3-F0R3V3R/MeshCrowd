// Pure helpers for the Site editor's visual view. No DOM access except the default parser of
// canonicalHtml, so everything else is unit-tested under node.

const PHP_BLOCK_RE = /<\?[\s\S]*?(?:\?>|$)/g;
const TOKEN_RE = /__PHPBLK_(\d+)__/g;
const CHIP_RE = /<span\b[^>]*\bdata-php="(\d+)"[^>]*>[\s\S]*?<\/span>/g;
const OPAQUE_RE = /(<!--[\s\S]*?-->|<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<[^>]*>)/gi;

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function tokenizePhp(src) {
  const blocks = [];
  const text = src.replace(PHP_BLOCK_RE, (m) => { blocks.push(m); return `__PHPBLK_${blocks.length - 1}__`; });
  return { text, blocks };
}

export function protectPhp(body) {
  const { text, blocks } = tokenizePhp(body);
  const html = text.split(OPAQUE_RE).map((part, i) => {
    if (i % 2 === 1) return part; // tags, comments, script and style keep plain tokens
    return part.replace(TOKEN_RE, (m, n) => {
      const label = escapeHtml(blocks[Number(n)].replace(/\s+/g, ' ').slice(0, 32));
      return `<span class="php-ph" contenteditable="false" data-php="${n}" title="PHP">${label}</span>`;
    });
  }).join('');
  return { html, blocks };
}

export function restorePhp(html, blocks) {
  return html
    .replace(CHIP_RE, (m, n) => blocks[Number(n)] ?? m)
    .replace(TOKEN_RE, (m, n) => blocks[Number(n)] ?? m);
}

export function splitDocument(src) {
  const { text, blocks } = tokenizePhp(src);
  const open = /<body\b[^>]*>/i.exec(text);
  if (!open) return { prefix: '', body: src, suffix: '' };
  const start = open.index + open[0].length;
  const closeIdx = text.toLowerCase().lastIndexOf('</body>');
  const back = (s) => restorePhp(s, blocks);
  if (closeIdx < start) return { prefix: back(text.slice(0, start)), body: back(text.slice(start)), suffix: '' };
  return { prefix: back(text.slice(0, start)), body: back(text.slice(start, closeIdx)), suffix: back(text.slice(closeIdx)) };
}

export const joinDocument = ({ prefix, body, suffix }) => prefix + body + suffix;

export function relativeAsset(fromFile, assetPath) {
  const from = fromFile.split('/').slice(0, -1);
  const to = assetPath.split('/');
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
  return [...from.slice(i).map(() => '..'), ...to.slice(i)].join('/');
}

export const isVisualCandidate = (path) => /\.(html?|php)$/i.test(path);

export function modeForPath(path) {
  const ext = (path.split('.').pop() || '').toLowerCase();
  if (ext === 'php') return 'application/x-httpd-php';
  if (ext === 'html' || ext === 'htm') return 'htmlmixed';
  if (ext === 'js') return 'javascript';
  if (ext === 'json') return { name: 'javascript', json: true };
  if (ext === 'css') return 'css';
  if (ext === 'svg') return 'xml';
  return 'text/plain';
}

const domParse = (h) => new DOMParser().parseFromString(`<!doctype html><body>${h}`, 'text/html').body.innerHTML;

export function canonicalHtml(html, parse = domParse) {
  return parse(html).replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim();
}
