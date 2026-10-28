'use strict';

const crypto = require('node:crypto');
const { db } = require('../db');

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
}

function getMeta(key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setMeta(key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

function getOrCreateKeypair() {
  let privateKeyPem = getMeta('federation_privkey_pem');
  let publicKeyPem = getMeta('federation_pubkey_pem');
  if (!privateKeyPem || !publicKeyPem) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
    setMeta('federation_privkey_pem', privateKeyPem);
    setMeta('federation_pubkey_pem', publicKeyPem);
  }
  return { privateKeyPem, publicKeyPem };
}

function signPayload(payload) {
  const { privateKeyPem } = getOrCreateKeypair();
  const key = crypto.createPrivateKey(privateKeyPem);
  const signature = crypto.sign(null, Buffer.from(canonicalize(payload)), key);
  return signature.toString('base64');
}

function verifyPayload(payload, signatureBase64, publicKeyPem) {
  try {
    const key = crypto.createPublicKey(publicKeyPem);
    const signature = Buffer.from(signatureBase64, 'base64');
    return crypto.verify(null, Buffer.from(canonicalize(payload)), key, signature);
  } catch {
    return false;
  }
}

module.exports = { canonicalize, getOrCreateKeypair, signPayload, verifyPayload };
