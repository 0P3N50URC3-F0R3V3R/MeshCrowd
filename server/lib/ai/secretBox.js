'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DATA_DIR } = require('../../db');

const KEY_PATH = path.join(DATA_DIR, 'ai.key');
let key = null;

function loadKey() {
  if (key) return key;
  if (fs.existsSync(KEY_PATH)) {
    const loaded = Buffer.from(fs.readFileSync(KEY_PATH, 'utf8').trim(), 'hex');
    if (loaded.length !== 32) throw new Error('data/ai.key is not a 32-byte hex key');
    key = loaded;
  } else {
    key = crypto.randomBytes(32);
    fs.writeFileSync(KEY_PATH, key.toString('hex'), { mode: 0o600 });
  }
  return key;
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', loadKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}

function decrypt(blob) {
  const [version, iv, tag, enc] = String(blob).split('.');
  if (version !== 'v1' || !iv || !tag || enc === undefined) throw new Error('unsupported secret format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', loadKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(enc, 'base64')), decipher.final()]).toString('utf8');
}

function _resetKeyCache() { key = null; }

module.exports = { encrypt, decrypt, _resetKeyCache };
