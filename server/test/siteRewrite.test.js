'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { rewriteHtml, rewriteCss, rewriteLocation, LOADER_JS } = require('../lib/siteRewrite');

const P = '/site/12';

test('root-absolute href/src/action get the prefix; relative, protocol-relative, external and already-prefixed do not', () => {
  const html = '<a href="/a.php">1</a><img src=\'/img/x.png\'><form action="/post.php"></form>'
    + '<a href="b.php">2</a><a href="//cdn.x.com/y.js">3</a><a href="https://x.com/z">4</a><a href="/site/12/c.php">5</a>';
  const out = rewriteHtml(html, P);
  assert.match(out, /href="\/site\/12\/a\.php"/);
  assert.match(out, /src='\/site\/12\/img\/x\.png'/);
  assert.match(out, /action="\/site\/12\/post\.php"/);
  assert.match(out, /href="b\.php"/);
  assert.match(out, /href="\/\/cdn\.x\.com\/y\.js"/);
  assert.match(out, /href="https:\/\/x\.com\/z"/);
  assert.match(out, /href="\/site\/12\/c\.php"/);
  assert.doesNotMatch(out, /\/site\/12\/site\/12/);
});

test('the loader script tag is injected after <head>, else after the doctype, else first', () => {
  assert.match(rewriteHtml('<!doctype html><html><head><title>t</title></head><body></body></html>', P), /<head><script src="\/site\/12\/__site\.js"><\/script><title>/);
  assert.match(rewriteHtml('<!doctype html><p>x</p>', P), /^<!doctype html><script src="\/site\/12\/__site\.js"><\/script><p>/);
  assert.match(rewriteHtml('<p>x</p>', P), /^<script src="\/site\/12\/__site\.js"><\/script><p>/);
});

test('rewriteCss prefixes root-absolute url() only', () => {
  const css = 'a{background:url(/img/a.png)} b{background:url("/img/b.png")} c{background:url(img/c.png)} d{background:url(//x.com/d.png)} e{background:url(https://x.com/e.png)}';
  const out = rewriteCss(css, P);
  assert.match(out, /url\(\/site\/12\/img\/a\.png\)/);
  assert.match(out, /url\("\/site\/12\/img\/b\.png"\)/);
  assert.match(out, /url\(img\/c\.png\)/);
  assert.match(out, /url\(\/\/x\.com\/d\.png\)/);
});

test('rewriteLocation prefixes site-absolute redirects and leaves everything else alone', () => {
  assert.equal(rewriteLocation('/login.php', P), '/site/12/login.php');
  assert.equal(rewriteLocation('/site/12/login.php', P), '/site/12/login.php');
  assert.equal(rewriteLocation('//evil.com/x', P), '//evil.com/x');
  assert.equal(rewriteLocation('https://jellyfin.lan/', P), 'https://jellyfin.lan/');
  assert.equal(rewriteLocation('next.php', P), 'next.php');
});

test('LOADER_JS reports external navigations to the parent frame', () => {
  assert.match(LOADER_JS, /site-open-external/);
  assert.match(LOADER_JS, /window\.open/);
  assert.match(LOADER_JS, /parent\.postMessage/);
});
