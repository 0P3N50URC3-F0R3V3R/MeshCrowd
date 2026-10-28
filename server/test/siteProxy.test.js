'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const express = require('express');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const { db } = require('../db');
const sp = require('../lib/siteProcesses');
const sf = require('../lib/siteFiles');
const { createRouter } = require('../routes/siteProxy');

const FAKE = path.join(__dirname, 'fixtures', 'fakePhp.js');
const makeUser = (n) => db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
  .run(n, `${n}@t.local`, 'h', n).lastInsertRowid;

let server; let base; let siteId; let member; let outsider;

test.before(async () => {
  sp.configure({
    maxWorkers: 3,
    launcher: ({ port, docroot }) => spawn(process.execPath, [FAKE, '-S', `127.0.0.1:${port}`, '-t', docroot], { stdio: 'ignore', windowsHide: true }),
  });
  member = makeUser('px_member'); outsider = makeUser('px_out');
  siteId = db.prepare("INSERT INTO servers (name, owner_id, invite_code, visibility, auto_join, kind, site_csp_origins) VALUES ('Intra', ?, 'px-inv', 'public', 1, 'site', '[\"https://cdn.example.com\"]')").run(member).lastInsertRowid;
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(siteId, member);
  sf.ensureSiteDir(siteId);
  sf.writeFile(siteId, 'index.php', Buffer.from('<?php echo 1;'));
  sf.writeFile(siteId, 'page.html', Buffer.from('<html><head></head><body><a href="/x.html">x</a></body></html>'));
  sf.writeFile(siteId, 'style.css', Buffer.from('a{background:url(/i.png)}'));
  sf.writeFile(siteId, 'árak lista.html', Buffer.from('<p>árak</p>'));
  sf.makeDir(siteId, 'docs');
  sf.writeFile(siteId, 'docs/index.html', Buffer.from('<p>docs</p>'));

  const attachUser = (req, res, next) => {
    const uid = Number(req.headers['x-uid']);
    if (uid) req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
    next();
  };
  const app = express();
  app.use((req, res, next) => { res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'"); next(); });
  app.use('/site', createRouter({ attachUser }));
  await new Promise((r) => { server = http.createServer(app).listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  sp.stopAll(); server.close(); db.close();
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const get = (p, { uid = member, headers = {}, method = 'GET', body, redirect = 'manual' } = {}) =>
  fetch(base + p, { method, redirect, body, headers: { ...(uid ? { 'x-uid': String(uid) } : {}), ...headers } });

test('signed-out and non-member requests get plain 401/403, never the app shell or a redirect', async () => {
  const a = await get(`/site/${siteId}/`, { uid: 0 });
  assert.equal(a.status, 401);
  assert.equal(a.headers.get('x-frame-options'), 'SAMEORIGIN'); // frameable, so the iframe shows the text
  assert.match(a.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  assert.match(await a.text(), /Sign in/);
  const b = await get(`/site/${siteId}/`, { uid: outsider });
  assert.equal(b.status, 403);
  assert.equal(b.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal((await get('/site/99999/')).status, 404);
});

test('missing trailing slash redirects, for the site root and for directories', async () => {
  const r = await get(`/site/${siteId}?a=1`);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), `/site/${siteId}/?a=1`);
  const d = await get(`/site/${siteId}/docs`);
  assert.equal(d.status, 302);
  assert.equal(d.headers.get('location'), `/site/${siteId}/docs/`);
  assert.equal((await get(`/site/${siteId}/docs/`)).status, 200);
});

test('responses override the global frame headers and carry the Site CSP', async () => {
  const r = await get(`/site/${siteId}/page.html`);
  assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /frame-ancestors 'self'/);
  assert.match(csp, /https:\/\/cdn\.example\.com/);
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
});

test('static html is rewritten and gets the loader; css urls are rewritten; the loader script is served', async () => {
  const html = await (await get(`/site/${siteId}/page.html`)).text();
  assert.match(html, new RegExp(`href="/site/${siteId}/x\\.html"`));
  assert.match(html, new RegExp(`<script src="/site/${siteId}/__site\\.js"></script>`));
  assert.match(await (await get(`/site/${siteId}/style.css`)).text(), new RegExp(`url\\(/site/${siteId}/i\\.png\\)`));
  const js = await get(`/site/${siteId}/__site.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  assert.match(await js.text(), /site-open-external/);
});

test('accented, spaced file names are served', async () => {
  const r = await get(`/site/${siteId}/${encodeURIComponent('árak lista.html')}`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /árak/);
});

test('php pages are proxied: rewritten, cookies stripped both ways, body forwarded', async () => {
  const r = await get(`/site/${siteId}/index.php?q=1`, { headers: { cookie: 'dismesh_session=secret' } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('set-cookie'), null);
  assert.equal(r.headers.get('x-saw-cookie'), 'no');
  const html = await r.text();
  assert.match(html, /GET \/index\.php\?q=1/);
  assert.match(html, new RegExp(`href="/site/${siteId}/next\\.php"`));
  const p = await get(`/site/${siteId}/index.php`, { method: 'POST', body: 'a=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.match(await p.text(), /POST \/index\.php \[a=1\]/);
});

test('redirects from php stay inside the site; protocol-relative targets are not turned into site paths', async () => {
  fs.writeFileSync(path.join(sf.siteDir(siteId), 'redirect.php'), '<?php');
  fs.writeFileSync(path.join(sf.siteDir(siteId), 'evil.php'), '<?php');
  const a = await get(`/site/${siteId}/redirect.php`);
  assert.equal(a.headers.get('location'), `/site/${siteId}/login.php`);
  const b = await get(`/site/${siteId}/evil.php`);
  assert.equal(b.headers.get('location'), '//evil.com/x');
});

test('hostile paths 404: encoded traversal, dot dirs, unknown extensions, non-files', async () => {
  for (const p of ['/%2e%2e/%2e%2e/etc/passwd', '/.git/config', '/%2e%2e%5c%2e%2e%5cx.php', '/raw.bin', '/nope.php', '//evil.com/x.html']) {
    const r = await get(`/site/${siteId}${p}`);
    assert.equal(r.status, 404, p);
  }
});

test('non-GET on static files is 405 and a deleted site folder is a clean 404', async () => {
  assert.equal((await get(`/site/${siteId}/page.html`, { method: 'POST', body: 'x' })).status, 405);
  const gone = db.prepare("INSERT INTO servers (name, owner_id, invite_code, visibility, auto_join, kind) VALUES ('Gone', ?, 'px-gone', 'public', 1, 'site')").run(member).lastInsertRowid;
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(gone, member);
  assert.equal((await get(`/site/${gone}/`)).status, 404);
  assert.equal((await get(`/site/${gone}/index.php`)).status, 404);
});

test('slow php requests run in parallel through the pool instead of queueing behind each other', async () => {
  fs.writeFileSync(path.join(sf.siteDir(siteId), 'slow.php'), '<?php');
  const t0 = Date.now();
  const responses = await Promise.all([1, 2, 3].map(() => get(`/site/${siteId}/slow.php`)));
  const elapsed = Date.now() - t0;
  assert.ok(responses.every((r) => r.status === 200));
  assert.ok(new Set(responses.map((r) => r.headers.get('x-worker-pid'))).size > 1, 'requests were served by more than one worker');
  assert.ok(elapsed < 800, `took ${elapsed}ms; one worker would need about 900ms`);
});

test('a client that disconnects mid-request frees its worker', async () => {
  const ac = new AbortController();
  const pending = fetch(`${base}/site/${siteId}/slow.php`, { headers: { 'x-uid': String(member) }, signal: ac.signal }).catch(() => {});
  await new Promise((r) => setTimeout(r, 50));
  ac.abort();
  await pending;
  await new Promise((r) => setTimeout(r, 450));
  const r = await get(`/site/${siteId}/index.php`);
  assert.equal(r.status, 200);
});

test('a crash-looping site answers 503 with Retry-After inside the frame', async () => {
  const s = db.prepare("INSERT INTO servers (name, owner_id, invite_code, visibility, auto_join, kind) VALUES ('Crashy', ?, 'px-crash', 'public', 1, 'site')").run(member).lastInsertRowid;
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(s, member);
  sf.ensureSiteDir(s);
  fs.writeFileSync(path.join(sf.siteDir(s), 'index.php'), '<?php');
  fs.writeFileSync(path.join(sf.siteDir(s), 'crash.flag'), '1');
  const r = await get(`/site/${s}/`);
  assert.equal(r.status, 503);
  assert.ok(r.headers.get('retry-after'));
  assert.match(await r.text(), /unavailable/);
});
