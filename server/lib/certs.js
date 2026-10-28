'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const tls = require('node:tls');
const { execFileSync } = require('node:child_process');
const { DATA_DIR } = require('../db');
const logger = require('./logger');

const CERT_DIR = path.join(DATA_DIR, 'certs');
const KEY_PATH = path.join(CERT_DIR, 'key.pem');
const CERT_PATH = path.join(CERT_DIR, 'cert.pem');
// Not DATA_DIR/.. — DISMESH_DATA_DIR can point anywhere.
const APP_ROOT = path.join(__dirname, '..', '..');

// SHA-256 over the DER bytes of the leaf (first) certificate — matches
// `openssl x509 -noout -fingerprint -sha256` and what electron/main.js computes for its
// trust-on-first-use dialog. Printed on every boot so an operator can compare it out of band.
function fingerprint(pemCert) {
  return new crypto.X509Certificate(pemCert).fingerprint256;
}

function resolveConfigPath(p) {
  // Accept Windows-style ".\cert\x.crt" on every OS.
  return path.resolve(APP_ROOT, String(p).replace(/\\/g, '/'));
}

function ensureCert(publicHost, { serverCrt, serverKey } = {}) {
  if (serverCrt || serverKey) {
    if (!serverCrt || !serverKey) {
      throw new Error('[certs] both serverCrt and serverKey must be set to use a custom certificate');
    }
    const crtPath = resolveConfigPath(serverCrt);
    const keyPath = resolveConfigPath(serverKey);
    if (!fs.existsSync(crtPath)) throw new Error(`[certs] serverCrt not found: ${crtPath}`);
    if (!fs.existsSync(keyPath)) throw new Error(`[certs] serverKey not found: ${keyPath}`);
    const cert = fs.readFileSync(crtPath);
    const key = fs.readFileSync(keyPath);
    // Fail here (inside the caller's try) rather than in https.createServer, so a bad PEM,
    // weak key, or key/cert mismatch gives a clear boot error instead of an uncaught crash.
    try {
      tls.createSecureContext({ key, cert });
    } catch (err) {
      throw new Error(`[certs] invalid serverCrt/serverKey (${crtPath}, ${keyPath}): ${err.message}`);
    }
    logger.log('[certs] using custom certificate:', crtPath);
    logger.log('[certs] SHA-256 fingerprint:', fingerprint(cert));
    return { key, cert };
  }
  if (fs.existsSync(KEY_PATH) && fs.existsSync(CERT_PATH)) {
    const cert = fs.readFileSync(CERT_PATH);
    logger.log('[certs] SHA-256 fingerprint:', fingerprint(cert));
    return { key: fs.readFileSync(KEY_PATH), cert };
  }
  fs.mkdirSync(CERT_DIR, { recursive: true });
  const host = publicHost || 'localhost';
  let pems;
  try {
    // selfsigned >= 5 is async-only; boot is synchronous, so generate in a short-lived child process.
    const script = `
      const selfsigned = require('selfsigned');
      const host = process.argv[1];
      selfsigned.generate([{ name: 'commonName', value: host }], {
        keySize: 2048,
        algorithm: 'sha256',
        notAfterDate: new Date(Date.now() + 3650 * 86400000),
        extensions: [
          { name: 'basicConstraints', cA: false },
          { name: 'subjectAltName', altNames: [
            { type: 2, value: host },
            { type: 2, value: 'localhost' },
            { type: 7, ip: '127.0.0.1' },
          ] },
        ],
      }).then((p) => process.stdout.write(JSON.stringify({ private: p.private, cert: p.cert })));
    `;
    pems = JSON.parse(execFileSync(process.execPath, ['-e', script, host], { cwd: APP_ROOT, encoding: 'utf8', timeout: 60000 }));
  } catch (err) {
    logger.error('[certs] self-signed certificate generation failed:', err);
    throw err;
  }
  fs.writeFileSync(KEY_PATH, pems.private);
  fs.writeFileSync(CERT_PATH, pems.cert);
  logger.log('[certs] generated self-signed certificate for', publicHost || 'localhost');
  logger.log('[certs] SHA-256 fingerprint:', fingerprint(pems.cert));
  return { key: pems.private, cert: pems.cert };
}

module.exports = { ensureCert, fingerprint };
