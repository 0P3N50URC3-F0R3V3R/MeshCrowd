'use strict';

// Hand-rolled minimal PNG encoder + pixel-buffer drawing (filled circles, rounded rects, a tiny
// 3x5 digit font) so the tray icon and its unread badge need no bundled image asset, no canvas,
// and no image-processing dependency — just zlib, which is already built in. Pure Node (no
// Electron API), split out from main.js so it can be required and tested standalone.
const zlib = require('node:zlib');

const ICON_SIZE = 48;
const BRAND = [0x0d, 0x94, 0x88];
const STATUS_COLORS = {
  online: [0x23, 0xa5, 0x5a],
  idle: [0xf0, 0xb2, 0x32],
  dnd: [0xf2, 0x3f, 0x43],
  invisible: [0x80, 0x84, 0x8e],
  offline: [0x80, 0x84, 0x8e],
};

function encodePNG(size, rgba) {
  const chunk = (type, data) => {
    const typeBuf = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([typeBuf, data])) >>> 0);
    return Buffer.concat([len, typeBuf, data, crc]);
  };
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(size, 0); ihdrData.writeUInt32BE(size, 4);
  ihdrData[8] = 8; ihdrData[9] = 6; // 8-bit RGBA
  const rowLen = size * 4 + 1;
  const raw = Buffer.alloc(rowLen * size);
  for (let y = 0; y < size; y++) {
    raw[y * rowLen] = 0; // no filter
    rgba.copy(raw, y * rowLen + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdrData),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function newCanvas(size) {
  return Buffer.alloc(size * size * 4); // all-zero = fully transparent
}

function setPx(buf, size, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const p = (y * size + x) * 4;
  // Straight alpha-composite over whatever's already there, not a blind overwrite — the badge
  // pill's antialiased edge sits on top of the base circle, not a hard-edged cutout of it.
  const srcA = a / 255;
  buf[p] = Math.round(r * srcA + buf[p] * (1 - srcA));
  buf[p + 1] = Math.round(g * srcA + buf[p + 1] * (1 - srcA));
  buf[p + 2] = Math.round(b * srcA + buf[p + 2] * (1 - srcA));
  buf[p + 3] = Math.round(a + buf[p + 3] * (1 - srcA));
}

function fillCircle(buf, size, cx, cy, radius, [r, g, b]) {
  for (let y = Math.floor(cy - radius) - 1; y <= Math.ceil(cy + radius) + 1; y++) {
    for (let x = Math.floor(cx - radius) - 1; x <= Math.ceil(cx + radius) + 1; x++) {
      const dx = x + 0.5 - cx; const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= radius * radius) setPx(buf, size, x, y, r, g, b, 255);
    }
  }
}

function fillRoundedRect(buf, size, x0, y0, w, h, radius, [r, g, b]) {
  for (let y = Math.floor(y0) - 1; y <= Math.ceil(y0 + h) + 1; y++) {
    for (let x = Math.floor(x0) - 1; x <= Math.ceil(x0 + w) + 1; x++) {
      const cx = Math.min(Math.max(x + 0.5, x0 + radius), x0 + w - radius);
      const cy = Math.min(Math.max(y + 0.5, y0 + radius), y0 + h - radius);
      const dx = x + 0.5 - cx; const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= radius * radius) setPx(buf, size, x, y, r, g, b, 255);
    }
  }
}

// Tiny 3-wide/5-tall digit font (each row a bitmask of which of the 3 columns is lit), plus '+'
// for the "99+" overflow cap — legible enough at 2x scale on a 22px-tall badge.
const DIGIT_FONT = {
  0: ['111', '101', '101', '101', '111'], 1: ['010', '110', '010', '010', '111'],
  2: ['111', '001', '111', '100', '111'], 3: ['111', '001', '111', '001', '111'],
  4: ['101', '101', '111', '001', '001'], 5: ['111', '100', '111', '001', '111'],
  6: ['111', '100', '111', '101', '111'], 7: ['111', '001', '010', '010', '010'],
  8: ['111', '101', '111', '101', '111'], 9: ['111', '101', '111', '001', '111'],
  '+': ['000', '010', '111', '010', '000'],
};
const GLYPH_SCALE = 2;
const GLYPH_W = 3 * GLYPH_SCALE;
const GLYPH_H = 5 * GLYPH_SCALE;
const GLYPH_GAP = 1;

function textWidth(text) {
  return text.length * GLYPH_W + (text.length - 1) * GLYPH_GAP;
}

function drawText(buf, size, text, left, top, [r, g, b]) {
  let x = left;
  for (const ch of text) {
    const glyph = DIGIT_FONT[ch];
    if (glyph) {
      for (let gy = 0; gy < 5; gy++) {
        for (let gx = 0; gx < 3; gx++) {
          if (glyph[gy][gx] !== '1') continue;
          for (let sy = 0; sy < GLYPH_SCALE; sy++) {
            for (let sx = 0; sx < GLYPH_SCALE; sx++) {
              setPx(buf, size, x + gx * GLYPH_SCALE + sx, top + gy * GLYPH_SCALE + sy, r, g, b, 255);
            }
          }
        }
      }
    }
    x += GLYPH_W + GLYPH_GAP;
  }
}

