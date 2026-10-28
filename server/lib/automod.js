'use strict';

const crypto = require('node:crypto');
const { db } = require('../db');
const { PERMISSIONS, has } = require('./permissions');
const { getChannelPermissionBits } = require('./channelAccess');
const { parseMentions } = require('./notifications');
const { singleLine } = require('./textSanitize');

const KINDS = ['keywords', 'links', 'mentions', 'spam', 'caps'];
const MAX_RULES = 25;
const MAX_WORDS = 200;
const MAX_WORD_LENGTH = 64;
const MAX_DOMAINS = 100;
const MAX_TIMEOUT_MINUTES = 40320;
const LOG_KEEP = 500;

class AutomodError extends Error {
  constructor(status, message) { super(message); this.name = 'AutomodError'; this.status = status; }
}

const clampInt = (v, min, max, label) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new AutomodError(400, `${label} must be a whole number from ${min} to ${max}`);
  return n;
};

function cleanList(raw, { max, maxLength, label, lower = true }) {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/\r?\n/);
  const out = [];
  for (const item of list) {
    const s = singleLine(String(item ?? ''), maxLength).trim();
    if (!s) continue;
    const v = lower ? s.toLowerCase() : s;
    if (!out.includes(v)) out.push(v);
  }
  if (out.length > max) throw new AutomodError(400, `${label} can have at most ${max} entries`);
  return out;
}

// Validates and normalizes a rule's config for its kind (the stored shape is always the normalized one).
function parseConfig(kind, raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  switch (kind) {
    case 'keywords': {
      const words = cleanList(c.words, { max: MAX_WORDS, maxLength: MAX_WORD_LENGTH, label: 'the word list' });
      if (!words.length) throw new AutomodError(400, 'add at least one word or phrase');
      return { words, wholeWord: c.wholeWord === undefined ? true : !!c.wholeWord };
    }
    case 'links': {
      const mode = ['block_all', 'allowlist', 'blocklist'].includes(c.mode) ? c.mode : 'block_all';
      const domains = cleanList(c.domains, { max: MAX_DOMAINS, maxLength: 100, label: 'the domain list' }).map((d) => d.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, ''));
      if (mode !== 'block_all' && !domains.length) throw new AutomodError(400, 'add at least one domain');
      return { mode, domains };
    }
    case 'mentions':
      return { max: clampInt(c.max ?? 5, 1, 50, 'the mention limit') };
    case 'spam':
      return {
        maxMessages: clampInt(c.maxMessages ?? 6, 2, 50, 'the message limit'),
        windowSeconds: clampInt(c.windowSeconds ?? 8, 2, 120, 'the time window'),
        duplicates: clampInt(c.duplicates ?? 3, 2, 20, 'the duplicate limit'),
      };
    case 'caps':
      return { minLetters: clampInt(c.minLetters ?? 12, 5, 200, 'the minimum length'), maxPercent: clampInt(c.maxPercent ?? 70, 30, 100, 'the capital-letter percentage') };
    default:
      throw new AutomodError(400, 'unknown rule kind');
  }
}

const idList = (raw, label) => {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length > 200) throw new AutomodError(400, `${label} must be a list`);
  return [...new Set(raw.map(Number))].filter((n) => Number.isInteger(n) && n > 0);
};

function shape(row) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    enabled: !!row.enabled,
    config: JSON.parse(row.config),
    action: row.action,
    timeoutMinutes: row.timeout_minutes,
    exemptRoles: JSON.parse(row.exempt_roles),
    exemptChannels: JSON.parse(row.exempt_channels),
    createdAt: row.created_at,
  };
}

function listRules(serverId) {
  return db.prepare('SELECT * FROM automod_rules WHERE server_id = ? ORDER BY id ASC').all(serverId).map(shape);
}

function fieldsFrom(body, current) {
  const b = body || {};
  const out = {};
  if (b.name !== undefined || !current) {
    const name = singleLine(String(b.name ?? ''), 60).trim();
    if (!name) throw new AutomodError(400, 'the rule needs a name');
    out.name = name;
  }
  const kind = current ? current.kind : b.kind;
  if (!KINDS.includes(kind)) throw new AutomodError(400, 'unknown rule kind');
  if (!current) out.kind = kind;
  if (b.config !== undefined || !current) out.config = JSON.stringify(parseConfig(kind, b.config !== undefined ? b.config : {}));
  if (b.enabled !== undefined) out.enabled = b.enabled ? 1 : 0;
  if (b.action !== undefined) {
    if (b.action !== 'block' && b.action !== 'timeout') throw new AutomodError(400, 'action must be block or timeout');
    out.action = b.action;
  }
  if (b.timeoutMinutes !== undefined) out.timeout_minutes = clampInt(b.timeoutMinutes, 1, MAX_TIMEOUT_MINUTES, 'the timeout');
  const roles = idList(b.exemptRoles, 'exemptRoles');
  if (roles !== undefined) out.exempt_roles = JSON.stringify(roles);
  const channels = idList(b.exemptChannels, 'exemptChannels');
  if (channels !== undefined) out.exempt_channels = JSON.stringify(channels);
  return out;
}

