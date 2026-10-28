'use strict';

const crypto = require('node:crypto');
const { db } = require('../db');
const { toPublicUser } = require('./publicUser');

const MAX_ACTIVE_PER_SERVER = 100;
const MAX_ACTIVE_PER_USER = 25;
const MAX_LIFETIME_SECONDS = 90 * 24 * 3600;
const MIN_LIFETIME_SECONDS = 60;
const MAX_USES_CAP = 1000;

const VANITY_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
// Names that already mean something in a URL or a command on this app.
const RESERVED_VANITY = new Set(['api', 'join', 'discover', 'admin', 'invite', 'invites', 'm', 'lang', 'uploads', 'vendor', 'federation', 'login', 'register', 'settings', 'www', 'me', 'dm', 'channels', 'i']);

class InviteError extends Error {
  constructor(status, message) { super(message); this.name = 'InviteError'; this.status = status; }
}

const newCode = () => crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, 'x').slice(0, 8);
const isExpired = (invite) => !!invite.expires_at && new Date(invite.expires_at) <= new Date();
const isExhausted = (invite) => invite.max_uses !== null && invite.uses >= invite.max_uses;

function parseLimits({ maxUses, expiresInSeconds }) {
  let uses = null;
  if (maxUses !== undefined && maxUses !== null && maxUses !== '') {
    uses = Number(maxUses);
    if (!Number.isInteger(uses) || uses < 1 || uses > MAX_USES_CAP) throw new InviteError(400, `maxUses must be a whole number from 1 to ${MAX_USES_CAP}`);
  }
  let expiresAt = null;
  if (expiresInSeconds !== undefined && expiresInSeconds !== null && expiresInSeconds !== '') {
    const s = Number(expiresInSeconds);
    if (!Number.isInteger(s) || s < MIN_LIFETIME_SECONDS || s > MAX_LIFETIME_SECONDS) throw new InviteError(400, 'expiresInSeconds must be between 1 minute and 90 days');
    expiresAt = new Date(Date.now() + s * 1000).toISOString();
  }
  return { uses, expiresAt };
}

function createInvite({ serverId, userId, maxUses, expiresInSeconds }) {
  const { uses, expiresAt } = parseLimits({ maxUses, expiresInSeconds });
  sweepExpired();
  if (db.prepare('SELECT COUNT(*) AS n FROM server_invites WHERE server_id = ?').get(serverId).n >= MAX_ACTIVE_PER_SERVER) throw new InviteError(409, 'this server has too many active invites; revoke some first');
  if (db.prepare('SELECT COUNT(*) AS n FROM server_invites WHERE server_id = ? AND created_by = ?').get(serverId, userId).n >= MAX_ACTIVE_PER_USER) throw new InviteError(409, 'you have too many active invites; revoke some first');
  for (let i = 0; i < 5; i++) {
    const code = newCode();
    if (db.prepare('SELECT 1 FROM servers WHERE invite_code = ? OR vanity_code = ?').get(code, code.toLowerCase())) continue;
    try {
      const info = db.prepare('INSERT INTO server_invites (server_id, code, created_by, max_uses, expires_at) VALUES (?, ?, ?, ?, ?)').run(serverId, code, userId, uses, expiresAt);
      return getInvite(Number(info.lastInsertRowid));
    } catch (err) {
      if (!/UNIQUE/.test(String(err.message))) throw err;
    }
  }
  throw new InviteError(500, 'could not generate an invite code');
}

const getInvite = (id) => db.prepare('SELECT * FROM server_invites WHERE id = ?').get(id);

function shape(row) {
  const creator = row.created_by ? db.prepare('SELECT * FROM users WHERE id = ?').get(row.created_by) : null;
  return {
    id: row.id,
    code: row.code,
    uses: row.uses,
    maxUses: row.max_uses,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    createdBy: creator ? toPublicUser(creator, {}) : null,
  };
}

function listInvites(serverId, { userId, all }) {
  sweepExpired();
  const rows = all
    ? db.prepare('SELECT * FROM server_invites WHERE server_id = ? ORDER BY id DESC').all(serverId)
    : db.prepare('SELECT * FROM server_invites WHERE server_id = ? AND created_by = ? ORDER BY id DESC').all(serverId, userId);
  return rows.map(shape);
}

function revokeInvite(serverId, inviteId, { userId, canManage }) {
  const row = db.prepare('SELECT * FROM server_invites WHERE id = ? AND server_id = ?').get(inviteId, serverId);
  if (!row) throw new InviteError(404, 'invite not found');
  if (!canManage && row.created_by !== userId) throw new InviteError(403, 'you can only revoke your own invites');
  db.prepare('DELETE FROM server_invites WHERE id = ?').run(row.id);
  return row;
}

