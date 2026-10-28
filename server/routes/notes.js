'use strict';

const express = require('express');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { PERMISSIONS, has } = require('../lib/permissions');
const { getChannelPermissionBits } = require('../lib/channelAccess');
const { logAudit } = require('../lib/auditLog');
const { load: loadConfig } = require('../lib/config');
const { unlinkNoteFiles, noteFilePath } = require('../lib/noteFiles');

const router = express.Router({ mergeParams: true });
const config = loadConfig();

const MAX_CIPHERTEXT = 40 * 1024;
const MAX_FILES_PER_NOTE = 5;
const MAX_UNSAVED_UPLOADS = 10;
const MAX_NOTES_PER_CHANNEL = 5000;
const MAX_FILE_BYTES_PER_CHANNEL = 1024 * 1024 * 1024;
const BASE64_RE = /^[A-Za-z0-9+/_-]+={0,2}$/;

function loadNotesChannel(req, res, next) {
  const channel = db.prepare('SELECT * FROM channels WHERE id = ? AND server_id = ? AND type = ?')
    .get(req.params.channelId, req.params.id, 'notes');
  if (!channel) return res.status(404).json({ error: 'notes channel not found' });
  const isMember = db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(channel.server_id, req.user.id);
  if (!isMember) return res.status(403).json({ error: 'not a member of this server' });
  if (!has(getChannelPermissionBits(channel, req.user.id), PERMISSIONS.VIEW_CHANNEL)) return res.status(404).json({ error: 'notes channel not found' });
  req.channel = channel;
  next();
}

function shape(row) {
  const files = db.prepare('SELECT id, size FROM note_files WHERE note_id = ? ORDER BY id').all(row.id);
  return { id: row.id, nonce: row.nonce, ciphertext: row.ciphertext, createdAt: row.created_at, editedAt: row.edited_at, files };
}

function cleanPayload(body) {
  const nonce = body?.nonce; const ciphertext = body?.ciphertext;
  if (typeof nonce !== 'string' || nonce.length < 8 || nonce.length > 64 || !BASE64_RE.test(nonce)) return null;
  if (typeof ciphertext !== 'string' || !ciphertext || ciphertext.length > MAX_CIPHERTEXT || !BASE64_RE.test(ciphertext)) return null;
  return { nonce, ciphertext };
}

// The ids the client says this note references. Each must be the caller's own upload in this
// channel and not already claimed by a different note. Returns null when invalid.
function cleanFileIds(req, noteId) {
  const raw = req.body?.fileIds;
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_FILES_PER_NOTE) return null;
  const ids = [...new Set(raw.map(Number))];
  for (const id of ids) {
    if (!Number.isInteger(id)) return null;
    const f = db.prepare('SELECT note_id FROM note_files WHERE id = ? AND channel_id = ? AND user_id = ?').get(id, req.channel.id, req.user.id);
    if (!f || (f.note_id !== null && f.note_id !== noteId)) return null;
  }
  return ids;
}

function linkFiles(noteId, ids) {
  const stale = db.prepare('SELECT id FROM note_files WHERE note_id = ?').all(noteId).map((r) => r.id).filter((id) => !ids.includes(id));
  unlinkNoteFiles(stale);
  for (const id of ids) db.prepare('UPDATE note_files SET note_id = ? WHERE id = ?').run(noteId, id);
}

function fileIdsOfNotes(where, ...params) {
  return db.prepare(`SELECT f.id FROM note_files f JOIN note_entries n ON n.id = f.note_id WHERE ${where}`).all(...params).map((r) => r.id);
}

router.use(requireAuth, loadNotesChannel);

// Only ever the caller's own rows — there is deliberately no way to name another user_id.
router.get('/', (req, res) => {
  const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 200);
  const rows = db.prepare('SELECT * FROM note_entries WHERE channel_id = ? AND user_id = ? AND id < ? ORDER BY id DESC LIMIT ?')
    .all(req.channel.id, req.user.id, before, limit).reverse();
  res.json({ notes: rows.map(shape) });
});

router.post('/', (req, res) => {
  const payload = cleanPayload(req.body);
  const fileIds = cleanFileIds(req, null);
  if (!payload || !fileIds) return res.status(400).json({ error: 'invalid note payload' });
  if (db.prepare('SELECT COUNT(*) AS c FROM note_entries WHERE channel_id = ? AND user_id = ?').get(req.channel.id, req.user.id).c >= MAX_NOTES_PER_CHANNEL) return res.status(409).json({ error: 'note limit reached' });
  const info = db.prepare('INSERT INTO note_entries (channel_id, user_id, nonce, ciphertext) VALUES (?, ?, ?, ?)')
    .run(req.channel.id, req.user.id, payload.nonce, payload.ciphertext);
  linkFiles(info.lastInsertRowid, fileIds);
  res.status(201).json({ note: shape(db.prepare('SELECT * FROM note_entries WHERE id = ?').get(info.lastInsertRowid)) });
});

