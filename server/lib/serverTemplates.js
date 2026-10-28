'use strict';

const crypto = require('node:crypto');
const { db } = require('../db');
const { OWNER_PERMISSIONS } = require('./permissions');
const { singleLine } = require('./textSanitize');
const { VOICE_QUALITIES, DEFAULT_VOICE_QUALITY } = require('./voiceQuality');

const MAX_ROLES = 50;
const MAX_CATEGORIES = 25;
const MAX_CHANNELS = 100;
const MAX_TEMPLATES_PER_SERVER = 5;
const MAX_SNAPSHOT_BYTES = 200 * 1024;
// Channel types a template may carry. Notes channels are personal, so they are never copied.
const CHANNEL_TYPES = new Set(['public', 'private', 'announcement', 'readonly', 'voice', 'forum', 'stage']);

class TemplateError extends Error {
  constructor(status, message) { super(message); this.name = 'TemplateError'; this.status = status; }
}

const newCode = () => crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, 'x').slice(0, 8);

function buildSnapshot(serverId) {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
  const everyone = db.prepare('SELECT * FROM roles WHERE server_id = ? AND is_default = 1').get(serverId);
  const roles = db.prepare('SELECT * FROM roles WHERE server_id = ? AND is_default = 0 ORDER BY position ASC, id ASC').all(serverId);
  const roleIndex = new Map(roles.map((r, i) => [r.id, i]));
  const categories = db.prepare('SELECT * FROM channel_categories WHERE server_id = ? ORDER BY position ASC, id ASC').all(serverId);
  const catIndex = new Map(categories.map((c, i) => [c.id, i]));
  const channels = db.prepare("SELECT * FROM channels WHERE server_id = ? AND type != 'notes' ORDER BY position ASC, id ASC").all(serverId);
  return {
    v: 1,
    rulesText: server.rules_text || '',
    everyonePermissions: everyone ? everyone.permissions : 0,
    roles: roles.map((r) => ({ name: r.name, color: r.color, permissions: r.permissions, position: r.position })),
    categories: categories.map((c) => ({ name: c.name, position: c.position })),
    channels: channels.map((c) => ({
      name: c.name,
      type: c.type,
      topic: c.topic || '',
      position: c.position,
      category: c.category_id !== null && catIndex.has(c.category_id) ? catIndex.get(c.category_id) : null,
      slowmodeSeconds: c.slowmode_seconds || 0,
      voiceQuality: c.voice_quality || DEFAULT_VOICE_QUALITY,
      overrides: db.prepare('SELECT * FROM channel_role_overrides WHERE channel_id = ?').all(c.id)
        .map((o) => ({ role: o.role_id === everyone?.id ? 'everyone' : (roleIndex.has(o.role_id) ? roleIndex.get(o.role_id) : null), allow: o.allow, deny: o.deny }))
        .filter((o) => o.role !== null),
    })),
  };
}

