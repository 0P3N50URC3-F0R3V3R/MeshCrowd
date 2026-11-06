'use strict';

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { db, DATA_DIR } = require('../db');
const { open } = require('../lib/atRest');
const { isSealedFile, plainSize, readSealedRange } = require('../lib/fileSeal');
const { canViewMessage } = require('../lib/userMeta');

// DM attachments are sealed on disk, so they are served here (decrypted, with Range support for
// audio/video) instead of by the static handler, and only to members of the conversation - or to
// anyone who can see a message that forwarded the original.
const router = express.Router();

const INLINE_IMAGE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/x-icon']);
const MEDIA = /^(audio|video)\/[\w.+-]+$/;
const FILE_RE = /^[A-Za-z0-9._-]{1,200}$/;

function mayView(user, dmId, messageId) {
  if (db.prepare('SELECT 1 FROM dm_members WHERE dm_channel_id = ? AND user_id = ?').get(dmId, user.id)) return true;
  const forwards = db.prepare('SELECT * FROM messages WHERE forwarded_from_message_id = ?').all(messageId);
  return forwards.some((m) => canViewMessage(user.id, m));
}

function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header || '');
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start; let end;
  if (m[1] === '') { start = Math.max(0, size - Number(m[2])); end = size - 1; } else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  return start <= end && start < size ? { start, end } : 'bad';
}

router.get('/dm-:dmId/:file', (req, res) => {
  if (!req.user) return res.status(401).end();
  const dmId = Number(req.params.dmId);
  const { file } = req.params;
  if (!Number.isInteger(dmId) || !FILE_RE.test(file) || file.startsWith('.')) return res.status(404).end();
  const row = db.prepare('SELECT * FROM attachments WHERE file_path = ?').get(`/uploads/attachments/dm-${dmId}/${file}`);
  if (!row || !mayView(req.user, dmId, row.message_id)) return res.status(404).end();
  const disk = path.join(DATA_DIR, 'attachments', `dm-${dmId}`, file);
  if (!fs.existsSync(disk)) return res.status(404).end();

  const sealed = isSealedFile(disk);
  const size = sealed ? plainSize(disk) : fs.statSync(disk).size;
  const mime = String(row.mime_type || '').toLowerCase().split(';')[0].trim();
  const inline = INLINE_IMAGE.has(mime);
  const name = (open(row.file_name) || 'file').replace(/[\r\n"]/g, '_');

  res.setHeader('Content-Type', inline || MEDIA.test(mime) ? mime : 'application/octet-stream');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('Accept-Ranges', 'bytes');

  const range = parseRange(req.headers.range, size);
  if (range === 'bad') { res.setHeader('Content-Range', `bytes */${size}`); return res.status(416).end(); }
  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  if (range) { res.status(206); res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`); }
  res.setHeader('Content-Length', size ? end - start + 1 : 0);
  if (!size) return res.end();
  const stream = sealed ? readSealedRange(disk, start, end) : fs.createReadStream(disk, { start, end });
  stream.on('error', () => res.destroy());
  stream.pipe(res);
});

module.exports = router;