// Admin trim: deletes by age without ever reading or returning content. Counts only.
router.post('/trim', (req, res) => {
  const bits = getChannelPermissionBits(req.channel, req.user.id);
  if (!has(bits, PERMISSIONS.PRUNE_CONTENT) && !has(bits, PERMISSIONS.MANAGE_CHANNELS)) return res.status(403).json({ error: 'missing permission' });
  const cutoff = new Date(String(req.body?.before || ''));
  if (Number.isNaN(cutoff.getTime())) return res.status(400).json({ error: 'valid "before" date required' });
  const iso = cutoff.toISOString();
  unlinkNoteFiles(fileIdsOfNotes('n.channel_id = ? AND n.created_at < ?', req.channel.id, iso));
  const info = db.prepare('DELETE FROM note_entries WHERE channel_id = ? AND created_at < ?').run(req.channel.id, iso);
  logAudit(req.channel.server_id, req.user.id, 'notes_trim', 'channel', req.channel.id, { before: iso, deleted: info.changes });
  res.json({ deleted: info.changes });
});

// Raw encrypted blob (iv || ciphertext). The server cannot tell what it is and only ever serves it
// back to the uploader. Registered before /:noteId so "files" is never parsed as an id.
router.post('/files', express.raw({ type: 'application/octet-stream', limit: `${config.maxUploadMb + 1}mb` }), (req, res) => {
  const body = req.body;
  if (!Buffer.isBuffer(body) || body.length < 29) return res.status(400).json({ error: 'encrypted file body required' });
  const unsaved = db.prepare('SELECT COUNT(*) AS c FROM note_files WHERE user_id = ? AND channel_id = ? AND note_id IS NULL').get(req.user.id, req.channel.id).c;
  if (unsaved >= MAX_UNSAVED_UPLOADS) return res.status(429).json({ error: 'too many unsaved uploads' });
  const used = db.prepare('SELECT COALESCE(SUM(size), 0) AS s FROM note_files WHERE user_id = ? AND channel_id = ?').get(req.user.id, req.channel.id).s;
  if (used + body.length > MAX_FILE_BYTES_PER_CHANNEL) return res.status(413).json({ error: 'storage limit reached' });
  const token = crypto.randomBytes(16).toString('hex');
  const info = db.prepare('INSERT INTO note_files (channel_id, user_id, file_name, size) VALUES (?, ?, ?, ?)')
    .run(req.channel.id, req.user.id, token, body.length);
  fs.writeFileSync(noteFilePath(req.channel.id, token), body);
  res.status(201).json({ file: { id: info.lastInsertRowid, size: body.length } });
});

router.get('/files/:fileId', (req, res) => {
  const f = db.prepare('SELECT * FROM note_files WHERE id = ? AND channel_id = ? AND user_id = ?')
    .get(Number(req.params.fileId), req.channel.id, req.user.id);
  if (!f) return res.status(404).json({ error: 'file not found' });
  res.type('application/octet-stream').set('Cache-Control', 'private, no-store').sendFile(noteFilePath(f.channel_id, f.file_name));
});

// Only for uploads not yet attached to a note; attached files go away with their note or an edit.
router.delete('/files/:fileId', (req, res) => {
  const f = db.prepare('SELECT id FROM note_files WHERE id = ? AND channel_id = ? AND user_id = ? AND note_id IS NULL')
    .get(Number(req.params.fileId), req.channel.id, req.user.id);
  if (!f) return res.status(404).json({ error: 'file not found' });
  unlinkNoteFiles([f.id]);
  res.json({ ok: true });
});

router.patch('/:noteId', (req, res) => {
  const noteId = Number(req.params.noteId);
  const payload = cleanPayload(req.body);
  const fileIds = req.body?.fileIds === undefined ? undefined : cleanFileIds(req, noteId);
  if (!payload || fileIds === null) return res.status(400).json({ error: 'invalid note payload' });
  const info = db.prepare('UPDATE note_entries SET nonce = ?, ciphertext = ?, edited_at = ? WHERE id = ? AND channel_id = ? AND user_id = ?')
    .run(payload.nonce, payload.ciphertext, new Date().toISOString(), noteId, req.channel.id, req.user.id);
  if (!info.changes) return res.status(404).json({ error: 'note not found' });
  if (fileIds !== undefined) linkFiles(noteId, fileIds);
  res.json({ note: shape(db.prepare('SELECT * FROM note_entries WHERE id = ?').get(noteId)) });
});

router.delete('/:noteId', (req, res) => {
  const noteId = Number(req.params.noteId);
  unlinkNoteFiles(fileIdsOfNotes('n.id = ? AND n.user_id = ? AND n.channel_id = ?', noteId, req.user.id, req.channel.id));
  const info = db.prepare('DELETE FROM note_entries WHERE id = ? AND channel_id = ? AND user_id = ?').run(noteId, req.channel.id, req.user.id);
  if (!info.changes) return res.status(404).json({ error: 'note not found' });
  res.json({ ok: true });
});

module.exports = router;