// A template is data from another server, so nothing in it is trusted: every field is rebuilt here.
function validateSnapshot(raw) {
  const damaged = () => new TemplateError(400, 'this template is damaged');
  if (!raw || typeof raw !== 'object' || raw.v !== 1) throw damaged();
  const perms = (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 0) throw damaged(); return n & OWNER_PERMISSIONS; };
  const list = (v, max) => { if (!Array.isArray(v) || v.length > max) throw damaged(); return v; };
  const roles = list(raw.roles, MAX_ROLES).map((r) => {
    const name = singleLine(String(r?.name ?? ''), 100).trim();
    if (!name || name === '@everyone') throw damaged();
    return { name, color: /^#[0-9a-fA-F]{6}$/.test(r.color) ? r.color : '#99aab5', permissions: perms(r.permissions), position: Math.max(0, Math.min(1000, Number(r.position) || 0)) };
  });
  const categories = list(raw.categories, MAX_CATEGORIES).map((c) => {
    const name = singleLine(String(c?.name ?? ''), 50).trim();
    if (!name) throw damaged();
    return { name, position: Math.max(0, Math.min(1000, Number(c.position) || 0)) };
  });
  const channels = list(raw.channels, MAX_CHANNELS).map((c) => {
    const name = singleLine(String(c?.name ?? ''), 80).trim();
    if (!name || !CHANNEL_TYPES.has(c.type)) throw damaged();
    const category = c.category === null || c.category === undefined ? null : Number(c.category);
    if (category !== null && !(Number.isInteger(category) && category >= 0 && category < categories.length)) throw damaged();
    const overrides = (Array.isArray(c.overrides) ? c.overrides : []).slice(0, MAX_ROLES + 1).map((o) => {
      const role = o.role === 'everyone' ? 'everyone' : Number(o.role);
      if (role !== 'everyone' && !(Number.isInteger(role) && role >= 0 && role < roles.length)) throw damaged();
      return { role, allow: perms(o.allow), deny: perms(o.deny) };
    });
    return {
      name, type: c.type, topic: singleLine(String(c.topic ?? ''), 200), position: Math.max(0, Math.min(10000, Number(c.position) || 0)), category,
      slowmodeSeconds: Math.max(0, Math.min(21600, Math.trunc(Number(c.slowmodeSeconds) || 0))),
      voiceQuality: VOICE_QUALITIES.has(c.voiceQuality) ? c.voiceQuality : DEFAULT_VOICE_QUALITY,
      overrides,
    };
  });
  return { v: 1, rulesText: String(raw.rulesText ?? '').slice(0, 4000), everyonePermissions: perms(raw.everyonePermissions), roles, categories, channels };
}

const summaryOf = (s) => ({ roles: s.roles.length, categories: s.categories.length, channels: s.channels.map((c) => ({ name: c.name, type: c.type })) });

function shape(row, { includeCode = true } = {}) {
  const snap = validateSnapshot(JSON.parse(row.snapshot));
  return { id: row.id, code: includeCode ? row.code : undefined, name: row.name, description: row.description, uses: row.uses, createdAt: row.created_at, updatedAt: row.updated_at, summary: summaryOf(snap) };
}

function listTemplates(serverId) {
  return db.prepare('SELECT * FROM server_templates WHERE source_server_id = ? ORDER BY id ASC').all(serverId).map((r) => shape(r));
}

function cleanText(name, description) {
  const n = singleLine(String(name ?? ''), 100).trim();
  if (!n) throw new TemplateError(400, 'the template needs a name');
  return { name: n, description: String(description ?? '').slice(0, 500) };
}

function createTemplate({ serverId, userId, name, description }) {
  const { name: n, description: d } = cleanText(name, description);
  if (db.prepare('SELECT COUNT(*) AS c FROM server_templates WHERE source_server_id = ?').get(serverId).c >= MAX_TEMPLATES_PER_SERVER) throw new TemplateError(409, `a server can have at most ${MAX_TEMPLATES_PER_SERVER} templates`);
  const snapshot = JSON.stringify(validateSnapshot(buildSnapshot(serverId)));
  if (snapshot.length > MAX_SNAPSHOT_BYTES) throw new TemplateError(413, 'the server is too large to turn into a template');
  for (let i = 0; i < 5; i++) {
    try {
      const info = db.prepare('INSERT INTO server_templates (code, source_server_id, created_by, name, description, snapshot) VALUES (?, ?, ?, ?, ?, ?)').run(newCode(), serverId, userId, n, d, snapshot);
      return shape(db.prepare('SELECT * FROM server_templates WHERE id = ?').get(Number(info.lastInsertRowid)));
    } catch (err) { if (!/UNIQUE/.test(String(err.message))) throw err; }
  }
  throw new TemplateError(500, 'could not generate a template code');
}

