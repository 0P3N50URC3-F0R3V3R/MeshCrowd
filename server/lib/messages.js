'use strict';

const { db } = require('../db');
const { toPublicUser } = require('./publicUser');

// Reactions are returned as raw {emoji, userIds} aggregates rather than a per-viewer "did I
// react" flag — a single serialized message is broadcast to every viewer over WS, so "did I
// react" can only be computed client-side against each viewer's own user id.
function getReactions(messageId) {
  const rows = db.prepare('SELECT emoji, user_id FROM message_reactions WHERE message_id = ? ORDER BY created_at ASC').all(messageId);
  const byEmoji = new Map();
  for (const r of rows) {
    if (!byEmoji.has(r.emoji)) byEmoji.set(r.emoji, []);
    byEmoji.get(r.emoji).push(r.user_id);
  }
  return [...byEmoji.entries()].map(([emoji, userIds]) => ({ emoji, userIds }));
}

// A lightweight snapshot, not a live reference — if the original is later edited the quoted
// preview here still shows its content as of *this* call, not as of when the reply was sent
// (unlike Discord, which freezes the preview at reply time — a straight FK lookup is simpler and
// deemed close enough for this app). If the original was deleted, reply_to_message_id has
// already gone to NULL via its own ON DELETE SET NULL, so this returns null and the reply
// relationship just disappears — no "original message was deleted" placeholder to show.
function getReplyTo(replyToId) {
  if (!replyToId) return null;
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(replyToId);
  if (!row) return null;
  const author = db.prepare('SELECT * FROM users WHERE id = ?').get(row.author_id);
  return { id: row.id, author: toPublicUser(author, {}), content: row.content, isEncrypted: !!row.is_encrypted };
}

// Raw per-option voter id aggregates, same "let the client compute did-I-vote" pattern as
// getReactions — a single serialized message is broadcast to every viewer over WS.
function getPoll(messageId) {
  const poll = db.prepare('SELECT * FROM polls WHERE message_id = ?').get(messageId);
  if (!poll) return null;
  const options = db.prepare('SELECT * FROM poll_options WHERE poll_id = ? ORDER BY position ASC, id ASC').all(poll.id);
  const votes = db.prepare('SELECT option_id, user_id FROM poll_votes WHERE poll_id = ?').all(poll.id);
  const votersByOption = new Map();
  for (const v of votes) {
    if (!votersByOption.has(v.option_id)) votersByOption.set(v.option_id, []);
    votersByOption.get(v.option_id).push(v.user_id);
  }
  return {
    id: poll.id,
    multiSelect: !!poll.multi_select,
    options: options.map((o) => ({ id: o.id, label: o.label, voterIds: votersByOption.get(o.id) || [] })),
    totalVoters: new Set(votes.map((v) => v.user_id)).size,
  };
}

// A read-only snapshot of the original, same "frozen at call time, not at forward time"
// tradeoff getReplyTo already makes — the original can still be edited/deleted independently.
function getForwardedFrom(id) {
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  if (!row) return null;
  const author = db.prepare('SELECT * FROM users WHERE id = ?').get(row.author_id);
  const attachments = db.prepare('SELECT * FROM attachments WHERE message_id = ?').all(row.id).map((a) => ({
    id: a.id, url: a.file_path, fileName: a.file_name, mimeType: a.mime_type, sizeBytes: a.size_bytes,
  }));
  return { id: row.id, author: toPublicUser(author, {}), content: row.content, createdAt: row.created_at, attachments };
}

// A webhook-posted message's author_id always points at the reserved system user (see
// db/index.js WEBHOOK_SYSTEM_USER_ID) — its real per-message identity (name/avatar) comes from
// the webhook itself instead, overlaid onto that placeholder's public shape so every client
// codepath that reads m.author.displayName/avatarPath/id keeps working unmodified.
function webhookAuthorOverride(webhookId) {
  if (!webhookId) return null;
  const webhook = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(webhookId);
  return webhook ? { name: webhook.name, avatarPath: webhook.avatar_path } : null;
}

