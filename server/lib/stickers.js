'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const multer = require('multer');
const { db, DATA_DIR } = require('../db');

// Shared by the per-server (MANAGE_SERVER) route in servers.js and the site-admin
// (MANAGE_ANY_SERVER) route in admin.js — same upload/validate/insert/delete logic either way,
// only the permission check at the route level differs. Real extension kept (like custom_emoji),
// so an animated GIF/WebP/APNG sticker still animates once served.
const STICKER_ALLOWED = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const STICKER_EXT = { 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/jpeg': '.jpg' };
const STICKER_NAME_RE = /^[a-zA-Z0-9_]{2,32}$/;

const uploadSticker = multer({
  storage: multer.diskStorage({
    destination: path.join(DATA_DIR, 'stickers'),
    filename: (req, file, cb) => cb(null, `${crypto.randomBytes(10).toString('hex')}${STICKER_EXT[file.mimetype] || '.png'}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, STICKER_ALLOWED.has(file.mimetype)),
});

function createSticker({ serverId, name, description, file, userId }) {
  if (!file) return { status: 400, error: 'image file required' };
  if (!STICKER_NAME_RE.test(String(name || ''))) {
    fs.unlink(file.path, () => {});
    return { status: 400, error: 'name must be 2-32 chars: letters, numbers, underscore' };
  }
  const existing = db.prepare('SELECT id FROM stickers WHERE server_id = ? AND name = ? COLLATE NOCASE').get(serverId, name);
  if (existing) {
    fs.unlink(file.path, () => {});
    return { status: 409, error: 'a sticker with that name already exists on this server' };
  }
  const rel = `/uploads/stickers/${file.filename}`;
  const info = db.prepare('INSERT INTO stickers (server_id, name, description, image_path, created_by) VALUES (?, ?, ?, ?, ?)')
    .run(serverId, name, String(description || '').slice(0, 150), rel, userId || null);
  return { sticker: db.prepare('SELECT * FROM stickers WHERE id = ?').get(info.lastInsertRowid) };
}

function deleteSticker(serverId, stickerId) {
  const sticker = db.prepare('SELECT * FROM stickers WHERE id = ? AND server_id = ?').get(stickerId, serverId);
  if (!sticker) return null;
  db.prepare('DELETE FROM stickers WHERE id = ?').run(sticker.id);
  fs.unlink(path.join(DATA_DIR, 'stickers', path.basename(sticker.image_path)), () => {});
  return sticker;
}

module.exports = { uploadSticker, createSticker, deleteSticker };
