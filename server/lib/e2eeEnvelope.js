'use strict';

const MAX_ENVELOPE_CHARS = 32768;
const MAX_CHAIN_INDEX = 2 ** 31 - 1;
const NONCE_RE = /^[A-Za-z0-9+/]{32}$/; // 24 raw bytes, unpadded base64
const CIPHERTEXT_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MIN_CIPHERTEXT_B64 = 24; // 16-byte Poly1305 tag

// Syntactic check only: the server cannot (and must not be able to) open the envelope.
function isValidEnvelope(content) {
  if (typeof content !== 'string' || content.length > MAX_ENVELOPE_CHARS) return false;
  let env;
  try { env = JSON.parse(content); } catch { return false; }
  if (!env || typeof env !== 'object' || Array.isArray(env)) return false;
  const keys = Object.keys(env).sort().join(',');
  if (keys !== 'chainIndex,ciphertext,nonce,v') return false;
  if (env.v !== 1) return false;
  if (!Number.isInteger(env.chainIndex) || env.chainIndex < 0 || env.chainIndex > MAX_CHAIN_INDEX) return false;
  if (typeof env.nonce !== 'string' || !NONCE_RE.test(env.nonce)) return false;
  return typeof env.ciphertext === 'string' && env.ciphertext.length >= MIN_CIPHERTEXT_B64 && CIPHERTEXT_RE.test(env.ciphertext);
}

module.exports = { isValidEnvelope, MAX_ENVELOPE_CHARS };
