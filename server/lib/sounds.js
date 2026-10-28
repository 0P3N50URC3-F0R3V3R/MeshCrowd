'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const multer = require('multer');
const { db, DATA_DIR } = require('../db');

// Shared by the per-server (MANAGE_SERVER) route in servers.js and the site-admin
// (MANAGE_ANY_SERVER) route in admin.js — same upload/validate/insert/delete logic either way,
// only the permission check at the route level differs. Same "no separate moderation system"
// reasoning the user gave for custom emoji/stickers applies here too.
const SOUND_ALLOWED = new Set(['audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm']);
const SOUND_EXT = { 'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'audio/wav': '.wav', 'audio/webm': '.webm' };
const SOUND_NAME_RE = /^[a-zA-Z0-9_]{2,32}$/;

const uploadSound = multer({
  storage: multer.diskStorage({
    destination: path.join(DATA_DIR, 'sounds'),
    filename: (req, file, cb) => cb(null, `${crypto.randomBytes(10).toString('hex')}${SOUND_EXT[file.mimetype] || '.mp3'}`),
  }),
  // Real Discord caps a soundboard clip around 5 seconds; without server-side audio decoding to
  // measure duration, a byte-size cap is the practical stand-in — generous enough for a few
  // seconds of compressed audio, small enough that this can't be used to smuggle a huge file.
  limits: { fileSize: 1 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, SOUND_ALLOWED.has(file.mimetype)),
});

function createSound({ serverId, name, emoji, file, userId }) {
  if (!file) return { status: 400, error: 'audio file required' };
  if (!SOUND_NAME_RE.test(String(name || ''))) {
    fs.unlink(file.path, () => {});
    return { status: 400, error: 'name must be 2-32 chars: letters, numbers, underscore' };
  }
  const existing = db.prepare('SELECT id FROM sounds WHERE server_id = ? AND name = ? COLLATE NOCASE').get(serverId, name);
  if (existing) {
    fs.unlink(file.path, () => {});
    return { status: 409, error: 'a sound with that name already exists on this server' };
  }
  const rel = `/uploads/sounds/${file.filename}`;
  const info = db.prepare('INSERT INTO sounds (server_id, name, emoji, audio_path, created_by) VALUES (?, ?, ?, ?, ?)')
    .run(serverId, name, String(emoji || '').slice(0, 32), rel, userId || null);
  return { sound: db.prepare('SELECT * FROM sounds WHERE id = ?').get(info.lastInsertRowid) };
}

function deleteSound(serverId, soundId) {
  const sound = db.prepare('SELECT * FROM sounds WHERE id = ? AND server_id = ?').get(soundId, serverId);
  if (!sound) return null;
  db.prepare('DELETE FROM sounds WHERE id = ?').run(sound.id);
  fs.unlink(path.join(DATA_DIR, 'sounds', path.basename(sound.audio_path)), () => {});
  return sound;
}

module.exports = { uploadSound, createSound, deleteSound };