function createRule(serverId, body) {
  if (db.prepare('SELECT COUNT(*) AS n FROM automod_rules WHERE server_id = ?').get(serverId).n >= MAX_RULES) throw new AutomodError(409, `a server can have at most ${MAX_RULES} rules`);
  const f = fieldsFrom(body, null);
  const cols = ['server_id', ...Object.keys(f)];
  const info = db.prepare(`INSERT INTO automod_rules (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(serverId, ...Object.values(f));
  return shape(db.prepare('SELECT * FROM automod_rules WHERE id = ?').get(Number(info.lastInsertRowid)));
}

function updateRule(serverId, ruleId, body) {
  const current = db.prepare('SELECT * FROM automod_rules WHERE id = ? AND server_id = ?').get(ruleId, serverId);
  if (!current) throw new AutomodError(404, 'rule not found');
  const f = fieldsFrom(body, current);
  const keys = Object.keys(f);
  if (keys.length) db.prepare(`UPDATE automod_rules SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => f[k]), ruleId);
  return shape(db.prepare('SELECT * FROM automod_rules WHERE id = ?').get(ruleId));
}

function deleteRule(serverId, ruleId) {
  const info = db.prepare('DELETE FROM automod_rules WHERE id = ? AND server_id = ?').run(ruleId, serverId);
  if (Number(info.changes) !== 1) throw new AutomodError(404, 'rule not found');
}

function listLog(serverId, { before, limit = 50 } = {}) {
  const lim = Math.min(200, Math.max(1, Number(limit) || 50));
  const rows = before
    ? db.prepare('SELECT * FROM automod_log WHERE server_id = ? AND id < ? ORDER BY id DESC LIMIT ?').all(serverId, Number(before), lim)
    : db.prepare('SELECT * FROM automod_log WHERE server_id = ? ORDER BY id DESC LIMIT ?').all(serverId, lim);
  return rows.map((r) => {
    const u = r.user_id ? db.prepare('SELECT id, username, display_name FROM users WHERE id = ?').get(r.user_id) : null;
    const ch = r.channel_id ? db.prepare('SELECT name FROM channels WHERE id = ?').get(r.channel_id) : null;
    return {
      id: r.id, ruleId: r.rule_id, ruleName: r.rule_name, action: r.action, excerpt: r.excerpt, createdAt: r.created_at,
      user: u ? { id: u.id, username: u.username, displayName: u.display_name } : null,
      channelName: ch ? ch.name : null,
    };
  });
}

// ---------------------------------------------------------------- matching

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordCache = new Map();
function wordRegex(word, wholeWord) {
  const key = `${wholeWord ? 'w' : 's'}:${word}`;
  let re = wordCache.get(key);
  if (!re) {
    const body = word.split('*').map(escapeRe).join('[\\p{L}\\p{N}_]*');
    re = wholeWord ? new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, 'iu') : new RegExp(body, 'iu');
    if (wordCache.size > 5000) wordCache.clear();
    wordCache.set(key, re);
  }
  return re;
}

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
function hostsIn(content) {
  const hosts = [];
  for (const m of content.matchAll(URL_RE)) {
    try {
      const u = new URL(m[0].startsWith('www.') ? `http://${m[0]}` : m[0]);
      hosts.push(u.hostname.toLowerCase().replace(/^www\./, ''));
    } catch { /* not a parseable link */ }
  }
  return hosts;
}
const hostMatches = (host, domain) => host === domain || host.endsWith(`.${domain}`);