// What a join code points at: the server's permanent code, its vanity name, or one of the extra
// invites. An invite that is expired or used up is reported rather than silently ignored.
function resolveJoinCode(code) {
  const raw = String(code || '').trim();
  if (!raw) return null;
  let server = db.prepare('SELECT * FROM servers WHERE invite_code = ?').get(raw);
  if (server) return { server };
  server = db.prepare('SELECT * FROM servers WHERE vanity_code = ?').get(raw.toLowerCase());
  if (server) return { server };
  const invite = db.prepare('SELECT * FROM server_invites WHERE code = ?').get(raw);
  if (!invite) return null;
  if (isExpired(invite)) return { error: { status: 410, message: 'this invite has expired' } };
  if (isExhausted(invite)) return { error: { status: 410, message: 'this invite has reached its use limit' } };
  server = db.prepare('SELECT * FROM servers WHERE id = ?').get(invite.server_id);
  return server ? { server, invite } : null;
}

// Read-only lookup for the public invite page: same code kinds as a join (server code, vanity, extra
// invite, channel invite) but nothing is consumed and nobody is joined.
function peekCode(code) {
  const raw = String(code || '').trim();
  if (!raw || raw.length > 128) return null;
  const resolved = resolveJoinCode(raw);
  if (resolved) return resolved.error ? { dead: resolved.error } : { kind: 'server', server: resolved.server };
  const ci = db.prepare('SELECT * FROM channel_invites WHERE code = ?').get(raw);
  if (!ci) return null;
  if (isExpired(ci)) return { dead: { status: 410, message: 'this invite has expired' } };
  if (isExhausted(ci)) return { dead: { status: 410, message: 'this invite has reached its use limit' } };
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(ci.channel_id);
  const server = channel && db.prepare('SELECT * FROM servers WHERE id = ?').get(channel.server_id);
  return server ? { kind: 'channel', server, channel } : null;
}

// What the public page may say about an invite. Member count only for public servers.
function publicInfo(peek) {
  const { server, channel } = peek;
  return {
    kind: peek.kind,
    name: server.name,
    description: String(server.description || '').slice(0, 200),
    iconPath: server.icon_path || null,
    memberCount: server.visibility === 'public' ? db.prepare('SELECT COUNT(*) AS c FROM server_members WHERE server_id = ?').get(server.id).c : null,
    channelName: channel ? channel.name : null,
  };
}

// Counted only when somebody actually joins. The guard in the WHERE makes it safe under races.
function consumeInvite(inviteId) {
  const info = db.prepare('UPDATE server_invites SET uses = uses + 1 WHERE id = ? AND (max_uses IS NULL OR uses < max_uses) AND (expires_at IS NULL OR expires_at > ?)')
    .run(inviteId, new Date().toISOString());
  return Number(info.changes) === 1;
}

function normalizeVanity(raw) {
  const code = String(raw ?? '').trim().toLowerCase();
  if (!VANITY_RE.test(code)) throw new InviteError(400, 'a vanity link is 3 to 32 characters: letters, digits and hyphens, not starting or ending with a hyphen');
  if (RESERVED_VANITY.has(code)) throw new InviteError(400, 'that name is reserved');
  return code;
}

function setVanity(serverId, raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    db.prepare('UPDATE servers SET vanity_code = NULL WHERE id = ?').run(serverId);
    return null;
  }
  const code = normalizeVanity(raw);
  const clash = db.prepare('SELECT id FROM servers WHERE (vanity_code = ? OR invite_code = ?) AND id != ?').get(code, code, serverId)
    || db.prepare('SELECT 1 FROM server_invites WHERE lower(code) = ?').get(code);
  if (clash) throw new InviteError(409, 'that vanity link is already taken');
  db.prepare('UPDATE servers SET vanity_code = ? WHERE id = ?').run(code, serverId);
  return code;
}

function sweepExpired() {
  db.prepare('DELETE FROM server_invites WHERE expires_at IS NOT NULL AND expires_at <= ?').run(new Date().toISOString());
}

setInterval(() => { try { sweepExpired(); } catch { /* db closed during shutdown */ } }, 3600_000).unref();

module.exports = {
  InviteError, createInvite, listInvites, revokeInvite, resolveJoinCode, peekCode, publicInfo, consumeInvite, setVanity, normalizeVanity, sweepExpired, shape,
  MAX_ACTIVE_PER_SERVER, MAX_ACTIVE_PER_USER,
};
