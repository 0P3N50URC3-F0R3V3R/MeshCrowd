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
const st = require('../lib/siteStorage');
const { createSession } = require('../lib/session');
const siteViewToken = require('../lib/siteViewToken');
const { createRouter } = require('../routes/siteProxy');

const FAKE = path.join(__dirname, 'fixtures', 'fakePhp.js');
const makeUser = (n) => db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
  .run(n, `${n}@t.local`, 'h', n).lastInsertRowid;
const makeSite = (name, owner) => {
  const id = db.prepare("INSERT INTO servers (name, owner_id, invite_code, visibility, auto_join, kind) VALUES (?, ?, ?, 'public', 1, 'site')").run(name, owner, `inv-${name}`).lastInsertRowid;
  sf.ensureSiteDir(id);
  return id;
};

let server; let base; let alice; let bob; let siteA; let siteB;
const sessions = new Map();
const urlFor = (siteId, uid) => {
  if (!sessions.has(uid)) sessions.set(uid, createSession(uid, 'test', '127.0.0.1').token);
  return `${base}/site/${siteId}/~${siteViewToken.mint(siteId, uid, sessions.get(uid))}`;
};

test.before(async () => {
  sp.configure({
    maxWorkers: 2,
    launcher: ({ port, docroot }) => spawn(process.execPath, [FAKE, '-S', `127.0.0.1:${port}`, '-t', docroot], { stdio: 'ignore', windowsHide: true }),
  });
  alice = makeUser('ss_alice'); bob = makeUser('ss_bob');
  siteA = makeSite('A', alice); siteB = makeSite('B', alice);
  for (const s of [siteA, siteB]) for (const u of [alice, bob]) db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(s, u);
  sf.writeFile(siteA, 'page.html', Buffer.from('<html><head></head><body><script>1</script></body></html>'));
  sf.writeFile(siteA, 'plain.html', Buffer.from('<html><head></head><body>no script</body></html>'));
  sf.writeFile(siteA, 'index.php', Buffer.from('<?php'));
  const app = express();
  app.use('/site', createRouter());
  await new Promise((r) => { server = http.createServer(app).listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  sp.stopAll(); server.close(); db.close();
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const post = (url, body, ct = 'text/plain') => fetch(url, { method: 'POST', headers: { 'content-type': ct }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('local storage ops persist per viewer and site and never leak across them', () => {
  st.applyOps(siteA, alice, [{ t: 'set', k: 'theme', v: 'dark' }, { t: 'set', k: 'n', v: '1' }]);
  st.applyOps(siteA, bob, [{ t: 'set', k: 'theme', v: 'light' }]);
  st.applyOps(siteB, alice, [{ t: 'set', k: 'other', v: 'x' }]);
  assert.deepEqual(st.snapshot(siteA, alice).local, { theme: 'dark', n: '1' });
  assert.deepEqual(st.snapshot(siteA, bob).local, { theme: 'light' });
  assert.deepEqual(st.snapshot(siteB, alice).local, { other: 'x' });
  st.applyOps(siteA, alice, [{ t: 'del', k: 'n' }]);
  assert.deepEqual(st.snapshot(siteA, alice).local, { theme: 'dark' });
  st.applyOps(siteA, alice, [{ t: 'clear' }]);
  assert.deepEqual(st.snapshot(siteA, alice).local, {});
  assert.deepEqual(st.snapshot(siteA, bob).local, { theme: 'light' });
});

test('caps: oversized key/value, total quota and malformed ops are rejected and change nothing', () => {
  const carol = makeUser('ss_carol');
  const big = (n) => 'x'.repeat(n);
  assert.throws(() => st.applyOps(siteA, carol, [{ t: 'set', k: big(st.LIMITS.maxKey + 1), v: '1' }]), { status: 413 });
  assert.throws(() => st.applyOps(siteA, carol, [{ t: 'set', k: 'k', v: big(st.LIMITS.maxValue + 1) }]), { status: 413 });
  assert.throws(() => st.applyOps(siteA, carol, [{ t: 'set', k: 'k', v: 5 }]), { status: 413 });
  assert.throws(() => st.applyOps(siteA, carol, [{ t: 'nope' }]), { status: 400 });
  assert.throws(() => st.applyOps(siteA, carol, 'x'), { status: 400 });
  st.applyOps(siteA, carol, [{ t: 'set', k: 'a', v: big(400_000) }, { t: 'set', k: 'b', v: big(400_000) }]);
  assert.throws(() => st.applyOps(siteA, carol, [{ t: 'set', k: 'small', v: '1' }, { t: 'set', k: 'c', v: big(400_000) }]), { status: 413 });
  assert.deepEqual(Object.keys(st.snapshot(siteA, carol).local).sort(), ['a', 'b']);
  assert.throws(() => st.applyOps(siteA, carol, Array.from({ length: st.LIMITS.maxOps + 1 }, (_, i) => ({ t: 'del', k: `k${i}` }))), { status: 400 });
});

test('writes are rate limited per viewer and site', () => {
  const dave = makeUser('ss_dave');
  let hit = 0;
  for (let i = 0; i < st.LIMITS.writesPerMinute + 5; i++) {
    try { st.applyOps(siteB, dave, [{ t: 'set', k: 'k', v: String(i) }]); } catch (e) { assert.equal(e.status, 429); hit++; }
  }
  assert.equal(hit, 5);
  st.applyOps(siteA, dave, [{ t: 'set', k: 'k', v: '1' }]); // another site has its own budget
});

test('cookies: path scoping, expiry, deletion, httpOnly stays out of the page snapshot', () => {
  const eve = makeUser('ss_eve');
  st.applySetCookies(siteA, eve, ['sid=abc; Path=/; HttpOnly', 'theme=dark; Path=/app', 'tmp=1; Max-Age=60'], '/dir/page.php');
  assert.equal(st.cookieHeader(siteA, eve, '/x.php'), 'sid=abc');
  assert.equal(st.cookieHeader(siteA, eve, '/app/x.php'), 'theme=dark; sid=abc');
  assert.equal(st.cookieHeader(siteA, eve, '/appendix.php'), 'sid=abc');
  assert.equal(st.cookieHeader(siteA, eve, '/dir/other.php'), 'tmp=1; sid=abc'); // no Path: the request directory
  assert.equal(st.cookieHeader(siteB, eve, '/x.php'), '');
  const snap = st.snapshot(siteA, eve).cookies.map((c) => c.n).sort();
  assert.deepEqual(snap, ['theme', 'tmp']);
  st.applySetCookies(siteA, eve, ['tmp=; Max-Age=0; Path=/dir/'], '/dir/page.php');
  assert.doesNotMatch(st.cookieHeader(siteA, eve, '/dir/other.php'), /tmp/);
  st.applySetCookies(siteA, eve, [`old=1; Path=/; Expires=${new Date(Date.now() - 1000).toUTCString()}`], '/p.php');
  assert.doesNotMatch(st.cookieHeader(siteA, eve, '/p.php'), /old/);
  st.applyOps(siteA, eve, [{ t: 'cset', n: 'js', v: '1', p: '/', e: null }, { t: 'cdel', n: 'theme', p: '/app' }]);
  assert.deepEqual(st.snapshot(siteA, eve).cookies.map((c) => c.n), ['js']);
  assert.throws(() => st.applyOps(siteA, eve, [{ t: 'cset', n: 'bad name', v: '1' }]), { status: 400 });
});

test('indexedDB snapshots are per viewer and site, capped, and report their size in the page snapshot', () => {
  const finn = makeUser('ss_finn');
  assert.equal(st.getIdb(siteA, finn), null);
  st.putIdb(siteA, finn, '{"v":1,"dbs":[]}');
  assert.equal(st.getIdb(siteA, finn), '{"v":1,"dbs":[]}');
  assert.equal(st.getIdb(siteB, finn), null);
  assert.equal(st.getIdb(siteA, alice), null);
  assert.equal(st.snapshot(siteA, finn).idb, 16);
  assert.throws(() => st.putIdb(siteA, finn, 'x'.repeat(st.LIMITS.maxIdbBytes + 1)), { status: 413 });
  assert.equal(st.getIdb(siteA, finn), '{"v":1,"dbs":[]}');
});

test('deleting a site or a user removes their storage rows', () => {
  const gone = makeUser('ss_gone');
  const tmpSite = makeSite('tmp', alice);
  st.applyOps(tmpSite, gone, [{ t: 'set', k: 'a', v: '1' }]);
  st.putIdb(tmpSite, gone, '{}');
  db.prepare('DELETE FROM servers WHERE id = ?').run(tmpSite);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM site_storage WHERE site_id = ?').get(tmpSite).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM site_idb WHERE site_id = ?').get(tmpSite).n, 0);
});

test('HTML pages embed only the viewing user\'s snapshot, plus the shim; scriptless pages skip the IndexedDB shim', async () => {
  st.applyOps(siteA, alice, [{ t: 'set', k: 'who', v: 'alice-secret' }]);
  st.applyOps(siteA, bob, [{ t: 'set', k: 'who', v: 'bob-secret' }]);
  const a = await (await fetch(`${urlFor(siteA, alice)}/page.html`)).text();
  assert.match(a, /alice-secret/);
  assert.doesNotMatch(a, /bob-secret/);
  assert.match(a, /__shim\.js/);
  assert.match(a, /__idb\.js/);
  const b = await (await fetch(`${urlFor(siteA, bob)}/page.html`)).text();
  assert.match(b, /bob-secret/);
  assert.doesNotMatch(b, /alice-secret/);
  const plain = await (await fetch(`${urlFor(siteA, alice)}/plain.html`)).text();
  assert.match(plain, /__shim\.js/);
  assert.doesNotMatch(plain, /__idb\.js/);
  st.applyOps(siteB, alice, [{ t: 'set', k: 'who', v: 'site-b' }]);
  assert.doesNotMatch(a, /site-b/);
});

test('a snapshot value cannot close the script tag', async () => {
  st.applyOps(siteA, alice, [{ t: 'set', k: 'x', v: '</script><img src=x onerror=alert(1)>' }]);
  const html = await (await fetch(`${urlFor(siteA, alice)}/page.html`)).text();
  assert.doesNotMatch(html, /<\/script><img/);
  assert.match(html, /\\u003c\/script>/);
});

test('shim and indexedDB assets are served; the storage endpoints need the token and answer CORS', async () => {
  const u = urlFor(siteA, alice);
  const shim = await fetch(`${u}/__shim.js`);
  assert.equal(shim.status, 200);
  assert.match(await shim.text(), /__mcSite/);
  assert.equal(shim.headers.get('access-control-allow-origin'), '*');
  const idb = await fetch(`${u}/__idb.js`);
  assert.equal(idb.status, 200);
  assert.match(idb.headers.get('content-type'), /javascript/);
  assert.equal((await fetch(`${base}/site/${siteA}/__shim.js`)).status, 401);
  assert.equal((await post(`${base}/site/${siteA}/__storage`, [])).status, 401);
  const pre = await fetch(`${u}/__storage`, { method: 'OPTIONS', headers: { 'access-control-request-headers': 'content-type' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
});

test('POST /__storage applies the ops of the token\'s user and site only', async () => {
  const u = urlFor(siteA, bob);
  const r = await post(`${u}/__storage`, [{ t: 'set', k: 'viaHttp', v: 'yes' }, { t: 'cset', n: 'c1', v: 'v1', p: '/', e: null }]);
  assert.equal(r.status, 204);
  assert.equal(st.snapshot(siteA, bob).local.viaHttp, 'yes');
  assert.equal(st.snapshot(siteA, bob).cookies.find((c) => c.n === 'c1').v, 'v1');
  assert.equal(st.snapshot(siteA, alice).local.viaHttp, undefined);
  assert.equal(st.snapshot(siteB, bob).local.viaHttp, undefined);
  assert.equal((await post(`${u}/__storage`, 'not json')).status, 400);
  assert.equal((await post(`${u}/__storage`, [{ t: 'set', k: 'k', v: 'x'.repeat(st.LIMITS.maxValue + 1) }])).status, 413);
  assert.equal((await fetch(`${u}/__storage`)).status, 405);
});

test('POST/GET /__idb stores the snapshot, enforces the cap, and a missing snapshot is 204', async () => {
  const u = urlFor(siteB, bob);
  assert.equal((await fetch(`${u}/__idb`)).status, 204);
  assert.equal((await post(`${u}/__idb`, '{"v":1,"dbs":[{"name":"d"}]}')).status, 204);
  assert.equal(await (await fetch(`${u}/__idb`)).text(), '{"v":1,"dbs":[{"name":"d"}]}');
  assert.equal(await (await fetch(`${urlFor(siteB, alice)}/__idb`)).status, 204);
  const tooBig = await post(`${u}/__idb`, 'x'.repeat(st.LIMITS.maxIdbBytes + 2048));
  assert.equal(tooBig.status, 413);
  assert.equal(await (await fetch(`${u}/__idb`)).text(), '{"v":1,"dbs":[{"name":"d"}]}');
});

test('php pages get the viewer\'s cookies, their Set-Cookie is stored per viewer, html gets the shim', async () => {
  const dana = makeUser('ss_dana');
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(siteA, dana);
  const u = urlFor(siteA, dana);
  const first = await fetch(`${u}/index.php`);
  assert.equal(first.headers.get('x-saw-cookie'), 'no');
  assert.equal(first.headers.get('set-cookie'), null);
  assert.match(await first.text(), /__shim\.js/);
  const second = await fetch(`${u}/index.php`);
  assert.equal(second.headers.get('x-saw-cookie'), 'yes');
  const gus = makeUser('ss_gus');
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(siteA, gus);
  const other = await fetch(`${urlFor(siteA, gus)}/index.php`, { headers: { cookie: 'x=1' } });
  assert.equal(other.headers.get('x-saw-cookie'), 'no'); // the browser's own cookie is never forwarded and dana's are not gus's
});

test('trusted sites mode: no sandbox in the CSP and no shims; default mode is sandboxed with shims', async () => {
  const t = makeSite('trusty', alice);
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(t, alice);
  sf.writeFile(t, 'page.html', Buffer.from('<html><head></head><body><script>1</script></body></html>'));
  const sandboxed = await fetch(`${urlFor(t, alice)}/page.html`);
  assert.match(sandboxed.headers.get('content-security-policy'), /^sandbox allow-scripts /);
  assert.match(await sandboxed.text(), /__shim\.js/);
  db.prepare('UPDATE servers SET site_trusted = 1 WHERE id = ?').run(t);
  const trusted = await fetch(`${urlFor(t, alice)}/page.html`);
  const csp = trusted.headers.get('content-security-policy');
  assert.doesNotMatch(csp, /sandbox/);
  assert.match(csp, /frame-ancestors 'self'/);
  const html = await trusted.text();
  assert.doesNotMatch(html, /__shim\.js|__mcSite/);
  assert.match(html, /__site\.js/);
});
