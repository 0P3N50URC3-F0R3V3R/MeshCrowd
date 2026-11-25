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

function injectLoader(html, prefix, extra = '') {
  const tag = `${extra}<script src="${prefix}/__site.js"></script>`;
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + tag + html.slice(at);
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) return html.slice(0, doctype[0].length) + tag + html.slice(doctype[0].length);
  return tag + html;
}

function rewriteHtml(html, prefix, extra = '') {
  return injectLoader(rewriteCss(rewriteRootAbsolute(html, prefix), prefix), prefix, extra);
}

// Head tags for an untrusted (opaque origin) page: the viewer's storage snapshot as data, then the storage
// shim, then (only when the page has any script at all) the IndexedDB shim. All of it runs before site code.
// '<' would let site data close the script tag; U+2028/2029 break JS string literals in old engines.
const UNSAFE_IN_SCRIPT = new RegExp('[<' + String.fromCharCode(0x2028, 0x2029) + ']', 'g');

function shimTags(prefix, snap, html) {
  const data = JSON.stringify({ p: prefix, l: snap.local, c: snap.cookies, idb: snap.idb, q: snap.quota, iq: snap.idbQuota })
    .replace(UNSAFE_IN_SCRIPT, (c) => String.fromCharCode(92) + 'u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  const idb = /<script[\s>]/i.test(html) ? `<script src="${prefix}/__idb.js"></script>` : '';
  return `<script>window.__mcSite=${data}</script><script src="${prefix}/__shim.js"></script>${idb}`;
}

// Runs inside the Site iframe (opaque origin: location.origin is "null", so the host is compared).
// Anything that would leave the Site (other origin, target=_blank,
// window.open) is handed to the parent app, which opens it in the OS browser / a new tab.
const LOADER_JS = `(function () {
  var here = location.protocol + '//' + location.host;
  function external(u) { try { var x = new URL(u, location.href); return x.protocol + '//' + x.host !== here; } catch (e) { return false; } }
  function send(u) { try { parent.postMessage({ type: 'site-open-external', url: new URL(u, location.href).href }, '*'); } catch (e) {} }
  window.addEventListener('message', function (e) {
    if (e.source !== parent || !e.data) return;
    if (e.data.type === 'site-nav-back') history.back();
    else if (e.data.type === 'site-nav-reload') location.reload();
  });
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

module.exports = { shimTags, rewriteHtml, rewriteCss, rewriteLocation, LOADER_JS };
