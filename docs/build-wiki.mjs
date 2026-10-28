// Generates wiki/*.html and assets/js/wiki-data.js from wiki-src/*.md. Run: node Website/build-wiki.mjs
// The output is plain static HTML; this script is only a convenience for editing the wiki as Markdown.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, 'wiki-src');
const OUT = path.join(here, 'wiki');
fs.mkdirSync(OUT, { recursive: true });

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const slugify = (s) => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function inline(text) {
  const codes = [];
  let s = text.replace(/`([^`]+)`/g, (_, c) => { codes.push(`<code>${esc(c)}</code>`); return `\u0000${codes.length - 1}\u0000`; });
  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => {
    const external = /^https?:/.test(u);
    return `<a href="${u.replace(/\.md(#|$)/, '.html$1')}"${external ? ' rel="noopener" target="_blank"' : ''}>${t}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
}

function parseTable(lines) {
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const head = cells(lines[0]);
  const rows = lines.slice(2).map(cells);
  return `<table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function renderList(items, ordered) {
  const tag = ordered ? 'ol' : 'ul';
  let html = `<${tag}>`;
  for (const it of items) {
    html += `<li>${inline(it.text)}`;
    if (it.children.length) html += renderList(it.children, it.childOrdered);
    html += '</li>';
  }
  return html + `</${tag}>`;
}

function markdown(src, headings) {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    // fenced code
    let m = line.match(/^```(\w*)\s*$/);
    if (m) {
      const buf = []; i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code${m[1] ? ` class="lang-${m[1]}"` : ''}>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    // callout
    m = line.match(/^:::\s*(note|warn|danger)\s*(.*)$/);
    if (m) {
      const buf = []; i++;
      while (i < lines.length && !/^:::\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++;
      const cls = m[1] === 'note' ? '' : ` ${m[1]}`;
      out.push(`<div class="callout${cls}">${m[2] ? `<strong>${inline(m[2])}</strong>` : ''}${markdown(buf.join('\n'), null)}</div>`);
      continue;
    }
    // heading
    m = line.match(/^(#{1,4})\s+(.*?)(?:\s+\{#([\w-]+)\})?\s*$/);
    if (m) {
      const level = m[1].length;
      if (level === 1) { i++; continue; }
      const text = m[2].trim();
      const id = m[3] || slugify(text);
      if (headings && level <= 3) headings.push({ id, text: text.replace(/`/g, ''), level });
      out.push(`<h${level} id="${id}">${inline(text)}</h${level}>`);
      i++;
      continue;
    }
    // image block
    m = line.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);
    if (m) { out.push(`<figure class="doc"><div class="window"><img src="${m[2]}" alt="${esc(m[1])}" loading="lazy"></div><figcaption>${inline(m[1])}</figcaption></figure>`); i++; continue; }
    // table
    if (/^\|/.test(line) && i + 1 < lines.length && /^\|?[\s:|-]+\|?$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const buf = [];
      while (i < lines.length && /^\|/.test(lines[i])) buf.push(lines[i++]);
      out.push(parseTable(buf));
      continue;
    }
    // hr
    if (/^---+\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    // lists (one nesting level)
    if (/^(\s*)([-*]|\d+\.)\s+/.test(line)) {
      const items = [];
      const ordered = /^\s*\d+\./.test(line);
      while (i < lines.length && /^(\s*)([-*]|\d+\.)\s+/.test(lines[i])) {
        const mm = lines[i].match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
        const indent = mm[1].length;
        if (indent >= 2 && items.length) {
          const parent = items[items.length - 1];
          parent.children.push({ text: mm[3], children: [] });
          parent.childOrdered = /\d+\./.test(mm[2]);
        } else items.push({ text: mm[3], children: [], childOrdered: false });
        i++;
        // continuation lines
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^(\s*)([-*]|\d+\.)\s+/.test(lines[i])) { items[items.length - 1].text += ' ' + lines[i].trim(); i++; }
      }
      out.push(renderList(items, ordered));
      continue;
    }
    // paragraph
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|:::|\||!\[|---+\s*$|(\s*)([-*]|\d+\.)\s+)/.test(lines[i])) buf.push(lines[i++]);
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }
  return out.join('\n');
}

// ---- languages
const LANGS = {
  en: {
    src: SRC, out: OUT, dataFile: 'assets/js/wiki-data.js', code: 'en',
    assets: '../assets', base: '..', root: '..', homeHref: '../index.html',
    groups: ['Start here', 'Using MeshCrowd', 'Running a community', 'Extending', 'Operating a server'],
    ui: { home: 'Home', wiki: 'Wiki', pages: 'Wiki pages', onPage: 'On this page', suffix: 'MeshCrowd Wiki' },
    alt: (slug) => ({ en: slug + '.html', hu: '../hu/wiki/' + slug + '.html' }),
  },
  hu: {
    src: path.join(SRC, 'hu'), out: path.join(here, 'hu', 'wiki'), dataFile: 'assets/js/wiki-data-hu.js', code: 'hu',
    assets: '../../assets', base: '..', root: '../..', homeHref: '../index.html',
    groups: ['Kezdd itt', 'A MeshCrowd használata', 'Közösség üzemeltetése', 'Bővítés', 'Szerver üzemeltetése'],
    ui: { home: 'Kezdőlap', wiki: 'Wiki', pages: 'Wiki oldalak', onPage: 'Ezen az oldalon', suffix: 'MeshCrowd Wiki' },
    alt: (slug) => ({ en: '../../wiki/' + slug + '.html', hu: slug + '.html' }),
  },
};

function buildLanguage(L) {
  if (!fs.existsSync(L.src)) return 0;
  fs.mkdirSync(L.out, { recursive: true });
  const pages = [];
  for (const file of fs.readdirSync(L.src).filter((f) => f.endsWith('.md'))) {
    const raw = fs.readFileSync(path.join(L.src, file), 'utf8').replace(/\r\n/g, '\n');
    const fm = raw.match(/^---\n([\s\S]*?)\n---\n/);
    if (!fm) throw new Error(file + ': missing front matter');
    const meta = {};
    for (const l of fm[1].split('\n')) { const k = l.match(/^(\w+):\s*(.*)$/); if (k) meta[k[1]] = k[2].trim(); }
    let body = raw.slice(fm[0].length);
    if (L.code === 'hu') body = body.replace(/\]\(\.\.\/assets\//g, '](../../assets/');
    const headings = [];
    const html = markdown(body, headings);
    const text = body.replace(/```[\s\S]*?```/g, ' ').replace(/[#*`|>\[\]()!:_-]+/g, ' ').replace(/\s+/g, ' ').slice(0, 7000);
    pages.push({ slug: file.replace(/\.md$/, ''), title: meta.title, desc: meta.desc || '', group: meta.group || L.groups[1], order: Number(meta.order || 99), html, headings, text });
  }
  pages.sort((a, b) => (L.groups.indexOf(a.group) - L.groups.indexOf(b.group)) || a.order - b.order);

  const indexCards = () => {
    let h = '';
    for (const g of L.groups) {
      const list = pages.filter((p) => p.group === g && p.slug !== 'index');
      if (!list.length) continue;
      h += `<h2 id="${slugify(g)}">${g}</h2><div class="wiki-index-grid">`;
      for (const p of list) h += `<a class="card" href="${p.slug}.html" style="color:inherit;text-decoration:none"><h3>${esc(p.title)}</h3><p>${esc(p.desc)}</p></a>`;
      h += '</div>';
    }
    return h;
  };

  const template = (p, body) => {
    const alt = L.alt(p.slug);
    const dataName = path.basename(L.dataFile);
    return `<!doctype html>
<html lang="${L.code}" class="no-js">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(p.title)} - ${L.ui.suffix}</title>
<meta name="description" content="${esc(p.desc)}">
<meta name="theme-color" content="#1e1f22">
<link rel="icon" href="${L.assets}/img/logo.png">
<link rel="stylesheet" href="${L.assets}/css/site.css">
<link rel="alternate" hreflang="en" href="${alt.en}">
<link rel="alternate" hreflang="hu" href="${alt.hu}">
<script>try{var d=document.documentElement,t=localStorage.getItem('mc-theme');if(t&&t!=='dark')d.setAttribute('data-theme',t);var l=d.lang,w=localStorage.getItem('mc-lang');if(!w&&l==='en'){var n=(navigator.languages&&navigator.languages[0])||navigator.language||'';if(/^hu/i.test(n))w='hu'}if(w&&w!==l){var a=document.querySelector('link[rel="alternate"][hreflang="'+w+'"]');if(a)location.replace(a.getAttribute('href'))}}catch(e){}</script>
</head>
<body data-root="${L.root}" data-base="${L.base}" data-page="wiki" data-wiki>
<main>
<div class="container wiki-layout">
  <div>
    <button class="btn btn-ghost btn-sm wiki-mobile-toggle" id="wiki-toggle" type="button">${L.ui.pages}</button>
    <nav class="wiki-nav" id="wiki-nav" aria-label="Wiki"></nav>
  </div>
  <div class="wiki-main">
    <article>
      <div class="crumbs"><a href="${L.homeHref}">${L.ui.home}</a> / <a href="index.html">${L.ui.wiki}</a>${p.slug === 'index' ? '' : ` / ${esc(p.group)}`}</div>
      <h1>${esc(p.title)}</h1>
      <p class="summary">${esc(p.desc)}</p>
${body}
    </article>
    <div class="pager" id="wiki-pager"></div>
  </div>
  <aside class="toc" aria-label="${L.ui.onPage}"><h4>${L.ui.onPage}</h4><div id="wiki-toc"></div></aside>
</div>
</main>
<script src="${L.assets}/js/${dataName}"></script>
<script src="${L.assets}/js/site.js" defer></script>
</body>
</html>
`;
  };

  for (const p of pages) {
    const body = p.html.replace('<p>{{index}}</p>', indexCards());
    fs.writeFileSync(path.join(L.out, p.slug + '.html'), template(p, body));
  }
  const data = { pages: pages.map((p) => ({ slug: p.slug, title: p.title, desc: p.desc, group: p.group, headings: p.headings, text: p.text })) };
  fs.writeFileSync(path.join(here, L.dataFile), `/* generated by build-wiki.mjs */\nwindow.MC_WIKI = ${JSON.stringify(data)};\n`);
  return pages.length;
}

for (const L of Object.values(LANGS)) console.log(`wiki (${L.code}): ${buildLanguage(L)} pages`);
