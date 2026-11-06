'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// DM message text (and its link-preview embed) is stored sealed with AES-256-GCM under a server key.
// This protects the database file, its backups and its WAL; the running server can still read DMs
// (search, bots, moderation reports) because it holds the key. The key is DISMESH_DM_KEY (base64,
// 32 bytes) or, when unset, a random one generated next to the database. Losing it makes sealed
// DMs unreadable, so back it up together with the database.
const PREFIX = 'enc1:';
const AAD = Buffer.from('dismesh-dm');

let key = null;

function loadKey() {
  if (key) return key;
  const fromEnv = process.env.DISMESH_DM_KEY;
  if (fromEnv) {
    const buf = Buffer.from(fromEnv, 'base64');
    if (buf.length !== 32) throw new Error('DISMESH_DM_KEY must be 32 bytes, base64 encoded');
    key = buf;
    return key;
  }
  const dataDir = process.env.DISMESH_DATA_DIR || path.join(__dirname, '..', '..', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'dm-at-rest.key');
  if (fs.existsSync(file)) {
    key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
    if (key.length !== 32) throw new Error(`${file} is not a valid 32 byte key`);
    return key;
  }
  key = crypto.randomBytes(32);
  fs.writeFileSync(file, key.toString('base64'), { mode: 0o600 });
  console.log(`[db] created DM at-rest encryption key ${file} - back it up with the database`);
  return key;
}

function seal(text) {
  if (text === null || text === undefined) return text;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', loadKey(), iv);
  cipher.setAAD(AAD);
  const ct = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

function isSealed(text) {
  return typeof text === 'string' && text.startsWith(PREFIX);
}

// Anything that is not a valid sealed value (plain text, including a user typing "enc1:") comes back unchanged.
function open(text) {
  if (!isSealed(text)) return text;
  try {
    const raw = Buffer.from(text.slice(PREFIX.length), 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', loadKey(), raw.subarray(0, 12));
    decipher.setAAD(AAD);
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return text;
  }
}

const sealFor = (scopeType, text) => (scopeType === 'dm' ? seal(text) : text);

// Separate keys for separate uses (DM files), all derived from the one server key.
function deriveKey(label) {
  return Buffer.from(crypto.hkdfSync('sha256', loadKey(), Buffer.alloc(0), label, 32));
}

module.exports = { seal, open, isSealed, sealFor, deriveKey };
