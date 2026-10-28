'use strict';

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { db } = require('../db');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h, deliberately shorter than a normal user session

function getMeta(key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}
function setMeta(key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

function isFederationAdminConfigured() {
  return !!getMeta('federation_admin_password_hash');
}

function setFederationAdminPassword(password) {
  setMeta('federation_admin_password_hash', bcrypt.hashSync(password, 12));
}

function verifyFederationAdminPassword(password) {
  const hash = getMeta('federation_admin_password_hash');
  if (!hash) return false;
  return bcrypt.compareSync(password, hash);
}

function createFederationAdminSession() {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare('INSERT INTO federation_admin_sessions (token, expires_at) VALUES (?, ?)').run(token, expiresAt);
  return { token, expiresAt };
}

function getFederationAdminSession(token) {
  if (!token) return null;
  const row = db.prepare('SELECT * FROM federation_admin_sessions WHERE token = ?').get(token);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM federation_admin_sessions WHERE token = ?').run(token);
    return null;
  }
  return row;
}

function destroyFederationAdminSession(token) {
  db.prepare('DELETE FROM federation_admin_sessions WHERE token = ?').run(token);
}

module.exports = {
  isFederationAdminConfigured, setFederationAdminPassword, verifyFederationAdminPassword,
  createFederationAdminSession, getFederationAdminSession, destroyFederationAdminSession,
};
