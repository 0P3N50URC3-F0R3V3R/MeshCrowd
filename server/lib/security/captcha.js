'use strict';

const crypto = require('node:crypto');
const settings = require('./settings');
const { renderCaptcha } = require('./captchaImage');
const { EN, HU } = require('./wordlists');
const { foldWord } = settings;

const MAX_OUTSTANDING = 5000;
const challenges = new Map(); // id -> { answer, expires }
const stats = { issued: 0, solved: 0, failed: 0 };

const AMBIGUOUS = new Set(['0', 'O', '1', 'I']);
const CHARSETS = {
  digits: '0123456789',
  letters: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  alphanumeric: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
};

const rint = (n) => crypto.randomInt(0, n);

function randomChars(cfg) {
  const pool = [...CHARSETS[cfg.charset]].filter((c) => !(cfg.excludeAmbiguous && AMBIGUOUS.has(c)));
  let out = '';
  for (let i = 0; i < cfg.length; i++) out += pool[rint(pool.length)];
  return { text: out, answer: out };
}

function wordPool(cfg) {
  const w = cfg.words;
  const pool = [];
  if (w.source !== 'custom') for (const l of w.lists) pool.push(...(l === 'hu' ? HU : EN));
  if (w.source !== 'builtin') pool.push(...w.custom);
  return pool.length ? pool : EN;
}

function randomWords(cfg) {
  const pool = wordPool(cfg);
  const picked = [];
  for (let i = 0; i < cfg.words.count; i++) {
    let w;
    let guard = 0;
    do { w = pool[rint(pool.length)]; guard += 1; } while (picked.includes(w) && guard < 20);
    picked.push(w);
  }
  return { text: picked.join(' ').toUpperCase(), answer: picked.join(' ') };
}

function randomMath(cfg) {
  const hard = cfg.difficulty === 'hard';
  const op = ['+', '-', 'x'][rint(hard ? 3 : 2)];
  let a; let b; let r;
  if (op === 'x') { a = 2 + rint(8); b = 2 + rint(8); r = a * b; }
  else if (op === '+') { a = 1 + rint(hard ? 60 : 20); b = 1 + rint(hard ? 60 : 20); r = a + b; }
  else { a = 5 + rint(hard ? 60 : 20); b = 1 + rint(a - 1); r = a - b; }
  return { text: `${a}${op === 'x' ? 'X' : op}${b}=?`, answer: String(r) };
}

function normalizeAnswer(raw) {
  return foldWord(String(raw == null ? '' : raw).slice(0, 80));
}

function sweep(now) {
  for (const [id, c] of challenges) if (c.expires <= now) challenges.delete(id);
  while (challenges.size > MAX_OUTSTANDING) challenges.delete(challenges.keys().next().value);
}

// cfg defaults to the saved settings; the admin preview passes unsaved ones.
function generate(cfg = settings.load().captcha) {
  const made = cfg.type === 'math' ? randomMath(cfg) : cfg.type === 'words' ? randomWords(cfg) : randomChars(cfg);
  const png = renderCaptcha(made.text, cfg.difficulty);
  const id = crypto.randomBytes(18).toString('base64url');
  const now = Date.now();
  sweep(now);
  challenges.set(id, { answer: normalizeAnswer(made.answer), expires: now + cfg.ttlSeconds * 1000 });
  stats.issued += 1;
  return { id, image: `data:image/png;base64,${png.toString('base64')}`, expiresInSeconds: cfg.ttlSeconds, answer: made.answer };
}

// One try per challenge: a wrong guess burns it, so the answer cannot be brute-forced against one picture.
function verify(id, answer) {
  const c = typeof id === 'string' ? challenges.get(id) : null;
  if (!c) { stats.failed += 1; return 'invalid'; }
  challenges.delete(id);
  if (c.expires <= Date.now()) { stats.failed += 1; return 'expired'; }
  const given = normalizeAnswer(answer);
  const ok = given.length === c.answer.length
    && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(c.answer));
  if (!ok) { stats.failed += 1; return 'wrong'; }
  stats.solved += 1;
  return 'ok';
}

module.exports = { generate, verify, stats, _challenges: challenges };
