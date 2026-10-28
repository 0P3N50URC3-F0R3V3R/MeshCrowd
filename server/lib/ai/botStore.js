'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { db, DATA_DIR } = require('../../db');
const { singleLine } = require('../textSanitize');
const { logAudit } = require('../auditLog');
const { toPublicUser } = require('../publicUser');
const { removeMember } = require('../channelAccess');
const { postServerEvent } = require('../systemMessages');
const hub = require('../../socket/hub');
const { AiError } = require('./errors');
const providerStore = require('./providerStore');
const secretBox = require('./secretBox');
const tokens = require('../bots/tokens');
const { validateWebhookUrl, WebhookUrlError } = require('../bots/webhooks');

const AVATAR_TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };

const uploadBotAvatar = multer({
  storage: multer.diskStorage({
    destination: path.join(DATA_DIR, 'avatars'),
    filename: (req, file, cb) => cb(null, `bot-${crypto.randomBytes(8).toString('hex')}${AVATAR_TYPES[file.mimetype] || ''}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, !!AVATAR_TYPES[file.mimetype]),
});

const BOT_SELECT = `SELECT b.*, u.username, u.display_name AS bot_name, u.is_disabled AS user_disabled, p.name AS provider_name, s.name AS server_name
  FROM bots b JOIN users u ON u.id = b.user_id LEFT JOIN ai_providers p ON p.id = b.provider_id JOIN servers s ON s.id = b.server_id`;

const getBotRow = (id) => db.prepare(`${BOT_SELECT} WHERE b.id = ?`).get(id);

function publicBot(row) {
  const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  return {
    id: row.id,
    serverId: row.server_id,
    serverName: row.server_name,
    userId: row.user_id,
    user: toPublicUser(userRow, {}),
    hasAi: row.provider_id != null,
    providerId: row.provider_id,
    providerName: row.provider_name || null,
    model: row.model,
    persona: row.persona,
    mentionEnabled: !!row.mention_enabled,
    dmEnabled: !!row.dm_enabled,
    contextMessages: row.context_messages,
    createdBy: row.created_by,
    createdAt: row.created_at,
    api: { hasToken: !!row.api_token_hash, tokenPrefix: row.api_token_prefix || null, tokenCreatedAt: row.api_token_at || null },
    webhook: {
      enabled: !!row.webhook_enabled,
      url: row.webhook_url || '',
      scope: row.webhook_scope,
      hasSecret: !!row.webhook_secret_enc,
      allowPrivate: !!row.webhook_allow_private,
      lastStatus: row.webhook_last_status || null,
      lastAt: row.webhook_last_at || null,
    },
  };
}

function listBots(serverId) {
  const rows = serverId
    ? db.prepare(`${BOT_SELECT} WHERE b.server_id = ? ORDER BY b.id ASC`).all(serverId)
    : db.prepare(`${BOT_SELECT} ORDER BY b.id ASC`).all();
  return rows.map(publicBot);
}

function usernameFor(displayName) {
  const slug = displayName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 20) || 'ai';
  const base = `${slug}_bot`;
  let name = base;
  while (db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(name)) {
    name = `${base}_${crypto.randomBytes(2).toString('hex')}`;
  }
  return name;
}

function intIn(value, min, max, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new AiError(400, `${label} must be a whole number from ${min} to ${max}`);
  return n;
}

function resolveProvider(providerId, siteAuthority) {
  const provider = providerStore.getRow(Number(providerId));
  if (!provider || !provider.enabled) throw new AiError(400, 'provider not found or disabled');
  if (!siteAuthority && !provider.server_admin_usable) throw new AiError(403, 'this provider is not available to server admins');
  return provider;
}

function checkModel(provider, model) {
  if (typeof model !== 'string' || !model.trim() || model.length > 200) throw new AiError(400, 'model required');
  const allowed = providerStore.parseModels(provider);
  if (allowed.length && !allowed.includes(model)) throw new AiError(400, 'model is not in the provider\'s model list');
  return model.trim();
}

function parseFields(body, { current, siteAuthority }) {
  const b = body || {};
  const out = {};
  if (b.displayName !== undefined || !current) {
    const name = singleLine(b.displayName, 32);
    if (name.length < 2) throw new AiError(400, 'bot name must be 2 to 32 characters');
    out.displayName = name;
  }
  // A bot without an AI provider is an API/webhook-only bot.
  const rawProvider = b.providerId !== undefined ? b.providerId : current?.provider_id;
  if (rawProvider === null || rawProvider === '' || rawProvider === undefined) {
    if (b.providerId !== undefined || !current) { out.provider_id = null; out.model = null; }
  } else {
    const provider = resolveProvider(Number(rawProvider), siteAuthority);
    if (b.providerId !== undefined || b.model !== undefined || !current) {
      out.model = checkModel(provider, b.model !== undefined ? b.model : current?.model);
      out.provider_id = provider.id;
    }
  }
  if (b.webhookUrl !== undefined) {
    if (b.webhookUrl === null || b.webhookUrl === '') {
      out.webhook_url = null; out.webhook_enabled = 0; out.webhook_allow_private = 0;
    } else {
      try { out.webhook_url = validateWebhookUrl(b.webhookUrl); } catch (err) {
        if (err instanceof WebhookUrlError) throw new AiError(400, err.message);
        throw err;
      }
      // A private address (a LAN n8n, localhost) is only for webhooks a site admin set up; re-saving the
      // same URL (a server admin editing another field) keeps what the site admin granted.
      if (siteAuthority) out.webhook_allow_private = 1;
      else if (out.webhook_url !== current?.webhook_url) out.webhook_allow_private = 0;
    }
  }
  if (b.webhookScope !== undefined) {
    if (b.webhookScope !== 'mention' && b.webhookScope !== 'all') throw new AiError(400, 'webhookScope must be mention or all');
    out.webhook_scope = b.webhookScope;
  }
  if (b.webhookEnabled !== undefined && out.webhook_enabled === undefined) out.webhook_enabled = b.webhookEnabled ? 1 : 0;
  if (out.webhook_enabled === 1) {
    const url = out.webhook_url !== undefined ? out.webhook_url : current?.webhook_url;
    if (!url) throw new AiError(400, 'set a webhook URL first');
    if (!current?.webhook_secret_enc) throw new AiError(400, 'generate a signing secret first');
  }
  if (b.persona !== undefined) {
    if (typeof b.persona !== 'string' || b.persona.length > 4000) throw new AiError(400, 'persona must be at most 4000 characters');
    out.persona = b.persona.trim();
  }
  if (b.mentionEnabled !== undefined) out.mention_enabled = b.mentionEnabled ? 1 : 0;
  if (b.dmEnabled !== undefined) out.dm_enabled = b.dmEnabled ? 1 : 0;
  if (b.contextMessages !== undefined) out.context_messages = intIn(b.contextMessages, 1, 30, 'contextMessages');
  return out;
}

function createBot({ serverId, actorId, body, siteAuthority }) {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
  if (!server) throw new AiError(404, 'server not found');
  if (server.kind !== 'chat') throw new AiError(400, 'bots are not available on sites');
  const f = parseFields(body, { current: null, siteAuthority });

  const created = (() => {
    db.exec('BEGIN');
    try {
      const username = usernameFor(f.displayName);
      const userInfo = db.prepare(
        'INSERT INTO users (username, email, password_hash, display_name, discoverable, is_bot) VALUES (?, ?, ?, ?, 0, 1)'
      ).run(username, `bot-${crypto.randomBytes(6).toString('hex')}@local.invalid`, bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10), f.displayName);
      const userId = Number(userInfo.lastInsertRowid);
      const botInfo = db.prepare(
        `INSERT INTO bots (user_id, server_id, provider_id, model, persona, mention_enabled, dm_enabled, context_messages, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(userId, serverId, f.provider_id ?? null, f.model ?? null, f.persona ?? '', f.mention_enabled ?? 1, f.dm_enabled ?? 0, f.context_messages ?? 12, actorId);
      db.prepare('INSERT INTO server_members (server_id, user_id, screened_at) VALUES (?, ?, ?)').run(serverId, userId, new Date().toISOString());
      db.exec('COMMIT');
      return { userId, botId: Number(botInfo.lastInsertRowid) };
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
      throw err;
    }
  })();

  logAudit(serverId, actorId, 'bot_create', 'bot', created.botId, { name: f.displayName, model: f.model });
  const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(created.userId);
  hub.broadcastToServer(serverId, { type: 'member_join', serverId, user: toPublicUser(userRow, {}) });
  postServerEvent(serverId, 'member_join', created.userId);
  return publicBot(getBotRow(created.botId));
}

function updateBot(botId, { actorId, body, siteAuthority }) {
  const row = getBotRow(botId);
  if (!row) throw new AiError(404, 'bot not found');
  const f = parseFields(body, { current: row, siteAuthority });
  const { displayName, ...cols } = f;
  const keys = Object.keys(cols);
  if (keys.length) db.prepare(`UPDATE bots SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => cols[k]), botId);
  if (displayName !== undefined) db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(displayName, row.user_id);
  logAudit(row.server_id, actorId, 'bot_update', 'bot', botId, { fields: [...keys, ...(displayName !== undefined ? ['displayName'] : [])] });
  return publicBot(getBotRow(botId));
}

function deleteBot(botId, actorId) {
  const row = getBotRow(botId);
  if (!row) throw new AiError(404, 'bot not found');
  db.prepare('DELETE FROM bots WHERE id = ?').run(botId);
  db.prepare('DELETE FROM member_roles WHERE server_id = ? AND user_id = ?').run(row.server_id, row.user_id);
  removeMember(row.server_id, row.user_id);
  logAudit(row.server_id, actorId, 'bot_delete', 'bot', botId, { name: row.bot_name });
  hub.broadcastToServer(row.server_id, { type: 'member_leave', userId: row.user_id, serverId: row.server_id });
}

function setBotAvatar(botRow, file) {
  const rel = `/uploads/avatars/${file.filename}`;
  const old = db.prepare('SELECT avatar_path FROM users WHERE id = ?').get(botRow.user_id).avatar_path;
  db.prepare('UPDATE users SET avatar_path = ? WHERE id = ?').run(rel, botRow.user_id);
  if (old && path.basename(old).startsWith('bot-')) {
    try { fs.unlinkSync(path.join(DATA_DIR, 'avatars', path.basename(old))); } catch { /* already gone */ }
  }
  return publicBot(getBotRow(botRow.id));
}

function requireBot(botId) {
  const row = getBotRow(botId);
  if (!row) throw new AiError(404, 'bot not found');
  return row;
}

// The token is shown once, right here; only its hash is kept.
function issueApiToken(botId, actorId) {
  const row = requireBot(botId);
  const t = tokens.generateToken();
  db.prepare('UPDATE bots SET api_token_hash = ?, api_token_prefix = ?, api_token_at = ? WHERE id = ?').run(t.hash, t.prefix, new Date().toISOString(), botId);
  logAudit(row.server_id, actorId, 'bot_token_issue', 'bot', botId, {});
  return { token: t.token, bot: publicBot(getBotRow(botId)) };
}

function revokeApiToken(botId, actorId) {
  const row = requireBot(botId);
  db.prepare('UPDATE bots SET api_token_hash = NULL, api_token_prefix = NULL, api_token_at = NULL WHERE id = ?').run(botId);
  logAudit(row.server_id, actorId, 'bot_token_revoke', 'bot', botId, {});
  return publicBot(getBotRow(botId));
}

// The signing secret is kept (encrypted) because every delivery has to be signed with it.
function rotateWebhookSecret(botId, actorId) {
  const row = requireBot(botId);
  const secret = tokens.generateWebhookSecret();
  db.prepare('UPDATE bots SET webhook_secret_enc = ? WHERE id = ?').run(secretBox.encrypt(secret), botId);
  logAudit(row.server_id, actorId, 'bot_webhook_secret_rotate', 'bot', botId, {});
  return { secret, bot: publicBot(getBotRow(botId)) };
}

function findBotByToken(token) {
  if (!token) return null;
  return db.prepare(`${BOT_SELECT} WHERE b.api_token_hash = ? AND u.is_disabled = 0`).get(tokens.hashToken(token)) || null;
}

module.exports = {
  uploadBotAvatar, getBotRow, publicBot, listBots, createBot, updateBot, deleteBot, setBotAvatar,
  issueApiToken, revokeApiToken, rotateWebhookSecret, findBotByToken,
};
