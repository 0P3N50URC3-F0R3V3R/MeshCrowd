'use strict';

// Bundles mediasoup-client into one minified ES module served by the normal static handler. Dev-only:
// `npm install` then `npm run build:vendor`; the generated web/js/vendor/mediasoup-client.js is committed.

const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'web', 'js', 'vendor', 'mediasoup-client.js');
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'mediasoup-client', 'package.json'), 'utf8'));

esbuild.buildSync({
  stdin: {
    contents: "export { Device, version } from 'mediasoup-client';",
    resolveDir: ROOT,
    loader: 'js'
  },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome110',
  minify: true,
  legalComments: 'none',
  banner: { js: `/* mediasoup-client ${version} bundled by scripts/build-vendor.js */` },
  outfile: OUT
});

console.log(`[build-vendor] mediasoup-client ${version} -> ${path.relative(ROOT, OUT)} (${fs.statSync(OUT).size} bytes)`);

// Site IndexedDB shim: fake-indexeddb plus snapshot restore/persist (scripts/site-idb-entry.js), served to Site pages
// as an IIFE at /site/<id>/~<token>/__idb.js. Needs the dev dependency fake-indexeddb.
const IDB_OUT = path.join(ROOT, 'server', 'assets', 'site-idb.js');
const idbVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'fake-indexeddb', 'package.json'), 'utf8')).version;
esbuild.buildSync({
  entryPoints: [path.join(__dirname, 'site-idb-entry.js')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome110',
  minify: true,
  legalComments: 'none',
  banner: { js: `/* fake-indexeddb ${idbVersion} + MeshCrowd persistence, bundled by scripts/build-vendor.js */` },
  outfile: IDB_OUT
});
console.log(`[build-vendor] site-idb (fake-indexeddb ${idbVersion}) -> ${path.relative(ROOT, IDB_OUT)} (${fs.statSync(IDB_OUT).size} bytes)`);
