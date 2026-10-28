'use strict';

// Assembles the standalone, portable desktop client into ./Client:
//   Client/MeshCrowd.exe        the Electron runtime, renamed
//   Client/resources/app/       electron/ (main, preload, tray icon, connect screen)
//   Client/data/                created on first run - settings, login and caches live here, not in %APPDATA%
// Copy the Client folder anywhere (USB stick, another PC) and run MeshCrowd.exe. The client only
// needs a MeshCrowd server's address; it carries no server or web files of its own.
// Run from the project root: `npm run build:client`

const fs = require('node:fs');
const { rcedit } = require('rcedit');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'Client');
const ELECTRON_DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');
const KEEP_LOCALES = new Set(['en-US.pak', 'hu.pak']);

function copyDir(src, dest, skip = () => false) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (skip(from, entry)) continue;
    if (entry.isDirectory()) copyDir(from, to, skip);
    else fs.copyFileSync(from, to);
  }
}

async function main() {
  if (process.platform !== 'win32') {
    console.error('[build-client] this script builds the Windows client (MeshCrowd.exe); run it on Windows.');
    process.exit(1);
  }
  if (!fs.existsSync(path.join(ELECTRON_DIST, 'electron.exe'))) {
    console.error('[build-client] Electron is not installed. Run `npm install` first.');
    process.exit(1);
  }

  // Keep a previous install's settings and login when rebuilding in place.
  const dataDir = path.join(OUT, 'data');
  const keptData = fs.existsSync(dataDir) ? fs.mkdtempSync(path.join(ROOT, '.client-data-')) : null;
  if (keptData) fs.renameSync(dataDir, path.join(keptData, 'data'));
  fs.rmSync(OUT, { recursive: true, force: true });

  console.log('[build-client] copying the Electron runtime...');
  copyDir(ELECTRON_DIST, OUT, (from) => {
    const rel = path.relative(ELECTRON_DIST, from).replace(/\\/g, '/');
    if (rel === 'resources/default_app.asar') return true;
    if (rel.startsWith('locales/') && !KEEP_LOCALES.has(path.basename(from))) return true;
    return false;
  });
  const exe = path.join(OUT, 'MeshCrowd.exe');
  fs.renameSync(path.join(OUT, 'electron.exe'), exe);

  console.log('[build-client] copying the client code...');
  const appDir = path.join(OUT, 'resources', 'app');
  copyDir(path.join(ROOT, 'electron'), appDir);
  const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({
    name: 'meshcrowd-client',
    productName: 'MeshCrowd',
    version: rootPkg.version,
    description: 'MeshCrowd desktop client',
    main: 'main.js',
  }, null, 2));

  console.log('[build-client] stamping icon and version info...');
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  await rcedit(exe, {
    icon: path.join(ROOT, 'electron', 'icon.ico'),
    'file-version': version,
    'product-version': version,
    'version-string': {
      ProductName: 'MeshCrowd',
      FileDescription: 'MeshCrowd',
      InternalName: 'MeshCrowd',
      OriginalFilename: 'MeshCrowd.exe',
      CompanyName: 'MeshCrowd',
    },
  });

  if (keptData) {
    fs.renameSync(path.join(keptData, 'data'), dataDir);
    fs.rmSync(keptData, { recursive: true, force: true });
  } else {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Manual alternative to Settings > Desktop App > "Open mcr:// invite links": per-user registry keys, no admin needed.
  fs.writeFileSync(path.join(OUT, 'register-mcr-protocol.bat'), [
    '@echo off',
    'set "EXE=%~dp0MeshCrowd.exe"',
    'reg add "HKCU\\Software\\Classes\\mcr" /ve /d "URL:MeshCrowd invite" /f >nul',
    'reg add "HKCU\\Software\\Classes\\mcr" /v "URL Protocol" /d "" /f >nul',
    'reg add "HKCU\\Software\\Classes\\mcr\\shell\\open\\command" /ve /d "\\\"%EXE%\\\" \\\"%%1\\\"" /f >nul',
    'echo mcr:// links now open in %EXE%',
    'echo Run this again if you move the folder.',
    'pause',
    '',
  ].join('\r\n'));
  fs.writeFileSync(path.join(OUT, 'unregister-mcr-protocol.bat'), [
    '@echo off',
    'reg delete "HKCU\\Software\\Classes\\mcr" /f',
    'pause',
    '',
  ].join('\r\n'));

  fs.writeFileSync(path.join(OUT, 'README.txt'), [
    'MeshCrowd desktop client (portable)',
    '',
    '1. Run MeshCrowd.exe.',
    '2. On first start enter your server address, e.g. https://192.168.1.10:8443',
    '   (a self-signed server certificate asks you to trust it once).',
    '',
    'Everything the client stores - server address, trusted certificates, login, caches -',
    'lives in the "data" folder next to MeshCrowd.exe, so the whole folder can be copied',
    'to another PC or a USB stick. Delete "data" to start from scratch.',
    '',
    'The client registers itself for mcr:// invite links on every start (so moving the folder or losing the',
    'registry entry is repaired by just starting it again). Turn it off in Settings > Desktop App, or use',
    'register-mcr-protocol.bat / unregister-mcr-protocol.bat by hand. Links always ask before joining.',
    '',
    'Only one MeshCrowd runs per folder; starting it again brings the open window to the front.',
    '',
  ].join('\r\n'));

  console.log('[build-client] done:', OUT);
}

main().catch((err) => { console.error(err); process.exit(1); });
