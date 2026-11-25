'use strict';

const zlib = require('node:zlib');

const chunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0);
  return Buffer.concat([head, data, crc]);
};

// A real PNG for tests. pixel(x, y) -> [r, g, b, a]; color 6 = RGBA, 2 = RGB, 3 = palette (pixel returns the index).
function makePng(w, h, { pixel = (x, y) => [(x * 7) & 255, (y * 5) & 255, ((x + y) * 3) & 255, 255], color = 6, depth = 8, interlace = 0, palette = null, extra = [] } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = depth; ihdr[9] = color; ihdr[12] = interlace;
  const channels = { 2: 3, 3: 1, 6: 4 }[color];
  const bytesPer = depth === 16 ? 2 : 1;
  const bits = channels * depth;
  const rowBytes = Math.ceil((w * bits) / 8);
  const raw = Buffer.alloc((rowBytes + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (rowBytes + 1) + 1;
    for (let x = 0; x < w; x++) {
      const p = pixel(x, y);
      if (color === 3) {
        const perByte = 8 / depth;
        const shift = 8 - depth * ((x % perByte) + 1);
        raw[o + Math.floor(x / perByte)] |= (p[0] & ((1 << depth) - 1)) << shift;
      } else {
        for (let c = 0; c < channels; c++) {
          if (bytesPer === 2) { raw[o + (x * channels + c) * 2] = p[c]; raw[o + (x * channels + c) * 2 + 1] = p[c]; } else raw[o + x * channels + c] = p[c];
        }
      }
    }
  }
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)];
  if (palette) parts.push(chunk('PLTE', Buffer.from(palette.flat())));
  for (const [type, data] of extra) parts.push(chunk(type, data));
  parts.push(chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

const noise = (x, y) => { let n = (x * 374761393 + y * 668265263) >>> 0; n = ((n ^ (n >>> 13)) * 1274126177) >>> 0; return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, 255]; };

module.exports = { makePng, noise, chunk };
