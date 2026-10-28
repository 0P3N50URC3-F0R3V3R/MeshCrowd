'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { db, DATA_DIR } = require('../db');

// Opaque ciphertext blobs for encrypted 1:1 DMs. Kept under attachments/ but never served by the
// static /uploads route (index.js blocks this subtree); only routes/dms.js hands them out.
const ROOT = path.join(DATA_DIR, 'attachments', 'e2ee');
const BLOB_ID_RE = /^[0-9a-f]{32}$/;

function dmFilePath(dmId, blobId) {
  const dir = path.join(ROOT, `dm-${Number(dmId)}`);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${blobId}.bin`);
}

// Files first, rows second: message/DM deletes cascade the rows, so callers run this before them.
function unlinkRows(rows) {
  for (const f of rows) {
    try { fs.unlinkSync(dmFilePath(f.dm_id, f.blob_id)); } catch { /* already gone */ }
    db.prepare('DELETE FROM dm_e2ee_files WHERE id = ?').run(f.id);
  }
}

function unlinkDmFilesOfMessage(messageId) {
  unlinkRows(db.prepare('SELECT id, dm_id, blob_id FROM dm_e2ee_files WHERE message_id = ?').all(messageId));
}

function unlinkDmFilesOfDm(dmId) {
  unlinkRows(db.prepare('SELECT id, dm_id, blob_id FROM dm_e2ee_files WHERE dm_id = ?').all(dmId));
}

// Unsent uploads older than a day, plus disk files whose row vanished through a cascade (user
// deleted) or a crash between the write and the insert.
function sweepDmFiles() {
  unlinkRows(db.prepare("SELECT id, dm_id, blob_id FROM dm_e2ee_files WHERE message_id IS NULL AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')").all());
  if (!fs.existsSync(ROOT)) return;
  const known = new Set(db.prepare('SELECT dm_id, blob_id FROM dm_e2ee_files').all().map((r) => `${r.dm_id}/${r.blob_id}`));
  for (const dirName of fs.readdirSync(ROOT)) {
    const m = /^dm-(\d+)$/.exec(dirName);
    if (!m) continue;
    const dir = path.join(ROOT, dirName);
    for (const file of fs.readdirSync(dir)) {
      if (!known.has(`${m[1]}/${file.replace(/\.bin$/, '')}`)) {
        try { fs.unlinkSync(path.join(dir, file)); } catch { /* ignore */ }
      }
    }
  }
}

module.exports = { BLOB_ID_RE, dmFilePath, unlinkDmFilesOfMessage, unlinkDmFilesOfDm, sweepDmFiles };
