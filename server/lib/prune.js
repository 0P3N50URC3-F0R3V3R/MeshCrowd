'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { db, DATA_DIR, WEBHOOK_SYSTEM_USER_ID } = require('../db');
const { serializeMessage } = require('./messages');
const { unlinkDmFilesOfMessage, unlinkDmFilesOfDm } = require('./dmFiles');
const { broadcastToChannel, broadcastToDm } = require('../socket/hub');

const GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;
const WORKER_INTERVAL_MS = 60 * 1000;

// A prune scope is a set of (scope_type, scope_id) pairs against the generic `messages` table.
// Pruning a channel also pulls in every thread spawned from it — threads have no separate
// "room" of their own, they inherit the parent channel's lifecycle.
function resolveScopePairs(scopeKind, ids) {
  if (scopeKind === 'dm') return [{ scope_type: 'dm', scope_id: ids[0] }];

  const pairs = ids.map((id) => ({ scope_type: 'channel', scope_id: id }));
  const placeholders = ids.map(() => '?').join(',');
  if (ids.length) {
    const threads = db.prepare(`SELECT id FROM threads WHERE channel_id IN (${placeholders})`).all(...ids);
    for (const t of threads) pairs.push({ scope_type: 'thread', scope_id: t.id });
  }
  return pairs;
}

// Unchecked "delete attachments" means messages carrying an attachment are left alone entirely
// (skipped, regardless of date) — only attachment-free messages before the cutoff are counted.
// Encrypted-DM blobs count as attachments too.
const NO_ATTACHMENTS = 'AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id) AND NOT EXISTS (SELECT 1 FROM dm_e2ee_files f WHERE f.message_id = m.id)';

function pairsWhereClause(pairs) {
  return pairs.map(() => '(scope_type = ? AND scope_id = ?)').join(' OR ');
}
function pairsParams(pairs) {
  return pairs.flatMap((p) => [p.scope_type, p.scope_id]);
}

function previewPrune(pairs, cutoffAt, purgeAttachments) {
  if (pairs.length === 0) return { messageCount: 0, attachmentCount: 0, attachmentBytes: 0 };
  const attachmentFilter = purgeAttachments ? '' : NO_ATTACHMENTS;
  const messageCount = db.prepare(
    `SELECT COUNT(*) AS n FROM messages m WHERE (${pairsWhereClause(pairs)}) AND m.created_at < ? ${attachmentFilter}`
  ).get(...pairsParams(pairs), cutoffAt).n;

  if (!purgeAttachments) return { messageCount, attachmentCount: 0, attachmentBytes: 0 };

  const row = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(a.size_bytes), 0) AS bytes
       FROM attachments a JOIN messages m ON m.id = a.message_id
      WHERE (${pairsWhereClause(pairs)}) AND m.created_at < ?`
  ).get(...pairsParams(pairs), cutoffAt);
  const e2ee = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(f.size), 0) AS bytes
       FROM dm_e2ee_files f JOIN messages m ON m.id = f.message_id
      WHERE (${pairsWhereClause(pairs)}) AND m.created_at < ?`
  ).get(...pairsParams(pairs), cutoffAt);
  return { messageCount, attachmentCount: row.n + e2ee.n, attachmentBytes: row.bytes + e2ee.bytes };
}

