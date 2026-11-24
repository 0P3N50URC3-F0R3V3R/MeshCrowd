'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');

const KEY_FILE = path.join(path.dirname(config.CONFIG_PATH), 'instance-key.json');
const MAX_ADVERT = 32768;
const MAX_ICON_URI = 24000;
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const REGISTRATION = ['open', 'invite', 'closed'];
const BAD_TEXT = /[\p{Cc}‪-‮⁦-⁩‎‏]/u;

let cached = null;

function loadOrCreateKey() {
  if (cached) return cached;
  let stored = null;
  try { stored = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8')); } catch { /* first start or unreadable: make a new key */ }
  if (!stored || typeof stored.privateKey !== 'string' || typeof stored.publicKey !== 'string') {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    stored = {
      privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
      publicKey: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'),
    };
    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
    fs.writeFileSync(KEY_FILE, JSON.stringify(stored), { mode: 0o600 });
  }
  const priv = crypto.createPrivateKey({ key: Buffer.from(stored.privateKey, 'base64'), format: 'der', type: 'pkcs8' });
  cached = { publicKey: stored.publicKey, sign: (bytes) => crypto.sign(null, bytes, priv) };
  return cached;
}

function build({ url, name, description, icon, registration, updated }) {
  const key = loadOrCreateKey();
  const payload = Buffer.from(JSON.stringify({ v: 1, url, name, description, icon: icon || null, registration, updated, pub: key.publicKey }));
  return `${payload.toString('base64url')}.${key.sign(payload).toString('base64url')}`;
}

const fail = (error) => ({ ok: false, error });

function verify(str) {
  if (typeof str !== 'string' || str.length > MAX_ADVERT) return fail('bad advert size');
  const parts = str.split('.');
  if (parts.length !== 2) return fail('bad advert format');
  let payload; let a;
  try {
    payload = Buffer.from(parts[0], 'base64url');
    a = JSON.parse(payload.toString('utf8'));
  } catch { return fail('bad advert payload'); }
  if (!a || typeof a !== 'object' || a.v !== 1) return fail('unsupported advert');
  if (typeof a.name !== 'string' || a.name.length > 60 || typeof a.description !== 'string' || a.description.length > 300) return fail('bad advert text');
  if (BAD_TEXT.test(a.name) || BAD_TEXT.test(a.description)) return fail('bad advert text');
  if (a.icon !== null && (typeof a.icon !== 'string' || a.icon.length > MAX_ICON_URI || !a.icon.startsWith('data:image/png;base64,'))) return fail('bad advert icon');
  if (!REGISTRATION.includes(a.registration) || !Number.isFinite(a.updated) || typeof a.pub !== 'string') return fail('bad advert fields');
  if (typeof a.url !== 'string') return fail('bad advert url');
  let u;
  try { u = new URL(a.url); } catch { return fail('bad advert url'); }
  if (u.protocol !== 'https:' || u.username || u.password || a.url.length > 200) return fail('bad advert url');
  try {
    const pub = crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(a.pub, 'base64url')]), format: 'der', type: 'spki' });
    if (!crypto.verify(null, payload, pub, Buffer.from(parts[1], 'base64url'))) return fail('bad signature');
  } catch { return fail('bad signature'); }
  const { url, name, description, icon, registration, updated, pub } = a;
  return { ok: true, advert: { url, name, description, icon, registration, updated, pub } };
}

module.exports = { loadOrCreateKey, build, verify, MAX_ADVERT };
