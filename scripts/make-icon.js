'use strict';

// Regenerates electron/icon.png and electron/icon.ico (the exe/window icon) from the brand mark:
// the white ghost on the teal tile used for Home in the server rail. Run with Electron, which is
// already a dependency and gives us a real SVG renderer:
//   node_modules/electron/dist/electron.exe scripts/make-icon.js

const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '..', 'electron');
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const BRAND = '#0d9488';

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <rect width="256" height="256" rx="60" fill="${BRAND}"/>
  <g transform="translate(128 128) scale(10.2) translate(-12 -12)">
    <path d="M6 8c0-2.2 2.7-4 6-4s6 1.8 6 4v6.5c0 3.6-3.1 5.5-6 5.5s-6-1.9-6-5.5z" fill="#fff"/>
    <circle cx="9.5" cy="12" r="1.3" fill="${BRAND}"/>
    <circle cx="14.5" cy="12" r="1.3" fill="${BRAND}"/>
  </g>
</svg>`;

// ICO container holding PNG-compressed images (supported since Windows Vista).
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, png } of images) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 256, height: 256, useContentSize: true, transparent: true, frame: false, webPreferences: { offscreen: false } });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<style>html,body{margin:0;background:transparent;overflow:hidden}</style>${SVG}`)}`);
  await new Promise((r) => setTimeout(r, 300));
  const big = (await win.webContents.capturePage({ x: 0, y: 0, width: 256, height: 256 }));
  const images = SIZES.map((size) => ({ size, png: (size === 256 ? big : big.resize({ width: size, height: size, quality: 'best' })).toPNG() }));
  fs.writeFileSync(path.join(OUT, 'icon.png'), images[images.length - 1].png);
  fs.writeFileSync(path.join(OUT, 'icon.ico'), buildIco(images));
  console.log('wrote electron/icon.png and electron/icon.ico');
  app.quit();
});