// The brand ghost (same shape as the rail's Home icon, in its 24x24 design space) laid over the base
// circle. Anti-aliased by 4x4 supersampling since there is no canvas to lean on.
function insideGhost(u, v) {
  if (v >= 4 && v < 8) { const dx = (u - 12) / 6; const dy = (v - 8) / 4; return dx * dx + dy * dy <= 1; }
  if (v >= 8 && v <= 14.5) return u >= 6 && u <= 18;
  if (v > 14.5 && v <= 20) { const dx = (u - 12) / 6; const dy = (v - 14.5) / 5.5; return dx * dx + dy * dy <= 1; }
  return false;
}
function insideEye(u, v) {
  return [9.5, 14.5].some((cx) => (u - cx) * (u - cx) + (v - 12) * (v - 12) <= 1.3 * 1.3);
}

function drawGhost(buf, size, baseColor) {
  // A light user-chosen base color would swallow a white ghost, so flip to a dark one there.
  const luminance = (0.2126 * baseColor[0] + 0.7152 * baseColor[1] + 0.0722 * baseColor[2]) / 255;
  const ghostColor = luminance > 0.72 ? [0x1e, 0x1f, 0x22] : [255, 255, 255];
  const scale = size * 0.58 / 16; // ghost is 16 units tall; ~58% of the icon
  const ox = size / 2 - 12 * scale; const oy = size / 2 - 12 * scale;
  const SS = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let ghost = 0; let eyes = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS - ox) / scale;
          const v = (y + (sy + 0.5) / SS - oy) / scale;
          if (insideGhost(u, v)) { ghost++; if (insideEye(u, v)) eyes++; }
        }
      }
      if (ghost - eyes > 0) setPx(buf, size, x, y, ghostColor[0], ghostColor[1], ghostColor[2], Math.round(255 * (ghost - eyes) / (SS * SS)));
    }
  }
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

// '#rrggbb' -> [r,g,b], falling back to `fallback` for anything not a clean 6-digit hex - this
// feeds straight into a hand-rolled pixel buffer with no other validation downstream, so a
// malformed per-user color must never reach fillCircle/fillRoundedRect.
function hexToRgb(hex, fallback) {
  if (typeof hex !== 'string' || !HEX_RE.test(hex)) return fallback;
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

let cachedPlainIconPNG = null;
let cachedPlainIconTheme = null;

// Builds the tray icon PNG: the plain circle (brand color by default, or the user's own
// customized base/badge colors - see Settings > Desktop App > Tray Icon), or — when there's
// something unread — the same circle with a presence-colored badge showing the unread count,
// capped at "99+" so the pill never has to grow past a couple of characters. `theme`, when given,
// is `{ baseColor, badgeColors: { online, idle, dnd, offline } }`, each an optional '#rrggbb'.
function buildTrayIconPNG({ status, count }, theme) {
  const baseColor = hexToRgb(theme?.baseColor, BRAND);
  const badgeColor = hexToRgb(theme?.badgeColors?.[status], STATUS_COLORS[status] || STATUS_COLORS.online);

  if (!count || count <= 0) {
    // Only the truly-default theme is cacheable across calls - a custom base color still only
    // needs computing once per process, but must not be cached under the *default* key, or a
    // customized user would see the plain brand circle the first time some other code path
    // (there is none today, but the cache predates per-user theming) requested the default.
    const cacheKey = theme?.baseColor || '';
    if (cachedPlainIconTheme !== cacheKey) {
      const buf = newCanvas(ICON_SIZE);
      fillCircle(buf, ICON_SIZE, ICON_SIZE / 2, ICON_SIZE / 2, ICON_SIZE / 2 - 1, baseColor);
      drawGhost(buf, ICON_SIZE, baseColor);
      cachedPlainIconPNG = encodePNG(ICON_SIZE, buf);
      cachedPlainIconTheme = cacheKey;
    }
    return cachedPlainIconPNG;
  }

  const buf = newCanvas(ICON_SIZE);
  fillCircle(buf, ICON_SIZE, ICON_SIZE / 2, ICON_SIZE / 2, ICON_SIZE / 2 - 1, baseColor);
  drawGhost(buf, ICON_SIZE, baseColor);

  const label = count > 99 ? '99+' : String(count);
  const padX = 5;
  const pillH = GLYPH_H + 8;
  const pillW = Math.max(pillH, textWidth(label) + padX * 2);
  const pillX = ICON_SIZE - pillW - 1;
  const pillY = ICON_SIZE - pillH - 1;
  fillRoundedRect(buf, ICON_SIZE, pillX, pillY, pillW, pillH, pillH / 2, badgeColor);
  drawText(buf, ICON_SIZE, label, pillX + (pillW - textWidth(label)) / 2, pillY + (pillH - GLYPH_H) / 2, [255, 255, 255]);

  return encodePNG(ICON_SIZE, buf);
}

module.exports = { ICON_SIZE, buildTrayIconPNG, encodePNG, newCanvas, fillCircle, fillRoundedRect, drawText, textWidth };
