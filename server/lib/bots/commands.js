'use strict';

const crypto = require('node:crypto');
const { db } = require('../../db');

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const OPTION_TYPES = ['string', 'integer', 'boolean'];
const MAX_COMMANDS = 25;
const MAX_OPTIONS = 10;
const MAX_STRING = 1000;
const INTERACTION_TTL_MS = 15 * 60 * 1000;
const MAX_RESPONSES = 5;

class CommandError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// Checks and normalizes what a bot registers. Throws CommandError with a message the bot author can act on.
function normalizeCommands(list) {
  if (!Array.isArray(list)) throw new CommandError(400, 'commands must be an array');
  if (list.length > MAX_COMMANDS) throw new CommandError(400, `at most ${MAX_COMMANDS} commands`);
  const seen = new Set();
  return list.map((c, i) => {
    const name = typeof c?.name === 'string' ? c.name.trim().toLowerCase() : '';
    if (!NAME_RE.test(name)) throw new CommandError(400, `command ${i + 1}: name must be 1-32 characters of a-z, 0-9, "_" or "-"`);
    if (seen.has(name)) throw new CommandError(400, `command "${name}" is listed twice`);
    seen.add(name);
    const rawOptions = c.options === undefined ? [] : c.options;
    if (!Array.isArray(rawOptions) || rawOptions.length > MAX_OPTIONS) throw new CommandError(400, `command "${name}": options must be an array of at most ${MAX_OPTIONS}`);
    const optNames = new Set();
    let optionalSeen = false;
    const options = rawOptions.map((o) => {
      const oname = typeof o?.name === 'string' ? o.name.trim().toLowerCase() : '';
      if (!NAME_RE.test(oname)) throw new CommandError(400, `command "${name}": option names must be 1-32 characters of a-z, 0-9, "_" or "-"`);
      if (optNames.has(oname)) throw new CommandError(400, `command "${name}": option "${oname}" is listed twice`);
      optNames.add(oname);
      const type = o.type === undefined ? 'string' : o.type;
      if (!OPTION_TYPES.includes(type)) throw new CommandError(400, `command "${name}": option type must be ${OPTION_TYPES.join(', ')}`);
      const required = o.required === true;
      if (required && optionalSeen) throw new CommandError(400, `command "${name}": required options must come first`);
      if (!required) optionalSeen = true;
      return { name: oname, description: text(o.description, 100), type, required };
    });
    return { name, description: text(c.description, 100), options };
  });
}

function setCommands(botId, list) {
  const commands = normalizeCommands(list);
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM bot_commands WHERE bot_id = ?').run(botId);
    const ins = db.prepare('INSERT INTO bot_commands (bot_id, name, description, options) VALUES (?, ?, ?, ?)');
    for (const c of commands) ins.run(botId, c.name, c.description, JSON.stringify(c.options));
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  return commands;
}

const view = (r) => ({ name: r.name, description: r.description, options: JSON.parse(r.options) });

function listBotCommands(botId) {
  return db.prepare('SELECT * FROM bot_commands WHERE bot_id = ? ORDER BY name').all(botId).map(view);
}

// Every command the members of a server can use: only bots with a working webhook can answer one.
function listServerCommands(serverId) {
  return db.prepare(`
    SELECT c.*, b.id AS bot_id, b.user_id AS bot_user_id, u.display_name AS bot_name, u.username AS bot_username
    FROM bot_commands c JOIN bots b ON b.id = c.bot_id JOIN users u ON u.id = b.user_id
    WHERE b.server_id = ? AND u.is_disabled = 0 AND b.webhook_enabled = 1 AND b.webhook_url IS NOT NULL
    ORDER BY c.name, u.display_name`).all(serverId)
    .map((r) => ({ botId: r.bot_id, botUserId: r.bot_user_id, botName: r.bot_name, botUsername: r.bot_username, ...view(r) }));
}

// Turns what a user typed into typed values, or says what is wrong with it.
function coerceOptions(definition, given) {
  const values = {};
  const input = given && typeof given === 'object' && !Array.isArray(given) ? given : {};
  for (const key of Object.keys(input)) {
    if (!definition.options.some((o) => o.name === key)) throw new CommandError(400, `unknown option "${key}"`);
  }
  for (const o of definition.options) {
    const raw = input[o.name];
    if (raw === undefined || raw === null || raw === '') {
      if (o.required) throw new CommandError(400, `option "${o.name}" is required`);
      continue;
    }
    if (o.type === 'integer') {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (!Number.isSafeInteger(n)) throw new CommandError(400, `option "${o.name}" must be a whole number`);
      values[o.name] = n;
    } else if (o.type === 'boolean') {
      const s = String(raw).trim().toLowerCase();
      if (!['true', 'false', 'yes', 'no', '1', '0'].includes(s)) throw new CommandError(400, `option "${o.name}" must be true or false`);
      values[o.name] = ['true', 'yes', '1'].includes(s);
    } else {
      const s = String(raw);
      if (s.length > MAX_STRING) throw new CommandError(400, `option "${o.name}" is too long (at most ${MAX_STRING} characters)`);
      values[o.name] = s;
    }
  }
  return values;
}

function createInteraction({ botId, userId, scopeType, scopeId, command }) {
  purgeOldInteractions();
  const id = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO bot_interactions (id, bot_id, user_id, scope_type, scope_id, command) VALUES (?, ?, ?, ?, ?, ?)').run(id, botId, userId, scopeType, scopeId, command);
  return { id, expiresAt: new Date(Date.now() + INTERACTION_TTL_MS).toISOString() };
}

// Counts one answer against an interaction the bot owns; refuses stale or used-up ones.
function claimResponse(botId, interactionId) {
  const row = db.prepare('SELECT * FROM bot_interactions WHERE id = ? AND bot_id = ?').get(String(interactionId), botId);
  if (!row) throw new CommandError(404, 'interaction not found');
  if (Date.now() - new Date(row.created_at).getTime() > INTERACTION_TTL_MS) throw new CommandError(410, 'this interaction has expired');
  const res = db.prepare('UPDATE bot_interactions SET responses = responses + 1 WHERE id = ? AND responses < ?').run(row.id, MAX_RESPONSES);
  if (!res.changes) throw new CommandError(429, `an interaction takes at most ${MAX_RESPONSES} responses`);
  return row;
}

function purgeOldInteractions() {
  db.prepare("DELETE FROM bot_interactions WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')").run();
}

module.exports = {
  CommandError, normalizeCommands, setCommands, listBotCommands, listServerCommands,
  coerceOptions, createInteraction, claimResponse, purgeOldInteractions, INTERACTION_TTL_MS,
};