function unlinkAttachmentFile(filePath) {
  const rel = filePath.replace(/^\/uploads\//, '');
  try { fs.unlinkSync(path.join(DATA_DIR, rel)); } catch { /* already gone — fine */ }
}

// Deletes the matching messages (cascades attachments/reactions rows + the messages_fts index
// automatically via existing FK/triggers). When purgeAttachments is true, attachment files are
// unlinked from disk first, since the DB row disappears the moment the DELETE below runs.
// node:sqlite's DatabaseSync has no .transaction() helper (unlike better-sqlite3), so this wraps
// the delete in an explicit BEGIN/COMMIT by hand.
function deletePrune(pairs, cutoffAt, purgeAttachments) {
  if (pairs.length === 0) return { messageCount: 0, attachmentCount: 0, attachmentBytes: 0 };
  const counts = previewPrune(pairs, cutoffAt, purgeAttachments);
  const attachmentFilter = purgeAttachments ? '' : NO_ATTACHMENTS;

  if (purgeAttachments) {
    const files = db.prepare(
      `SELECT a.file_path FROM attachments a JOIN messages m ON m.id = a.message_id
        WHERE (${pairsWhereClause(pairs)}) AND m.created_at < ?`
    ).all(...pairsParams(pairs), cutoffAt);
    for (const f of files) unlinkAttachmentFile(f.file_path);
    const e2eeMessages = db.prepare(
      `SELECT DISTINCT f.message_id FROM dm_e2ee_files f JOIN messages m ON m.id = f.message_id
        WHERE (${pairsWhereClause(pairs)}) AND m.created_at < ?`
    ).all(...pairsParams(pairs), cutoffAt);
    for (const r of e2eeMessages) unlinkDmFilesOfMessage(r.message_id);
  }

  // Grabbed before the DELETE so any client with the scope open right now can drop them live,
  // the same ws contract routes/messages.js's own single-message delete already uses.
  const doomed = db.prepare(
    `SELECT m.id, m.scope_type, m.scope_id FROM messages m
      WHERE (${pairsWhereClause(pairs)}) AND m.created_at < ? ${attachmentFilter}`
  ).all(...pairsParams(pairs), cutoffAt);

  db.exec('BEGIN');
  try {
    db.prepare(
      `DELETE FROM messages AS m WHERE (${pairsWhereClause(pairs)}) AND m.created_at < ? ${attachmentFilter}`
    ).run(...pairsParams(pairs), cutoffAt);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  for (const row of doomed) {
    const payload = { type: 'message_delete', messageId: row.id, scopeType: row.scope_type, scopeId: row.scope_id };
    if (row.scope_type === 'dm') {
      broadcastToDm(row.scope_id, payload);
    } else {
      const channel = row.scope_type === 'thread'
        ? (() => { const t = db.prepare('SELECT channel_id FROM threads WHERE id = ?').get(row.scope_id); return t && db.prepare('SELECT * FROM channels WHERE id = ?').get(t.channel_id); })()
        : db.prepare('SELECT * FROM channels WHERE id = ?').get(row.scope_id);
      if (channel) broadcastToChannel(channel, payload);
    }
  }

  return counts;
}

function noticeText(cutoffAt, whenLabel) {
  const date = new Date(cutoffAt).toLocaleDateString();
  return `An admin ${whenLabel} messages sent before ${date} to free up space.`;
}

function postNotice(pairs, cutoffAt, whenLabel) {
  for (const pair of pairs) {
    if (pair.scope_type === 'thread') continue; // notice lives on the parent channel only
    const content = noticeText(cutoffAt, whenLabel);
    if (pair.scope_type === 'channel') {
      const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(pair.scope_id);
      if (!channel || channel.type === 'notes') continue;
      const info = db.prepare(
        'INSERT INTO messages (scope_type, scope_id, author_id, content, event_type) VALUES (?, ?, ?, ?, ?)'
      ).run('channel', channel.id, WEBHOOK_SYSTEM_USER_ID, content, 'data_prune');
      const message = serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid));
      broadcastToChannel(channel, { type: 'message_create', message });
    } else if (pair.scope_type === 'dm') {
      const info = db.prepare(
        'INSERT INTO messages (scope_type, scope_id, author_id, content, event_type) VALUES (?, ?, ?, ?, ?)'
      ).run('dm', pair.scope_id, WEBHOOK_SYSTEM_USER_ID, content, 'data_prune');
      const message = serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid));
      broadcastToDm(pair.scope_id, { type: 'message_create', message });
    }
  }
}

// notify: 'immediate' runs the delete right now (after posting the notice); 'grace' posts the
// notice now and defers the actual delete by GRACE_PERIOD_MS via pending_prunes + the worker.
function executePrune({ scopeKind, ids, cutoffAt, purgeAttachments, notify, requestedBy, serverId }) {
  const pairs = resolveScopePairs(scopeKind, ids);

  if (notify === 'grace') {
    postNotice(pairs, cutoffAt, 'scheduled the removal of');
    const executeAt = new Date(Date.now() + GRACE_PERIOD_MS).toISOString();
    db.prepare(
      `INSERT INTO pending_prunes (scope_kind, scope_ids, server_id, cutoff_at, purge_attachments, requested_by, execute_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(scopeKind, JSON.stringify(ids), serverId || null, cutoffAt, purgeAttachments ? 1 : 0, requestedBy, executeAt);
    return { status: 'scheduled', executeAt, ...previewPrune(pairs, cutoffAt, purgeAttachments) };
  }

  postNotice(pairs, cutoffAt, 'cleared');
  const counts = deletePrune(pairs, cutoffAt, purgeAttachments);
  return { status: 'done', ...counts };
}

// Full wipe of one scope's messages (attachments unlinked, no cutoff, no notice) — used when the
// whole conversation is going away anyway (last member left a DM, or its creator deleted it), so
// there's no point pruning by date first.
function wipeScope(scopeType, scopeId) {
  const files = db.prepare(
    'SELECT a.file_path FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.scope_type = ? AND m.scope_id = ?'
  ).all(scopeType, scopeId);
  for (const f of files) unlinkAttachmentFile(f.file_path);
  if (scopeType === 'dm') unlinkDmFilesOfDm(scopeId);
  db.prepare('DELETE FROM messages WHERE scope_type = ? AND scope_id = ?').run(scopeType, scopeId);
}

function runDuePrunes() {
  const due = db.prepare("SELECT * FROM pending_prunes WHERE status = 'pending' AND execute_at <= ?").all(new Date().toISOString());
  for (const job of due) {
    const ids = JSON.parse(job.scope_ids);
    const pairs = resolveScopePairs(job.scope_kind, ids);
    deletePrune(pairs, job.cutoff_at, !!job.purge_attachments);
    db.prepare("UPDATE pending_prunes SET status = 'done' WHERE id = ?").run(job.id);
  }
}

const PASSPORT_AUDIT_RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

function prunePassportAudit(now = Date.now()) {
  const cutoff = new Date(now - PASSPORT_AUDIT_RETENTION_DAYS * DAY_MS).toISOString();
  return db.prepare('DELETE FROM passport_audit WHERE created_at < ?').run(cutoff).changes;
}

let workerHandle = null;
let auditHandle = null;
function startPruneWorker() {
  if (workerHandle) return;
  workerHandle = setInterval(runDuePrunes, WORKER_INTERVAL_MS);
  workerHandle.unref?.();
  prunePassportAudit();
  auditHandle = setInterval(prunePassportAudit, DAY_MS);
  auditHandle.unref?.();
}

module.exports = { resolveScopePairs, previewPrune, executePrune, runDuePrunes, startPruneWorker, prunePassportAudit, wipeScope, GRACE_PERIOD_MS };
