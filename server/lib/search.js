'use strict';

const { db } = require('../db');
const { serializeMessage } = require('./messages');

// Turns free-typed user input into a safe FTS5 MATCH expression: each word becomes its own
// quoted prefix term (implicitly AND-ed together by FTS5). Quoting neutralizes FTS5's query
// syntax (AND/OR/NOT, -, ^, parentheses, etc.) so a search for e.g. "NOT deploy" or a stray
// quote can't be mistaken for a query operator or break the MATCH expression — only a doubled
// `"` (FTS5's own escape for a literal quote inside a phrase) needs handling.
function buildFtsQuery(q) {
  const terms = String(q || '').trim().split(/\s+/).filter(Boolean).slice(0, 8);
  if (!terms.length) return null;
  return terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ');
}

function likeEscape(s) {
  return String(s).replace(/[\\%_]/g, (c) => `\\${c}`);
}

// `scopeIds` is a list of channel/dm/thread ids already filtered to ones the caller may view —
// this function does no permission checking of its own.
//
// `fields` picks which of a message's own properties the query text is matched against, OR'd
// together (a message matching any checked field is included once): `text` (FTS5 content match,
// the historical default), `usernames` (author's username or display name), `attachments`
// (an attachment's file name, which also covers "by extension" since ".pdf" LIKE-matches the
// tail of "report.pdf"), `mentions` (content containing an @username ping of the typed name; a
// leading "@" in the query is ignored). `everything`, instead of matching q against anything, just returns every
// message in scopeIds - used for the separate "channel names" checkbox, whose match is against
// the channel itself rather than a message property (see servers.js's /:id/search route, which
// pre-narrows scopeIds to name-matching channels before making that call).
function searchMessages(scopeType, scopeIds, q, { limit = 25, fields = { text: true } } = {}) {
  if (scopeIds.length === 0) return [];
  const cap = Math.min(Number(limit) || 25, 50);
  const placeholders = scopeIds.map(() => '?').join(',');
  const clean = String(q || '').trim();
  const like = `%${likeEscape(clean)}%`;
  const ids = new Set();

  if (fields.everything) {
    for (const row of db.prepare(`SELECT id FROM messages WHERE scope_type = ? AND scope_id IN (${placeholders})`).all(scopeType, ...scopeIds)) {
      ids.add(row.id);
    }
  }
  if (!clean) return fields.everything ? finalize(ids, cap) : [];

  if (fields.text) {
    const match = buildFtsQuery(clean);
    if (match) {
      try {
        for (const row of db.prepare(
          `SELECT mf.rowid AS id FROM messages_fts mf
             JOIN messages m ON m.id = mf.rowid
            WHERE mf.content MATCH ? AND m.scope_type = ? AND m.scope_id IN (${placeholders})`
        ).all(match, scopeType, ...scopeIds)) ids.add(row.id);
      } catch { /* malformed FTS query (e.g. after slicing produced an unbalanced quote) - skip */ }
    }
  }
  if (fields.usernames) {
    for (const row of db.prepare(
      `SELECT m.id AS id FROM messages m JOIN users u ON u.id = m.author_id
        WHERE m.scope_type = ? AND m.scope_id IN (${placeholders})
          AND (u.username LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\')`
    ).all(scopeType, ...scopeIds, like, like)) ids.add(row.id);
  }
  if (fields.attachments) {
    for (const row of db.prepare(
      `SELECT DISTINCT m.id AS id FROM messages m JOIN attachments a ON a.message_id = m.id
        WHERE m.scope_type = ? AND m.scope_id IN (${placeholders}) AND a.file_name LIKE ? ESCAPE '\\'`
    ).all(scopeType, ...scopeIds, like)) ids.add(row.id);
  }

  if (fields.mentions) {
    const name = clean.replace(/^@/, '');
    if (name) {
      // Same token shape parseMentions() uses, so a hit is exactly a message that pinged this user.
      const re = new RegExp(`(^|[^a-zA-Z0-9_.])@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-zA-Z0-9_.])`, 'i');
      for (const row of db.prepare(
        `SELECT id, content FROM messages WHERE scope_type = ? AND scope_id IN (${placeholders}) AND content LIKE ? ESCAPE '\\'`
      ).all(scopeType, ...scopeIds, `%@${likeEscape(name)}%`)) {
        if (re.test(row.content)) ids.add(row.id);
      }
    }
  }

  return finalize(ids, cap);
}

function finalize(ids, cap) {
  if (ids.size === 0) return [];
  const idList = [...ids];
  const placeholders = idList.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM messages WHERE id IN (${placeholders}) AND is_encrypted = 0 ORDER BY id DESC LIMIT ?`).all(...idList, cap);
  return rows.map(serializeMessage);
}

// `raw` is a comma-separated list from the client's `?fields=` query param, e.g.
// "text,usernames,attachments". Defaults to text-only, matching pre-checkbox client behavior.
function parseFieldsParam(raw) {
  const set = new Set(String(raw || 'text').split(',').map((s) => s.trim()).filter(Boolean));
  return { text: set.has('text'), usernames: set.has('usernames'), attachments: set.has('attachments'), mentions: set.has('mentions'), channelNames: set.has('channelNames') };
}

module.exports = { buildFtsQuery, searchMessages, parseFieldsParam };
