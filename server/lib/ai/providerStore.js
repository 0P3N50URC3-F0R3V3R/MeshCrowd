'use strict';

const { db } = require('../../db');
const { singleLine } = require('../textSanitize');
const logger = require('../logger');
const secretBox = require('./secretBox');
const { validateBaseUrl } = require('./http');
const { AiError } = require('./errors');

const KINDS = new Set(['ollama', 'openai']);

function parseModels(row) {
  try {
    const list = JSON.parse(row.models);
    return Array.isArray(list) ? list.filter((m) => typeof m === 'string') : [];
  } catch { return []; }
}

const adminShape = (row) => ({
  id: row.id,
  name: row.name,
  kind: row.kind,
  baseUrl: row.base_url,
  hasKey: !!row.api_key_enc,
  models: parseModels(row),
  timeoutS: row.timeout_s,
  concurrency: row.concurrency,
  serverAdminUsable: !!row.server_admin_usable,
  enabled: !!row.enabled,
  scope: row.scope,
  createdAt: row.created_at,
});

const serverShape = (row) => ({ id: row.id, name: row.name, kind: row.kind, models: parseModels(row) });

const getRow = (id) => db.prepare('SELECT * FROM ai_providers WHERE id = ?').get(id);
const listRows = () => db.prepare('SELECT * FROM ai_providers ORDER BY name COLLATE NOCASE ASC').all();

function intIn(value, min, max, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new AiError(400, `${label} must be a whole number from ${min} to ${max}`);
  return n;
}

function parseInput(body, { partial }) {
  const b = body || {};
  const out = {};
  if (!partial || b.name !== undefined) {
    const name = singleLine(b.name, 64);
    if (!name) throw new AiError(400, 'name required');
    out.name = name;
  }
  if (!partial || b.kind !== undefined) {
    if (!KINDS.has(b.kind)) throw new AiError(400, 'kind must be ollama or openai');
    out.kind = b.kind;
  }
  if (!partial || b.baseUrl !== undefined) {
    try { out.base_url = validateBaseUrl(b.baseUrl); } catch (err) { throw new AiError(400, err.message); }
  }
  if (b.apiKey !== undefined) {
    if (typeof b.apiKey !== 'string' || b.apiKey.length > 512) throw new AiError(400, 'invalid api key');
    out.api_key_enc = b.apiKey ? secretBox.encrypt(b.apiKey) : null;
  }
  if (b.models !== undefined) {
    if (!Array.isArray(b.models) || b.models.length > 200) throw new AiError(400, 'models must be a list of at most 200 names');
    const list = [...new Set(b.models.map((m) => (typeof m === 'string' ? m.trim() : '')).filter(Boolean))];
    if (list.some((m) => m.length > 200)) throw new AiError(400, 'model names must be at most 200 characters');
    out.models = JSON.stringify(list);
  }
  if (b.timeoutS !== undefined) out.timeout_s = intIn(b.timeoutS, 5, 600, 'timeoutS');
  if (b.concurrency !== undefined) out.concurrency = intIn(b.concurrency, 1, 4, 'concurrency');
  if (b.serverAdminUsable !== undefined) out.server_admin_usable = b.serverAdminUsable ? 1 : 0;
  if (b.enabled !== undefined) out.enabled = b.enabled ? 1 : 0;
  return out;
}

const isUniqueError = (err) => /UNIQUE/i.test(String(err && err.message));

function createProvider(body) {
  const v = parseInput(body, { partial: false });
  try {
    const info = db.prepare(
      `INSERT INTO ai_providers (name, kind, base_url, api_key_enc, models, timeout_s, concurrency, server_admin_usable, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(v.name, v.kind, v.base_url, v.api_key_enc ?? null, v.models ?? '[]', v.timeout_s ?? 120, v.concurrency ?? 1, v.server_admin_usable ?? 0, v.enabled ?? 1);
    logger.log(`[ai] provider created: ${v.name} (${v.kind})`);
    return getRow(Number(info.lastInsertRowid));
  } catch (err) {
    if (isUniqueError(err)) throw new AiError(409, 'a provider with this name already exists');
    throw err;
  }
}

function updateProvider(id, body) {
  const row = getRow(id);
  if (!row) throw new AiError(404, 'provider not found');
  const v = parseInput(body, { partial: true });
  const cols = Object.keys(v);
  if (cols.length) {
    try {
      db.prepare(`UPDATE ai_providers SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => v[c]), id);
    } catch (err) {
      if (isUniqueError(err)) throw new AiError(409, 'a provider with this name already exists');
      throw err;
    }
    logger.log(`[ai] provider updated: ${row.name}`);
  }
  return getRow(id);
}

function deleteProvider(id) {
  const row = getRow(id);
  if (!row) throw new AiError(404, 'provider not found');
  const users = db.prepare(
    'SELECT u.username FROM bots b JOIN users u ON u.id = b.user_id WHERE b.provider_id = ? ORDER BY u.username LIMIT 10'
  ).all(id);
  if (users.length) throw new AiError(409, `provider is used by bots: ${users.map((u) => u.username).join(', ')}`);
  db.prepare('DELETE FROM ai_providers WHERE id = ?').run(id);
  logger.log(`[ai] provider deleted: ${row.name}`);
}

module.exports = { adminShape, serverShape, getRow, listRows, parseModels, createProvider, updateProvider, deleteProvider };
