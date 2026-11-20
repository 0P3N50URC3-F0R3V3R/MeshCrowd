/* Runs in Site pages before any site script. The page is in an opaque origin, so the browser's own
   localStorage, sessionStorage and document.cookie throw; these stand-ins read a snapshot embedded at
   serve time (window.__mcSite) and write back through the token-authed /__storage endpoint. */
(function () {
  'use strict';
  var S = window.__mcSite;
  if (!S) return;
  var P = S.p;
  var ENDPOINT = P + '/__storage';
  var QUOTA = 1000000;

  var queue = [];
  var timer = 0;
  var chain = Promise.resolve();
  function send(ops, keepalive) {
    var body = JSON.stringify(ops);
    return fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: body, keepalive: keepalive && body.length < 60000 })
      .then(function (r) { if (r.status === 413 || r.status === 429) console.warn('Site storage write rejected: ' + r.status); })
      .catch(function () {});
  }
  function flush(keepalive) {
    timer = 0;
    if (!queue.length) return;
    var ops = queue;
    queue = [];
    if (keepalive) { send(ops, true); return; }
    chain = chain.then(function () { return send(ops, false); });
  }
  function enqueue(op) {
    queue.push(op);
    if (queue.length >= 100) flush(false);
    else if (!timer) timer = setTimeout(flush, 0);
  }
  addEventListener('pagehide', function () { flush(true); });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flush(true); });

  function quotaError() { return new DOMException("Failed to execute 'setItem' on 'Storage': Setting the value exceeded the quota.", 'QuotaExceededError'); }

  function makeStorage(init, onSet, onRemove, onClear) {
    var d = Object.create(null);
    var bytes = 0;
    var k;
    if (init) for (k in init) { d[k] = init[k]; bytes += k.length + init[k].length; }
    var api = {
      getItem: function (key) { key = String(key); return key in d ? d[key] : null; },
      setItem: function (key, value) {
        key = String(key); value = String(value);
        var old = key in d ? key.length + d[key].length : 0;
        if (bytes - old + key.length + value.length > QUOTA) throw quotaError();
        bytes += key.length + value.length - old;
        d[key] = value;
        onSet(key, value);
      },
      removeItem: function (key) {
        key = String(key);
        if (!(key in d)) return;
        bytes -= key.length + d[key].length;
        delete d[key];
        onRemove(key);
      },
      clear: function () { d = Object.create(null); bytes = 0; onClear(); },
      key: function (i) { var ks = Object.keys(d); return i >= 0 && i < ks.length ? ks[i] : null; },
    };
    var proto = (typeof Storage !== 'undefined' && Storage.prototype) || Object.prototype;
    return new Proxy(Object.create(proto), {
      get: function (t, p) {
        if (p === 'length') return Object.keys(d).length;
        if (typeof p === 'symbol') return p === Symbol.toStringTag ? 'Storage' : undefined;
        if (Object.prototype.hasOwnProperty.call(api, p)) return api[p];
        return p in d ? d[p] : undefined;
      },
      set: function (t, p, v) { if (typeof p !== 'symbol') api.setItem(p, v); return true; },
      deleteProperty: function (t, p) { if (typeof p !== 'symbol') api.removeItem(p); return true; },
      has: function (t, p) { return typeof p === 'string' && (p in d || Object.prototype.hasOwnProperty.call(api, p) || p === 'length'); },
      ownKeys: function () { return Object.keys(d); },
      getOwnPropertyDescriptor: function (t, p) {
        if (typeof p === 'string' && p in d) return { value: d[p], writable: true, enumerable: true, configurable: true };
        return undefined;
      },
    });
  }

  var local = makeStorage(S.l,
    function (key, value) { enqueue({ t: 'set', k: key, v: value }); },
    function (key) { enqueue({ t: 'del', k: key }); },
    function () { enqueue({ t: 'clear' }); });

  // sessionStorage lives in window.name so it survives navigation inside this tab (and only there); a page
  // that uses window.name itself just gets a per-page-load store.
  var NAME = '__mcss:';
  var ssInit = null;
  try { if (window.name.indexOf(NAME) === 0) ssInit = JSON.parse(window.name.slice(NAME.length)); } catch (e) { ssInit = null; }
  var canPersist = window.name === '' || window.name.indexOf(NAME) === 0;
  var ssData = ssInit && typeof ssInit === 'object' ? ssInit : {};
  var ss;
  function saveSession() {
    if (!canPersist) return;
    var o = {};
    for (var i = 0; ; i++) { var k = ss.key(i); if (k === null) break; o[k] = ss.getItem(k); }
    try { window.name = NAME + JSON.stringify(o); } catch (e) { /* ignore */ }
  }
  ss = makeStorage(ssData, saveSession, saveSession, saveSession);

  var cookies = (S.c || []).slice();
  function relPath() { var p = location.pathname; return p.indexOf(P) === 0 ? (p.slice(P.length) || '/') : '/'; }
  function pathMatches(cp, rp) { return rp === cp || rp.indexOf(cp.charAt(cp.length - 1) === '/' ? cp : cp + '/') === 0; }
  function getCookie() {
    var now = Date.now(), rp = relPath();
    return cookies.filter(function (c) { return (c.e == null || c.e > now) && pathMatches(c.p, rp); })
      .sort(function (a, b) { return b.p.length - a.p.length; })
      .map(function (c) { return c.n + '=' + c.v; }).join('; ');
  }
  function setCookie(str) {
    var parts = String(str).split(';');
    var eq = parts[0].indexOf('=');
    if (eq < 1) return;
    var name = parts[0].slice(0, eq).trim();
    var value = parts[0].slice(eq + 1).trim();
    if (!name || /[\s;,]/.test(name)) return;
    var rp = relPath();
    var path = rp.slice(0, rp.lastIndexOf('/') + 1) || '/';
    var expires = null;
    for (var i = 1; i < parts.length; i++) {
      var j = parts[i].indexOf('=');
      var k = (j === -1 ? parts[i] : parts[i].slice(0, j)).trim().toLowerCase();
      var v = j === -1 ? '' : parts[i].slice(j + 1).trim();
      if (k === 'path' && v.charAt(0) === '/') path = v;
      else if (k === 'max-age' && /^-?\d+$/.test(v)) expires = Date.now() + Number(v) * 1000;
      else if (k === 'expires' && expires === null) { var t = Date.parse(v); if (!isNaN(t)) expires = t; }
    }
    cookies = cookies.filter(function (c) { return !(c.n === name && c.p === path); });
    if (expires !== null && expires <= Date.now()) { enqueue({ t: 'cdel', n: name, p: path }); return; }
    if (value.length > 4096 || cookies.length >= 60) return;
    cookies.push({ n: name, v: value, p: path, e: expires });
    enqueue({ t: 'cset', n: name, v: value, p: path, e: expires });
  }

  function def(o, n, get, set) {
    try { Object.defineProperty(o, n, { configurable: true, enumerable: true, get: get, set: set }); } catch (e) { /* keep the native one */ }
  }
  def(window, 'localStorage', function () { return local; });
  def(window, 'sessionStorage', function () { return ss; });
  def(document, 'cookie', getCookie, setCookie);
})();
