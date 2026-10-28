/* MeshCrowd project site: shared header, footer, wiki chrome and small effects. No dependencies. */
(function () {
  'use strict';
  var doc = document;
  var root = doc.body.getAttribute('data-root') || '.';
  var page = doc.body.getAttribute('data-page') || '';
  var isWiki = doc.body.hasAttribute('data-wiki');
  var lang = doc.documentElement.lang === 'hu' ? 'hu' : 'en';
  var linkBase = doc.body.getAttribute('data-base') || root; // where this language's pages live
  var STR = {
    en: {
      nav: ['Home', 'Features', 'Gallery', 'Download', 'Wiki', 'About'],
      download: 'Download', menu: 'Menu', themeGroup: 'Site color theme', langGroup: 'Language',
      fTag: 'Self-hosted chat, voice and video for communities that want to own their data. Free software under the GNU General Public License.',
      fProject: 'Project', fDocs: 'Documentation', fLegal: 'Legal',
      fWikiHome: 'Wiki home', fStart: 'Getting started', fBots: 'Bots &amp; API', fTrouble: 'Troubleshooting',
      fLicense: 'GNU GPL licence', fFull: 'Full licence text', fSecurity: 'Security model', fSource: 'Source code',
      fCopy: '&copy; MeshCrowd contributors. Licensed under the GNU GPL.',
      fBuilt: 'Built together with Claude, an AI model by Anthropic.', fHow: 'How',
      copy: 'Copy', copied: 'Copied', forYou: 'For your device', close: 'Close', preview: 'Image preview',
      search: 'Search the wiki', noMatch: 'No matches for', anchor: 'Link to this section', prev: 'Previous', next: 'Next'
    },
    hu: {
      nav: ['Kezdőlap', 'Funkciók', 'Galéria', 'Letöltés', 'Wiki', 'Rólunk'],
      download: 'Letöltés', menu: 'Menü', themeGroup: 'Az oldal színtémája', langGroup: 'Nyelv',
      fTag: 'Saját üzemeltetésű chat, hang és videó azoknak a közösségeknek, amelyek maguk akarják birtokolni az adataikat. Szabad szoftver a GNU General Public License alatt.',
      fProject: 'Projekt', fDocs: 'Dokumentáció', fLegal: 'Jogi',
      fWikiHome: 'Wiki főoldal', fStart: 'Első lépések', fBots: 'Botok és API', fTrouble: 'Hibaelhárítás',
      fLicense: 'GNU GPL licenc', fFull: 'A licenc teljes szövege', fSecurity: 'Biztonsági modell', fSource: 'Forráskód',
      fCopy: '&copy; A MeshCrowd közreműködői. A GNU GPL licenc alatt.',
      fBuilt: 'Claude-dal, az Anthropic MI-modelljével közösen készült.', fHow: 'Hogyan',
      copy: 'Másolás', copied: 'Másolva', forYou: 'A te eszközödre', close: 'Bezárás', preview: 'Képelőnézet',
      search: 'Keresés a wikiben', noMatch: 'Nincs találat erre:', anchor: 'Link erre a szakaszra', prev: 'Előző', next: 'Következő'
    }
  };
  var S = STR[lang];
  var isWikiPage = isWiki;
  doc.documentElement.classList.remove('no-js');

  /* ---------- icons (feather-style paths) ---------- */
  var P = {
    chat: '<path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/>',
    video: '<path d="M23 7l-7 5 7 5z"/><rect x="1" y="5" width="15" height="14" rx="2"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    bot: '<rect x="3" y="8" width="18" height="12" rx="3"/><path d="M12 8V4"/><circle cx="12" cy="3" r="1"/><path d="M8 14h.01M16 14h.01"/>',
    phone: '<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M11 18h2"/>',
    monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
    palette: '<circle cx="12" cy="12" r="10"/><circle cx="7.5" cy="10.5" r="1"/><circle cx="12" cy="7.5" r="1"/><circle cx="16.5" cy="10.5" r="1"/><path d="M12 22a3 3 0 0 1 0-6h1a2 2 0 0 0 0-4"/>',
    server: '<rect x="2" y="3" width="20" height="8" rx="2"/><rect x="2" y="13" width="20" height="8" rx="2"/><path d="M6 7h.01M6 17h.01"/>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/>',
    code: '<path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/>',
    zap: '<path d="M13 2L3 14h9l-1 8 10-12h-9z"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>',
    book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5V22h16"/>',
    chart: '<path d="M18 20V10M12 20V4M6 20v-6"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    menu: '<path d="M3 12h18M3 6h18M3 18h18"/>',
    x: '<path d="M18 6L6 18M6 6l12 12"/>',
    play: '<path d="M6 4l14 8-14 8z"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
    key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="M21 2l-9.6 9.6M15 8l3 3"/>',
    layers: '<path d="M12 2L2 7l10 5 10-5z"/><path d="M2 17l10 5 10-5M2 12l10 5 10-5"/>',
    heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/>',
    star: '<path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z"/>',
    folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/>',
    terminal: '<path d="M4 17l6-6-6-6M12 19h8"/>',
    hash: '<path d="M4 9h16M4 15h16M10 3L8 21M16 3l-2 18"/>',
    eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>',
    cpu: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/>'
  };
  function icon(name) { return '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">' + (P[name] || '') + '</svg>'; }
  function paintIcons(scope) {
    (scope || doc).querySelectorAll('i[data-icon]').forEach(function (el) {
      var span = doc.createElement('span');
      span.style.display = 'inline-flex';
      span.innerHTML = icon(el.getAttribute('data-icon'));
      el.replaceWith(span.firstChild);
    });
  }
  window.MC_icon = icon;

  /* ---------- shared chrome ---------- */
  var NAV = [
    ['index.html', 0, 'home'],
    ['features.html', 1, 'features'],
    ['gallery.html', 2, 'gallery'],
    ['download.html', 3, 'download'],
    ['wiki/index.html', 4, 'wiki'],
    ['about.html', 5, 'about']
  ];
  var THEMES = [['dark', '#0d9488', 'MeshCrowd Dark'], ['purple', '#9b59f6', 'Midnight Purple'], ['forest', '#2f9e5c', 'Forest'], ['sunset', '#f2683f', 'Sunset']];

  // The other language's version of this page, from <link rel="alternate" hreflang="..">.
  function altHref(code) {
    var l = doc.querySelector('link[rel="alternate"][hreflang="' + code + '"]');
    return l ? l.getAttribute('href') : null;
  }
  function langSwitch() {
    var out = '<div class="lang-pick" role="group" aria-label="' + S.langGroup + '">';
    [['en', 'EN', 'English'], ['hu', 'HU', 'Magyar']].forEach(function (x) {
      var href = x[0] === lang ? null : altHref(x[0]);
      out += x[0] === lang
        ? '<span aria-current="true" title="' + x[2] + '">' + x[1] + '</span>'
        : '<a href="' + (href || (x[0] === 'hu' ? root + '/hu/index.html' : root + '/index.html')) + '" data-lang-pick="' + x[0] + '" hreflang="' + x[0] + '" lang="' + x[0] + '" title="' + x[2] + '">' + x[1] + '</a>';
    });
    return out + '</div>';
  }

  function header() {
    var h = doc.createElement('header');
    h.className = 'site-header';
    h.innerHTML =
      '<div class="container bar">' +
      '<a class="brand" href="' + linkBase + '/index.html"><img src="' + root + '/assets/img/logo.png" alt="" width="32" height="32"><span>MeshCrowd</span></a>' +
      '<nav class="nav" id="nav" aria-label="Main">' +
      NAV.map(function (n) { return '<a href="' + linkBase + '/' + n[0] + '"' + (n[2] === page ? ' class="active" aria-current="page"' : '') + '>' + S.nav[n[1]] + '</a>'; }).join('') +
      '</nav>' +
      '<div class="header-right">' +
      langSwitch() +
      '<div class="theme-pick" role="group" aria-label="' + S.themeGroup + '">' +
      THEMES.map(function (t) { return '<button type="button" data-theme-pick="' + t[0] + '" style="background:' + t[1] + '" title="' + t[2] + '" aria-label="' + t[2] + '" aria-pressed="false"></button>'; }).join('') +
      '</div>' +
      '<a class="btn btn-primary btn-sm" href="' + linkBase + '/download.html">' + icon('download') + ' ' + S.download + '</a>' +
      '<button class="menu-btn" type="button" id="menu-btn" aria-label="' + S.menu + '" aria-expanded="false" aria-controls="nav">' + icon('menu') + '</button>' +
      '</div></div>';
    doc.body.insertBefore(h, doc.body.firstChild);
    var btn = h.querySelector('#menu-btn'), nav = h.querySelector('#nav');
    btn.addEventListener('click', function () { var o = nav.classList.toggle('open'); btn.setAttribute('aria-expanded', String(o)); });
    nav.addEventListener('click', function (e) { if (e.target.closest('a')) nav.classList.remove('open'); });
    // an explicit choice wins over browser detection from now on
    h.querySelectorAll('[data-lang-pick]').forEach(function (a) {
      a.addEventListener('click', function () { try { localStorage.setItem('mc-lang', a.getAttribute('data-lang-pick')); } catch (e) { /* private mode */ } });
    });
  }

  function footer() {
    var f = doc.createElement('footer');
    f.className = 'site-footer';
    f.innerHTML =
      '<div class="container"><div class="foot-grid">' +
      '<div><a class="brand" href="' + linkBase + '/index.html"><img src="' + root + '/assets/img/logo.png" alt="" width="32" height="32"><span>MeshCrowd</span></a>' +
      '<p style="margin-top:14px">' + S.fTag + '</p></div>' +
      '<div><h4>' + S.fProject + '</h4><a href="' + linkBase + '/features.html">' + S.nav[1] + '</a><a href="' + linkBase + '/gallery.html">' + S.nav[2] + '</a><a href="' + linkBase + '/download.html">' + S.nav[3] + '</a><a href="' + linkBase + '/about.html">' + S.nav[5] + '</a></div>' +
      '<div><h4>' + S.fDocs + '</h4><a href="' + linkBase + '/wiki/index.html">' + S.fWikiHome + '</a><a href="' + linkBase + '/wiki/getting-started.html">' + S.fStart + '</a><a href="' + linkBase + '/wiki/bots-api.html">' + S.fBots + '</a><a href="' + linkBase + '/wiki/troubleshooting.html">' + S.fTrouble + '</a></div>' +
      '<div><h4>' + S.fLegal + '</h4><a href="' + linkBase + '/license.html">' + S.fLicense + '</a><a href="' + root + '/LICENSE.txt">' + S.fFull + '</a><a href="' + linkBase + '/wiki/security.html">' + S.fSecurity + '</a><a href="#">' + S.fSource + '</a></div>' +
      '</div><div class="foot-bottom"><span>' + S.fCopy + '</span>' +
      '<span>' + S.fBuilt + ' <a href="' + linkBase + '/about.html#built-with">' + S.fHow + '</a></span></div></div>';
    doc.body.appendChild(f);
  }

  /* ---------- theme ---------- */
  function setTheme(name) {
    if (name === 'dark') doc.documentElement.removeAttribute('data-theme'); else doc.documentElement.setAttribute('data-theme', name);
    try { localStorage.setItem('mc-theme', name); } catch (e) { /* private mode */ }
    doc.querySelectorAll('[data-theme-pick]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-theme-pick') === name)); });
  }
  function initTheme() {
    var cur = doc.documentElement.getAttribute('data-theme') || 'dark';
    doc.querySelectorAll('[data-theme-pick]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-theme-pick') === cur));
      b.addEventListener('click', function () { setTheme(b.getAttribute('data-theme-pick')); });
    });
  }

  /* ---------- reveal, counters, tilt, spotlight ---------- */
  function initReveal() {
    var els = doc.querySelectorAll('.reveal');
    if (!('IntersectionObserver' in window)) { els.forEach(function (e) { e.classList.add('in'); }); return; }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    els.forEach(function (e, i) { e.style.transitionDelay = ((i % 4) * 70) + 'ms'; io.observe(e); });
  }
  function initCounters() {
    var els = doc.querySelectorAll('[data-count]');
    if (!els.length || !('IntersectionObserver' in window)) return;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        io.unobserve(en.target);
        var el = en.target, end = parseFloat(el.getAttribute('data-count')), suffix = el.getAttribute('data-suffix') || '', t0 = performance.now();
        (function step(t) {
          var p = Math.min(1, (t - t0) / 1200), v = Math.round(end * (1 - Math.pow(1 - p, 3)));
          el.textContent = v + suffix;
          if (p < 1) requestAnimationFrame(step);
        })(t0);
      });
    }, { threshold: 0.6 });
    els.forEach(function (e) { io.observe(e); });
  }
  function initSpotlight() {
    doc.querySelectorAll('.card').forEach(function (c) {
      c.addEventListener('pointermove', function (e) {
        var r = c.getBoundingClientRect();
        c.style.setProperty('--mx', (e.clientX - r.left) + 'px');
        c.style.setProperty('--my', (e.clientY - r.top) + 'px');
      });
    });
  }
  function initTilt() {
    var art = doc.querySelector('.hero-art');
    if (!art || window.matchMedia('(max-width: 1100px)').matches || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var w = art.querySelector('.window');
    art.addEventListener('pointermove', function (e) {
      var r = art.getBoundingClientRect();
      var x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
      w.style.transform = 'rotateY(' + (-7 + x * 8) + 'deg) rotateX(' + (3 - y * 7) + 'deg)';
    });
    art.addEventListener('pointerleave', function () { w.style.transform = ''; });
  }

  /* ---------- tabs ---------- */
  function initTabs() {
    doc.querySelectorAll('[data-tabs]').forEach(function (box) {
      var tabs = [].slice.call(box.querySelectorAll('[role="tab"]'));
      var panels = [].slice.call(box.querySelectorAll('[role="tabpanel"]'));
      var timer = null, idx = 0, user = false;
      function show(i) {
        idx = i;
        tabs.forEach(function (t, k) { t.setAttribute('aria-selected', String(k === i)); t.tabIndex = k === i ? 0 : -1; });
        panels.forEach(function (p, k) { p.classList.toggle('on', k === i); });
      }
      tabs.forEach(function (t, i) {
        t.addEventListener('click', function () { user = true; clearInterval(timer); show(i); });
        t.addEventListener('keydown', function (e) {
          if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); user = true; show((idx + 1) % tabs.length); tabs[idx].focus(); }
          if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); user = true; show((idx + tabs.length - 1) % tabs.length); tabs[idx].focus(); }
        });
      });
      show(0);
      if (box.hasAttribute('data-auto') && 'IntersectionObserver' in window && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        new IntersectionObserver(function (en) {
          clearInterval(timer);
          if (en[0].isIntersecting && !user) timer = setInterval(function () { show((idx + 1) % tabs.length); }, 6500);
        }, { threshold: 0.4 }).observe(box);
      }
    });
  }

  /* ---------- videos, lightbox, copy ---------- */
  function initVideos() {
    doc.querySelectorAll('.video-card').forEach(function (card) {
      var v = card.querySelector('video'), b = card.querySelector('.play');
      if (!v || !b) return;
      b.addEventListener('click', function () { card.classList.add('playing'); v.controls = true; v.play().catch(function () { card.classList.remove('playing'); }); });
      v.addEventListener('ended', function () { card.classList.remove('playing'); v.controls = false; });
    });
  }
  function initLightbox() {
    var box = doc.createElement('div');
    box.className = 'lightbox'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', S.preview);
    box.innerHTML = '<button type="button" aria-label="' + S.close + '">' + icon('x') + '</button><img alt=""><div class="cap"></div>';
    doc.body.appendChild(box);
    var img = box.querySelector('img'), cap = box.querySelector('.cap');
    function close() { box.classList.remove('on'); }
    box.addEventListener('click', close);
    doc.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
    doc.addEventListener('click', function (e) {
      var t = e.target.closest('.window img, .phone-frame img, [data-zoom]');
      if (!t || t.closest('.video-card')) return;
      var src = t.getAttribute('data-zoom') || t.currentSrc || t.src;
      if (!src) return;
      img.src = src; img.alt = t.alt || '';
      cap.textContent = t.alt || '';
      box.classList.add('on');
    });
  }
  function initCopy() {
    doc.querySelectorAll('pre').forEach(function (pre) {
      if (pre.classList.contains('nocopy')) return;
      var b = doc.createElement('button');
      b.type = 'button'; b.className = 'copy'; b.textContent = S.copy;
      b.addEventListener('click', function () {
        var text = pre.querySelector('code') ? pre.querySelector('code').innerText : pre.innerText.replace(new RegExp(S.copy + '$'), '');
        var done = function () { b.textContent = S.copied; setTimeout(function () { b.textContent = S.copy; }, 1400); };
        if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, done); else done();
      });
      pre.appendChild(b);
    });
  }

  /* ---------- gallery filter ---------- */
  function initFilter() {
    var bar = doc.querySelector('.filter'); if (!bar) return;
    bar.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      bar.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      var f = b.getAttribute('data-filter');
      doc.querySelectorAll('.gallery figure').forEach(function (fig) { fig.style.display = (f === 'all' || fig.getAttribute('data-cat') === f) ? '' : 'none'; });
    });
  }

  /* ---------- downloads: highlight the card for this OS ---------- */
  function initOs() {
    var ua = navigator.userAgent || '', os = /Android/i.test(ua) ? 'android' : /Win/i.test(ua) ? 'windows' : /Linux|Mac|X11/i.test(ua) ? 'unix' : 'windows';
    doc.querySelectorAll('[data-os]').forEach(function (c) { if (c.getAttribute('data-os').split(' ').indexOf(os) > -1) { var r = doc.createElement('span'); r.className = 'badge recommended'; r.textContent = S.forYou; c.appendChild(r); } });
    doc.querySelectorAll('a[href="#"]').forEach(function (a) { a.addEventListener('click', function (e) { e.preventDefault(); }); });
  }

  /* ---------- wiki ---------- */
  function slugOf(text) { return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
  function initWiki() {
    var data = window.MC_WIKI; if (!data) return;
    var pages = data.pages;
    var here = location.pathname.split('/').pop() || 'index.html';
    var nav = doc.getElementById('wiki-nav'); if (!nav) return;
    var groups = [];
    pages.forEach(function (p) { if (groups.indexOf(p.group) < 0) groups.push(p.group); });
    var html = '<div class="wiki-search"><span>' + icon('search') + '</span><input type="search" id="wiki-q" placeholder="' + S.search + '" aria-label="' + S.search + '" autocomplete="off"><div class="search-results" id="wiki-results"></div></div>';
    groups.forEach(function (g) {
      html += '<div class="grp">' + g + '</div>';
      pages.filter(function (p) { return p.group === g; }).forEach(function (p) {
        html += '<a href="' + (isWikiPage ? '' : linkBase + '/wiki/') + p.slug + '.html"' + (p.slug + '.html' === here ? ' class="active" aria-current="page"' : '') + '>' + p.title + '</a>';
      });
    });
    nav.innerHTML = html;
    var tgl = doc.getElementById('wiki-toggle');
    if (tgl) tgl.addEventListener('click', function () { nav.classList.toggle('open'); });

    // search
    var q = doc.getElementById('wiki-q'), out = doc.getElementById('wiki-results');
    function hits(term) {
      var words = term.toLowerCase().split(/\s+/).filter(Boolean), res = [];
      pages.forEach(function (p) {
        var score = 0, where = '';
        var hay = (p.title + ' ' + p.desc).toLowerCase();
        words.forEach(function (w) { if (p.title.toLowerCase().indexOf(w) > -1) score += 6; else if (hay.indexOf(w) > -1) score += 3; });
        p.headings.forEach(function (h) { var m = words.every(function (w) { return h.text.toLowerCase().indexOf(w) > -1; }); if (m) { score += 4; if (!where) where = h; } });
        if (p.text) { var t = p.text.toLowerCase(); var all = words.every(function (w) { return t.indexOf(w) > -1; }); if (all) score += 1; }
        if (score > 0) res.push({ p: p, score: score, h: where });
      });
      return res.sort(function (a, b) { return b.score - a.score; }).slice(0, 8);
    }
    q.addEventListener('input', function () {
      var v = q.value.trim();
      if (v.length < 2) { out.classList.remove('on'); return; }
      var r = hits(v);
      out.innerHTML = r.length ? r.map(function (x) {
        return '<a href="' + (isWikiPage ? '' : linkBase + '/wiki/') + x.p.slug + '.html' + (x.h ? '#' + x.h.id : '') + '">' + x.p.title + (x.h ? ' &rsaquo; ' + x.h.text : '') + '<small>' + x.p.desc + '</small></a>';
      }).join('') : '<div class="none">' + S.noMatch + ' "' + v.replace(/[<>&]/g, '') + '"</div>';
      out.classList.add('on');
    });
    doc.addEventListener('click', function (e) { if (!e.target.closest('.wiki-search')) out.classList.remove('on'); });
    doc.addEventListener('keydown', function (e) { if (e.key === '/' && doc.activeElement.tagName !== 'INPUT' && doc.activeElement.tagName !== 'TEXTAREA') { e.preventDefault(); q.focus(); } });

    // in-page TOC + anchors
    var art = doc.querySelector('.wiki-main article'), toc = doc.getElementById('wiki-toc');
    if (art && toc) {
      var hs = [].slice.call(art.querySelectorAll('h2, h3')).filter(function (h) { return !h.closest('.card'); }), links = [];
      hs.forEach(function (h) {
        if (!h.id) h.id = slugOf(h.textContent);
        var a = doc.createElement('a'); a.className = 'anchor'; a.href = '#' + h.id; a.textContent = '#'; a.setAttribute('aria-label', S.anchor); h.appendChild(a);
        var l = doc.createElement('a'); l.href = '#' + h.id; l.textContent = h.firstChild.textContent; if (h.tagName === 'H3') l.className = 'l3';
        toc.appendChild(l); links.push([h, l]);
      });
      if (!hs.length) toc.parentNode.style.display = 'none';
      if ('IntersectionObserver' in window) {
        var cur = null;
        var io = new IntersectionObserver(function (en) {
          en.forEach(function (e) { if (e.isIntersecting) cur = e.target; });
          links.forEach(function (x) { x[1].classList.toggle('active', x[0] === cur); });
        }, { rootMargin: '-80px 0px -70% 0px' });
        links.forEach(function (x) { io.observe(x[0]); });
      }
    }

    // prev / next
    var idx = pages.findIndex(function (p) { return p.slug + '.html' === here; });
    var pager = doc.getElementById('wiki-pager');
    if (pager && idx > -1) {
      var pv = pages[idx - 1], nx = pages[idx + 1];
      pager.innerHTML = (pv ? '<a class="prev" href="' + pv.slug + '.html"><small>' + S.prev + '</small>' + pv.title + '</a>' : '<span></span>') + (nx ? '<a class="next" href="' + nx.slug + '.html"><small>' + S.next + '</small>' + nx.title + '</a>' : '');
    }
  }

  /* ---------- features page: highlight the section in view ---------- */
  function initSideNav() {
    var links = [].slice.call(doc.querySelectorAll('.side-nav a[href^="#"]'));
    if (!links.length || !('IntersectionObserver' in window)) return;
    var map = {};
    links.forEach(function (a) { var el = doc.getElementById(a.getAttribute('href').slice(1)); if (el) map[el.id] = a; });
    var io = new IntersectionObserver(function (en) {
      en.forEach(function (e) {
        if (!e.isIntersecting) return;
        links.forEach(function (a) { a.classList.toggle('active', a === map[e.target.id]); });
      });
    }, { rootMargin: '-90px 0px -65% 0px' });
    Object.keys(map).forEach(function (id) { io.observe(doc.getElementById(id)); });
  }

  /* ---------- go ---------- */
  header();
  footer();
  paintIcons();
  initTheme();
  initReveal();
  initCounters();
  initSpotlight();
  initTilt();
  initTabs();
  initVideos();
  initLightbox();
  initCopy();
  initFilter();
  initOs();
  initSideNav();
  if (isWiki) initWiki();
})();