function parseEventData(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function serializeMessage(row) {
  const author = db.prepare('SELECT * FROM users WHERE id = ?').get(row.author_id);
  const webhook = webhookAuthorOverride(row.webhook_id);
  const authorPublic = webhook
    ? { ...toPublicUser(author, {}), displayName: webhook.name, username: webhook.name, avatarPath: webhook.avatarPath }
    : toPublicUser(author, {});
  const attachments = db.prepare('SELECT * FROM attachments WHERE message_id = ?').all(row.id).map((a) => ({
    id: a.id,
    url: a.file_path,
    fileName: a.file_name,
    mimeType: a.mime_type,
    sizeBytes: a.size_bytes,
    voiceMs: a.voice_ms || null,
  }));
  return {
    id: row.id,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    author: authorPublic,
    isWebhook: !!webhook,
    content: row.content,
    isEncrypted: !!row.is_encrypted,
    eventType: row.event_type || null,
    eventData: parseEventData(row.event_data),
    createdAt: row.created_at,
    editedAt: row.edited_at,
    attachments,
    reactions: getReactions(row.id),
    replyTo: getReplyTo(row.reply_to_message_id),
    pinnedAt: row.pinned_at || null,
    pinnedBy: row.pinned_by ? toPublicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(row.pinned_by), {}) : null,
    embed: row.embed ? JSON.parse(row.embed) : null,
    poll: getPoll(row.id),
    forwardedFrom: row.forwarded_from_message_id ? getForwardedFrom(row.forwarded_from_message_id) : null,
    sticker: getSticker(row.sticker_id),
    interaction: row.interaction_command ? getInteraction(row) : null,
  };
}

function getInteraction(row) {
  const u = row.interaction_user_id ? db.prepare('SELECT id, username, display_name FROM users WHERE id = ?').get(row.interaction_user_id) : null;
  return { command: row.interaction_command, user: u ? { id: u.id, username: u.username, displayName: u.display_name || u.username } : null };
}

function getSticker(stickerId) {
  if (!stickerId) return null;
  const row = db.prepare('SELECT id, name, image_path FROM stickers WHERE id = ?').get(stickerId);
  return row ? { id: row.id, name: row.name, imagePath: row.image_path } : null;
}

function listMessages(scopeType, scopeId, { before, after, limit = 50, around } = {}) {
  const cap = Math.min(Number(limit) || 50, 100);
  let rows;
  if (around) {
    // Jumping to a search hit: half a page on either side of the target message, target included.
    const half = Math.floor(cap / 2);
    const older = db.prepare(
      `SELECT * FROM messages WHERE scope_type = ? AND scope_id = ? AND id <= ? ORDER BY id DESC LIMIT ?`
    ).all(scopeType, scopeId, around, half + 1).reverse();
    const newer = db.prepare(
      `SELECT * FROM messages WHERE scope_type = ? AND scope_id = ? AND id > ? ORDER BY id ASC LIMIT ?`
    ).all(scopeType, scopeId, around, half);
    rows = [...older, ...newer];
  } else if (after) {
    rows = db.prepare(
      `SELECT * FROM messages WHERE scope_type = ? AND scope_id = ? AND id > ? ORDER BY id ASC LIMIT ?`
    ).all(scopeType, scopeId, after, cap);
  } else if (before) {
    rows = db.prepare(
      `SELECT * FROM messages WHERE scope_type = ? AND scope_id = ? AND id < ? ORDER BY id DESC LIMIT ?`
    ).all(scopeType, scopeId, before, cap).reverse();
  } else {
    rows = db.prepare(
      `SELECT * FROM messages WHERE scope_type = ? AND scope_id = ? ORDER BY id DESC LIMIT ?`
    ).all(scopeType, scopeId, cap).reverse();
  }
  return rows.map(serializeMessage);
}

module.exports = { serializeMessage, listMessages };
