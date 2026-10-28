'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { db, DATA_DIR } = require('../db');

const ROOT = path.join(DATA_DIR, 'notefiles');

function noteFilePath(channelId, token) {
  const dir = path.join(ROOT, `channel-${Number(channelId)}`);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${token}.bin`);
}

// Deletes blob files from disk and their rows. Row deletes by note/channel/user cascade in SQL, so
// callers delete the files first while the rows can still be looked up.
function unlinkNoteFiles(ids) {
  for (const id of ids) {
    const f = db.prepare('SELECT channel_id, file_name FROM note_files WHERE id = ?').get(id);
    if (!f) continue;
    try { fs.unlinkSync(noteFilePath(f.channel_id, f.file_name)); } catch { /* already gone */ }
    db.prepare('DELETE FROM note_files WHERE id = ?').run(id);
  }
}

// Disk files whose row vanished through a cascade (channel/server/user deleted) or a crash between
// the file write and the insert are removed at startup, plus unsaved uploads left for over a day.
function sweepNoteFiles() {
  const stale = db.prepare("SELECT id FROM note_files WHERE note_id IS NULL AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')").all();
  unlinkNoteFiles(stale.map((r) => r.id));
  const known = new Set(db.prepare('SELECT channel_id, file_name FROM note_files').all().map((r) => `${r.channel_id}/${r.file_name}`));
  if (!fs.existsSync(ROOT)) return;
  for (const dirName of fs.readdirSync(ROOT)) {
    const m = /^channel-(\d+)$/.exec(dirName);
    if (!m) continue;
    const dir = path.join(ROOT, dirName);
    for (const file of fs.readdirSync(dir)) {
      if (!known.has(`${m[1]}/${file.replace(/\.bin$/, '')}`)) {
        try { fs.unlinkSync(path.join(dir, file)); } catch { /* ignore */ }
      }
    }
  }
}

module.exports = { noteFilePath, unlinkNoteFiles, sweepNoteFiles };
