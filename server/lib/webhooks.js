'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const multer = require('multer');
const { db, DATA_DIR } = require('../db');

const NAME_RE = /^.{1,80}$/; // freeform display name (like a bot/integration name), just length-capped
const ICON_ALLOWED = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const uploadWebhookIcon = multer({
  storage: multer.diskStorage({
    destination: path.join(DATA_DIR, 'webhookicons'),
    filename: (req, file, cb) => cb(null, `${crypto.randomBytes(10).toString('hex')}.png`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ICON_ALLOWED.has(file.mimetype)),
});

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function createWebhook({ channelId, serverId, name, userId }) {
  const cleanName = String(name || '').trim().slice(0, 80);
  if (!NAME_RE.test(cleanName)) return { status: 400, error: 'name is required' };
  const info = db.prepare('INSERT INTO webhooks (channel_id, server_id, name, token, created_by) VALUES (?, ?, ?, ?, ?)')
    .run(channelId, serverId, cleanName, generateToken(), userId || null);
  return { webhook: db.prepare('SELECT * FROM webhooks WHERE id = ?').get(info.lastInsertRowid) };
}

function deleteWebhook(channelId, webhookId) {
  const webhook = db.prepare('SELECT * FROM webhooks WHERE id = ? AND channel_id = ?').get(webhookId, channelId);
  if (!webhook) return null;
  db.prepare('DELETE FROM webhooks WHERE id = ?').run(webhook.id);
  if (webhook.avatar_path) fs.unlink(path.join(DATA_DIR, 'webhookicons', path.basename(webhook.avatar_path)), () => {});
  return webhook;
}

function regenerateToken(channelId, webhookId) {
  const webhook = db.prepare('SELECT * FROM webhooks WHERE id = ? AND channel_id = ?').get(webhookId, channelId);
  if (!webhook) return null;
  const token = generateToken();
  db.prepare('UPDATE webhooks SET token = ? WHERE id = ?').run(token, webhook.id);
  return db.prepare('SELECT * FROM webhooks WHERE id = ?').get(webhook.id);
}

module.exports = { uploadWebhookIcon, createWebhook, deleteWebhook, regenerateToken };