function syncTemplate(serverId, id) {
  const row = db.prepare('SELECT * FROM server_templates WHERE id = ? AND source_server_id = ?').get(id, serverId);
  if (!row) throw new TemplateError(404, 'template not found');
  const snapshot = JSON.stringify(validateSnapshot(buildSnapshot(serverId)));
  if (snapshot.length > MAX_SNAPSHOT_BYTES) throw new TemplateError(413, 'the server is too large to turn into a template');
  db.prepare("UPDATE server_templates SET snapshot = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(snapshot, id);
  return shape(db.prepare('SELECT * FROM server_templates WHERE id = ?').get(id));
}

function deleteTemplate(serverId, id) {
  if (Number(db.prepare('DELETE FROM server_templates WHERE id = ? AND source_server_id = ?').run(id, serverId).changes) !== 1) throw new TemplateError(404, 'template not found');
}

const byCode = (code) => db.prepare('SELECT * FROM server_templates WHERE code = ?').get(String(code || '').trim());

function previewTemplate(code) {
  const row = byCode(code);
  if (!row) throw new TemplateError(404, 'template not found');
  return shape(row, { includeCode: false });
}

// Starts a new server owned by `user` from the template. Nothing is copied but structure: no members,
// messages, emoji, bots or invites.
function instantiate(user, code, { name, description, visibility = 'private' } = {}) {
  const row = byCode(code);
  if (!row) throw new TemplateError(404, 'template not found');
  const snap = validateSnapshot(JSON.parse(row.snapshot));
  const serverName = singleLine(String(name ?? row.name), 100).trim();
  if (!serverName) throw new TemplateError(400, 'server name required');

  db.exec('BEGIN');
  try {
    const serverId = Number(db.prepare('INSERT INTO servers (name, description, owner_id, invite_code, visibility, auto_join, rules_text) VALUES (?, ?, ?, ?, ?, 0, ?)')
      .run(serverName, String(description ?? '').slice(0, 500), user.id, crypto.randomBytes(6).toString('hex'), visibility, snap.rulesText).lastInsertRowid);
    db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(serverId, user.id);
    const everyoneId = Number(db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 0, 1)').run(serverId, '@everyone', snap.everyonePermissions).lastInsertRowid);
    const roleIds = snap.roles.map((r) => Number(db.prepare('INSERT INTO roles (server_id, name, color, permissions, position, is_default) VALUES (?, ?, ?, ?, ?, 0)').run(serverId, r.name, r.color, r.permissions, r.position).lastInsertRowid));
    const catIds = snap.categories.map((c) => Number(db.prepare('INSERT INTO channel_categories (server_id, name, position) VALUES (?, ?, ?)').run(serverId, c.name, c.position).lastInsertRowid));
    if (!snap.channels.length) db.prepare('INSERT INTO channels (server_id, name, type, position) VALUES (?, ?, ?, 0)').run(serverId, 'general', 'public');
    for (const c of snap.channels) {
      const channelId = Number(db.prepare('INSERT INTO channels (server_id, name, type, topic, position, category_id, slowmode_seconds, voice_quality) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(serverId, c.name, c.type, c.topic, c.position, c.category === null ? null : catIds[c.category], c.slowmodeSeconds, c.voiceQuality).lastInsertRowid);
      for (const o of c.overrides) {
        db.prepare('INSERT OR REPLACE INTO channel_role_overrides (channel_id, role_id, allow, deny) VALUES (?, ?, ?, ?)').run(channelId, o.role === 'everyone' ? everyoneId : roleIds[o.role], o.allow, o.deny);
      }
    }
    db.prepare('UPDATE server_templates SET uses = uses + 1 WHERE id = ?').run(row.id);
    db.exec('COMMIT');
    return db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = {
  TemplateError, buildSnapshot, validateSnapshot, listTemplates, createTemplate, syncTemplate, deleteTemplate, previewTemplate, instantiate,
  MAX_TEMPLATES_PER_SERVER,
};
