'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pickUi, uiMiddleware, fallbackHandler } = require('../lib/uiRouting');

const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36';
const ELECTRON = `${DESKTOP} Electron/31.0.0`;
const WEBVIEW = 'Mozilla/5.0 (Linux; U; Linux 14) MeshCrowdAndroid/1';

test('pickUi: Android and the APK WebView token are mobile, desktop browsers and Electron are desktop', () => {
  assert.equal(pickUi({ userAgent: ANDROID }), 'mobile');
  assert.equal(pickUi({ userAgent: WEBVIEW }), 'mobile');
  assert.equal(pickUi({ userAgent: DESKTOP }), 'desktop');
  assert.equal(pickUi({ userAgent: ELECTRON }), 'desktop');
  assert.equal(pickUi({}), 'desktop');
});

test('pickUi: the ui cookie overrides the UA, but Electron is always desktop', () => {
  assert.equal(pickUi({ userAgent: ANDROID, cookie: 'a=1; ui=desktop' }), 'desktop');
  assert.equal(pickUi({ userAgent: WEBVIEW, cookie: 'ui=desktop' }), 'desktop');
  assert.equal(pickUi({ userAgent: DESKTOP, cookie: 'ui=mobile' }), 'mobile');
  assert.equal(pickUi({ userAgent: ELECTRON, cookie: 'ui=mobile' }), 'desktop');
  assert.equal(pickUi({ userAgent: ANDROID, cookie: 'ui=bogus' }), 'mobile');
});

function run(url, headers = {}, method = 'GET') {
  const u = new URL(url, 'http://x');
  const out = { next: false, redirect: null, sent: null, headers: {} };
  const req = { method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers };
  const res = {
    setHeader(k, v) { out.headers[k.toLowerCase()] = v; },
    redirect(code, loc) { out.redirect = [code, loc]; },
    sendFile(p) { out.sent = p; },
  };
  uiMiddleware('/web')(req, res, () => { out.next = true; });
  return out;
}

test('middleware: Android / is redirected to /m/, desktop / serves index.html', () => {
  assert.deepEqual(run('/', { 'user-agent': ANDROID }).redirect, [302, '/m/']);
  assert.equal(run('/', { 'user-agent': DESKTOP }).sent, path.join('/web', 'index.html'));
  assert.deepEqual(run('/index.html', { 'user-agent': ANDROID }).redirect, [302, '/m/']);
});

test('middleware: only GET/HEAD of / and /index.html are handled', () => {
  assert.equal(run('/js/main.js', { 'user-agent': ANDROID }).next, true);
  assert.equal(run('/m/', { 'user-agent': ANDROID }).next, true);
  assert.equal(run('/', { 'user-agent': ANDROID }, 'POST').next, true);
  assert.equal(run('/', { 'user-agent': ANDROID }, 'HEAD').redirect[1], '/m/');
});

test('middleware: ?ui= sets a one-year cookie and redirects; WebView + ui=desktop stays desktop', () => {
  const m = run('/?ui=mobile', { 'user-agent': DESKTOP });
  assert.deepEqual(m.redirect, [302, '/m/']);
  assert.match(m.headers['set-cookie'], /^ui=mobile; Max-Age=31536000; Path=\/; SameSite=Lax/);
  const d = run('/?ui=desktop', { 'user-agent': WEBVIEW });
  assert.deepEqual(d.redirect, [302, '/']);
  assert.match(d.headers['set-cookie'], /^ui=desktop;/);
  assert.equal(run('/', { 'user-agent': WEBVIEW, cookie: 'ui=desktop' }).sent, path.join('/web', 'index.html'));
  assert.equal(run('/?ui=evil', { 'user-agent': DESKTOP }).sent, path.join('/web', 'index.html'));
});

test('middleware: responses vary on UA and cookie and are not cached', () => {
  const r = run('/', { 'user-agent': ANDROID });
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.headers.vary, 'User-Agent, Cookie');
});

test('middleware: inside the APK WebView the ui cookie is a session cookie so the choice is not permanent', () => {
  const d = run('/?ui=desktop', { 'user-agent': WEBVIEW });
  assert.equal(d.headers['set-cookie'], 'ui=desktop; Path=/; SameSite=Lax');
  const m = run('/?ui=mobile', { 'user-agent': WEBVIEW });
  assert.equal(m.headers['set-cookie'], 'ui=mobile; Path=/; SameSite=Lax');
  assert.match(run('/?ui=desktop', { 'user-agent': ANDROID }).headers['set-cookie'], /Max-Age=31536000/);
});

test('middleware: Electron never gets the mobile UI, even with ?ui=mobile', () => {
  const r = run('/?ui=mobile', { 'user-agent': ELECTRON });
  assert.equal(r.redirect, null);
  assert.equal(r.sent, path.join('/web', 'index.html'));
});

test('middleware: the ui cookie is Secure over https', () => {
  const secure = run('/?ui=desktop', { 'user-agent': DESKTOP, 'x-forwarded-proto': 'https' });
  assert.match(secure.headers['set-cookie'], /; Secure$/);
  assert.doesNotMatch(run('/?ui=desktop', { 'user-agent': DESKTOP }).headers['set-cookie'], /Secure/);
});

test('fallbackHandler: unknown paths get the page that matches the UI', () => {
  const send = (headers) => { let sent = null; fallbackHandler('/web')({ headers }, { sendFile: (p) => { sent = p; } }); return sent; };
  assert.equal(send({ 'user-agent': ANDROID }), path.join('/web', 'm', 'index.html'));
  assert.equal(send({ 'user-agent': DESKTOP }), path.join('/web', 'index.html'));
  assert.equal(send({ 'user-agent': ANDROID, cookie: 'ui=desktop' }), path.join('/web', 'index.html'));
});
