'use strict';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function rewriteRootAbsolute(html, prefix) {
  const skip = escapeRe(prefix.slice(1));
  const re = new RegExp(`(\\s(?:href|src|action|poster)\\s*=\\s*)(["'])\\/(?!\\/|${skip}\\/)`, 'gi');
  return html.replace(re, (m, attr, quote) => `${attr}${quote}${prefix}/`);
}

function rewriteCss(css, prefix) {
  const skip = escapeRe(prefix.slice(1));
  const re = new RegExp(`url\\(\\s*(["']?)\\/(?!\\/|${skip}\\/)`, 'gi');
  return css.replace(re, (m, quote) => `url(${quote}${prefix}/`);
}

function rewriteLocation(loc, prefix) {
  if (loc.startsWith('/') && !loc.startsWith('//') && !loc.startsWith(`${prefix}/`)) return `${prefix}${loc}`;
  return loc;
}

function injectLoader(html, prefix) {
  const tag = `<script src="${prefix}/__site.js"></script>`;
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + tag + html.slice(at);
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) return html.slice(0, doctype[0].length) + tag + html.slice(doctype[0].length);
  return tag + html;
}

function rewriteHtml(html, prefix) {
  return injectLoader(rewriteCss(rewriteRootAbsolute(html, prefix), prefix), prefix);
}

// Runs inside the Site iframe. Anything that would leave the Site (other origin, target=_blank,
// window.open) is handed to the parent app, which opens it in the OS browser / a new tab.
const LOADER_JS = `(function () {
  var here = location.origin;
  function external(u) { try { return new URL(u, location.href).origin !== here; } catch (e) { return false; } }
  function send(u) { try { parent.postMessage({ type: 'site-open-external', url: new URL(u, location.href).href }, here); } catch (e) {} }
  function anchorOf(e) { return e.target && e.target.closest ? e.target.closest('a[href]') : null; }
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented) return;
    var a = anchorOf(e);
    if (!a) return;
    if (a.target === '_blank' || external(a.href)) { e.preventDefault(); send(a.href); }
  }, true);
  document.addEventListener('auxclick', function (e) {
    if (e.button !== 1) return;
    var a = anchorOf(e);
    if (a) { e.preventDefault(); send(a.href); }
  }, true);
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (!f || f.tagName !== 'FORM') return;
    var action = f.action || location.href;
    if (f.target === '_blank' || external(action)) { e.preventDefault(); send(action); }
  }, true);
  window.open = function (u) { if (u) send(u); return null; };
})();`;

module.exports = { rewriteHtml, rewriteCss, rewriteLocation, LOADER_JS };