const recent = new Map(); // `${serverId}:${userId}` -> [{ t, h }]
const normalizeForDup = (s) => crypto.createHash('sha1').update(s.toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex');

function matchesRule(rule, ctx) {
  const c = JSON.parse(rule.config);
  const { content } = ctx;
  switch (rule.kind) {
    case 'keywords': {
      const hit = c.words.find((w) => wordRegex(w, c.wholeWord).test(content));
      return hit ? `blocked word` : null;
    }
    case 'links': {
      const hosts = hostsIn(content);
      if (!hosts.length) return null;
      if (c.mode === 'block_all') return 'links are not allowed here';
      if (c.mode === 'allowlist') return hosts.some((h) => !c.domains.some((d) => hostMatches(h, d))) ? 'link to a site that is not allowed' : null;
      return hosts.some((h) => c.domains.some((d) => hostMatches(h, d))) ? 'link to a blocked site' : null;
    }
    case 'mentions': {
      const candidateUsers = db.prepare('SELECT u.id, u.username FROM server_members sm JOIN users u ON u.id = sm.user_id WHERE sm.server_id = ?').all(ctx.serverId);
      const roles = db.prepare('SELECT id, name FROM roles WHERE server_id = ?').all(ctx.serverId);
      const m = parseMentions(content, { candidateUsers, roles });
      const total = m.userIds.length + m.roleIds.length + (m.everyone || m.here ? c.max + 1 : 0);
      return total > c.max ? 'too many mentions' : null;
    }
    case 'spam': {
      if (!ctx.track) return null;
      const now = Date.now();
      const key = `${ctx.serverId}:${ctx.userId}`;
      const list = (recent.get(key) || []).filter((e) => now - e.t < 120_000);
      const h = normalizeForDup(content);
      const inWindow = list.filter((e) => now - e.t < c.windowSeconds * 1000).length + 1;
      const dups = list.filter((e) => e.h === h && now - e.t < 60_000).length + 1;
      if (inWindow >= c.maxMessages) return 'sending messages too fast';
      if (dups >= c.duplicates) return 'repeating the same message';
      return null;
    }
    case 'caps': {
      const letters = [...content].filter((ch) => /\p{L}/u.test(ch));
      if (letters.length < c.minLetters) return null;
      const upper = letters.filter((ch) => ch !== ch.toLowerCase()).length;
      return (upper * 100) / letters.length >= c.maxPercent ? 'too many capital letters' : null;
    }
    default:
      return null;
  }
}

function remember(serverId, userId, content) {
  const key = `${serverId}:${userId}`;
  const now = Date.now();
  const list = (recent.get(key) || []).filter((e) => now - e.t < 120_000);
  list.push({ t: now, h: normalizeForDup(content) });
  recent.set(key, list.slice(-60));
  if (recent.size > 20000) recent.clear();
}

function isExempt(rule, ctx) {
  const channels = JSON.parse(rule.exempt_channels);
  if (channels.includes(ctx.channel.id)) return true;
  const roles = JSON.parse(rule.exempt_roles);
  if (!roles.length) return false;
  const mine = db.prepare('SELECT role_id FROM member_roles WHERE server_id = ? AND user_id = ?').all(ctx.serverId, ctx.userId).map((r) => r.role_id);
  return roles.some((r) => mine.includes(r));
}

function logHit(rule, ctx, action) {
  db.prepare('INSERT INTO automod_log (server_id, rule_id, rule_name, user_id, channel_id, action, excerpt) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(ctx.serverId, rule.id, rule.name, ctx.userId, ctx.channel.id, action, ctx.content.slice(0, 200));
  db.prepare('DELETE FROM automod_log WHERE server_id = ? AND id NOT IN (SELECT id FROM automod_log WHERE server_id = ? ORDER BY id DESC LIMIT ?)').run(ctx.serverId, ctx.serverId, LOG_KEEP);
}

// Checks a message a member is about to send (or edit into) in a server channel or thread. Returns null
// when it may go ahead, or { rule, reason, message } when it must be refused. `track` is true for new
// messages only, so an edit never counts toward the flood and duplicate limits.
function evaluate({ channel, user, content, track = true }) {
  if (!channel || !user || typeof content !== 'string' || !content.trim()) return null;
  const serverId = channel.server_id;
  const rules = db.prepare('SELECT * FROM automod_rules WHERE server_id = ? AND enabled = 1 ORDER BY id ASC').all(serverId);
  if (!rules.length) { if (track) remember(serverId, user.id, content); return null; }
  const server = db.prepare('SELECT owner_id FROM servers WHERE id = ?').get(serverId);
  // Whoever moderates messages is never filtered: owner, administrators and message managers.
  if (server && (server.owner_id === user.id || has(getChannelPermissionBits(channel, user.id), PERMISSIONS.MANAGE_MESSAGES))) {
    if (track) remember(serverId, user.id, content);
    return null;
  }
  const ctx = { serverId, userId: user.id, channel, content, track };
  for (const rule of rules) {
    if (isExempt(rule, ctx)) continue;
    const reason = matchesRule(rule, ctx);
    if (!reason) continue;
    let action = 'block';
    if (rule.action === 'timeout') {
      const until = new Date(Date.now() + rule.timeout_minutes * 60_000).toISOString();
      db.prepare('UPDATE server_members SET timeout_until = ? WHERE server_id = ? AND user_id = ?').run(until, serverId, user.id);
      action = `timeout ${rule.timeout_minutes} min`;
    }
    logHit(rule, ctx, action);
    if (track) remember(serverId, user.id, content);
    return { rule: { id: rule.id, name: rule.name }, reason, action, message: `Your message was blocked by AutoMod (${rule.name}).` };
  }
  if (track) remember(serverId, user.id, content);
  return null;
}

function _reset() { recent.clear(); wordCache.clear(); }

module.exports = {
  AutomodError, KINDS, MAX_RULES, parseConfig, listRules, createRule, updateRule, deleteRule, listLog, evaluate, shape, _reset,
};
