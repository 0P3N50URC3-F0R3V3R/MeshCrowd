'use strict';

const zlib = require('node:zlib');
const crypto = require('node:crypto');

// 5x7 bitmap glyphs. The challenge is drawn as pixels, never as text or vector paths, so the
// answer is not readable from the response the way an SVG <text> element would be.
const GLYPHS = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  0: ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  1: ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  3: ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
  4: ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  5: ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  6: ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  7: ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  8: ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  9: ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  '+': ['.....', '..#..', '..#..', '#####', '..#..', '..#..', '.....'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  '=': ['.....', '.....', '#####', '.....', '#####', '.....', '.....'],
  '?': ['.###.', '#...#', '....#', '..##.', '..#..', '.....', '..#..'],
};
const BITMAPS = Object.fromEntries(Object.entries(GLYPHS).map(([k, rows]) => [k, rows.map((r) => [...r].map((c) => (c === '#' ? 1 : 0)))]));

const LEVELS = {
  easy: { rotate: 0.12, wave: 1.2, lines: 1, dots: 40, jitter: 0.06, strike: false },
  medium: { rotate: 0.26, wave: 2.6, lines: 3, dots: 110, jitter: 0.1, strike: false },
  hard: { rotate: 0.4, wave: 4, lines: 5, dots: 220, jitter: 0.16, strike: true },
};

function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c; let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgb, w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const rnd = () => crypto.randomInt(0, 1_000_000) / 1_000_000;
const between = (a, b) => a + (b - a) * rnd();
const pick = (arr) => arr[crypto.randomInt(0, arr.length)];

function randomColor(min, max) {
  return [between(min, max), between(min, max), between(min, max)].map(Math.round);
}

// Sample a glyph at fractional cell coordinates; the cells are 1x1 squares centred on integers.
function sampleGlyph(bits, u, v) {
  const x0 = Math.floor(u - 0.5); const y0 = Math.floor(v - 0.5);
  const fx = u - 0.5 - x0; const fy = v - 0.5 - y0;
  const at = (x, y) => (x < 0 || y < 0 || x > 4 || y > 6 ? 0 : bits[y][x]);
  const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
  const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
  return top * (1 - fy) + bottom * fy;
}

// Draws `text` (A-Z, 0-9, + - = ? and spaces) as a distorted, noisy image and returns PNG bytes.
function renderCaptcha(text, difficulty = 'medium') {
  const lvl = LEVELS[difficulty] || LEVELS.medium;
  const chars = [...String(text).toUpperCase()];
  const slots = chars.length;
  const H = 88;
  const W = Math.min(560, Math.max(230, slots * 27 + 34));
  const px = Buffer.alloc(W * H * 3);

  const base = randomColor(215, 245);
  const gx = between(-18, 18); const gy = between(-18, 18);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const shade = (x / W) * gx + (y / H) * gy + between(-6, 6);
      px[i] = Math.max(0, Math.min(255, base[0] + shade));
      px[i + 1] = Math.max(0, Math.min(255, base[1] + shade));
      px[i + 2] = Math.max(0, Math.min(255, base[2] + shade));
    }
  }
  const blend = (x, y, color, a) => {
    if (x < 0 || y < 0 || x >= W || y >= H || a <= 0) return;
    const i = (y * W + x) * 3;
    px[i] += (color[0] - px[i]) * a; px[i + 1] += (color[1] - px[i + 1]) * a; px[i + 2] += (color[2] - px[i + 2]) * a;
  };
  const noiseLine = (color, thick) => {
    const y0 = between(10, H - 10); const amp = between(4, 18); const freq = between(0.02, 0.07); const ph = between(0, 6.28);
    for (let x = 0; x < W; x++) {
      const y = y0 + Math.sin(x * freq + ph) * amp;
      for (let t = -thick; t <= thick; t++) blend(x, Math.round(y + t), color, 0.85);
    }
  };

  for (let i = 0; i < lvl.lines; i++) noiseLine(randomColor(90, 170), 1);

  const advance = (W - 24) / slots;
  const scale = Math.min(advance / 5.6, (H - 22) / 7.4);
  const wavePhase = between(0, 6.28); const waveFreq = between(0.05, 0.1);
  chars.forEach((ch, idx) => {
    const bits = BITMAPS[ch];
    if (!bits) return;
    const color = randomColor(10, 110);
    const angle = between(-lvl.rotate, lvl.rotate);
    const shear = between(-lvl.rotate, lvl.rotate) * 0.6;
    const s = scale * (1 + between(-lvl.jitter, lvl.jitter));
    const cx = 12 + advance * (idx + 0.5) + between(-2, 2);
    const cy = H / 2 + between(-5, 5);
    const cos = Math.cos(angle); const sin = Math.sin(angle);
    const reach = Math.ceil(s * 5.5);
    for (let y = Math.floor(cy - reach); y <= cy + reach; y++) {
      for (let x = Math.floor(cx - reach); x <= cx + reach; x++) {
        // Undo the wave first, then rotation and shear, to find which glyph cell lands on this pixel.
        const wx = x - Math.sin(y * waveFreq + wavePhase) * lvl.wave;
        const wy = y - Math.sin(x * waveFreq * 1.3 + wavePhase) * lvl.wave * 0.6;
        const dx = wx - cx; const dy = wy - cy;
        const rx = (cos * dx + sin * dy) / s;
        const ry = (-sin * dx + cos * dy) / s;
        const u = rx - shear * ry + 2.5;
        const v = ry + 3.5;
        const cover = sampleGlyph(bits, u, v);
        if (cover > 0.3) blend(x, y, color, Math.min(1, (cover - 0.3) / 0.35));
      }
    }
  });

  if (lvl.strike) {
    for (let i = 0; i < 2; i++) noiseLine(randomColor(20, 90), 0);
  }
  for (let i = 0; i < lvl.dots; i++) blend(crypto.randomInt(0, W), crypto.randomInt(0, H), randomColor(40, 160), between(0.5, 1));

  return encodePng(px, W, H);
}

module.exports = { renderCaptcha, BITMAPS, encodePng, pick, LEVELS };
