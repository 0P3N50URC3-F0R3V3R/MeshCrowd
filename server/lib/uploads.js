'use strict';

const fs = require('node:fs');
const path = require('node:path');
const multer = require('multer');
const siteSettings = require('./siteSettings');
const { load: loadConfig, save: saveConfig } = require('./config');

const BLOCKED_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.com', '.msi', '.ps1', '.psm1', '.sh', '.bash',
  '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.scr', '.jar', '.dll', '.cpl',
  '.hta', '.msc', '.reg', '.lnk', '.pif', '.scf', '.url', '.jnlp', '.msix', '.appx',
  '.html', '.htm', '.xhtml', '.svg', '.shtml',
]);

// Multer/busboy decode the multipart filename header as latin1 regardless of what the browser
// actually sent, so any non-ASCII filename (e.g. "café.png", "日本語.pdf") arrives mojibake'd.
// Round-tripping the mis-decoded string through latin1->utf8 recovers the original bytes - the
// standard fix for this well-known busboy behavior. Call this once, as early as possible (multer's
// fileFilter), before the name is used for anything else.
function fixUtf8Filename(name) {
  return Buffer.from(String(name || ''), 'latin1').toString('utf8');
}

// Never trust the client-supplied filename as-is: strip path separators/NTFS alt-data-stream
// syntax and Windows' trailing dot/space quirk (both of which defeat naive extension checks).
function sanitizeFilename(original) {
  const safe = path.basename(String(original || ''))
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/[. ]+$/, '')
    .slice(0, 100);
  return safe || 'file';
}

function isBlockedExtension(originalname) {
  return BLOCKED_EXTENSIONS.has(path.extname(sanitizeFilename(originalname)).toLowerCase());
}

// Combines the always-on dangerous-extension denylist with the admin panel's optional allowlist
// (Admin > Overview > Attachment Settings). No allowlist configured = denylist is the only gate,
// same behavior as before that setting existed.
function isAllowedUpload(originalname) {
  if (isBlockedExtension(originalname)) return false;
  const allowlist = siteSettings.getAllowedExtensions();
  if (!allowlist) return true;
  const ext = path.extname(sanitizeFilename(originalname)).toLowerCase();
  return allowlist.includes(ext);
}

// Multer's silent "cb(null, false)" would drop a blocked file and still create the message, so the
// sender never learns the attachment vanished; fail the whole request with a readable reason instead.
function attachmentFileFilter(req, file, cb) {
  file.originalname = fixUtf8Filename(file.originalname);
  if (isAllowedUpload(file.originalname)) return cb(null, true);
  const err = new Error(`file type not allowed: ${sanitizeFilename(file.originalname)}`);
  err.name = 'MulterError';
  err.code = 'BLOCKED_FILE_TYPE';
  cb(err);
}

// One upload limit for the whole server: config.json "maxUploadMb". The Admin Panel and the SSH
// console both edit that same value, and it is re-read on every upload, so a change applies live.
function effectiveMaxUploadMb() {
  return loadConfig().maxUploadMb;
}

// Older versions kept a second, admin-panel-only cap that could only tighten config.json's value.
// Fold it into the single setting once, then forget it.
function migrateUploadLimit() {
  const legacy = Number(siteSettings.get('max_upload_mb'));
  if (!Number.isFinite(legacy) || legacy <= 0) return;
  const current = loadConfig().maxUploadMb;
  if (legacy < current) saveConfig({ maxUploadMb: Math.max(1, Math.round(legacy)) });
  siteSettings.set('max_upload_mb', '');
}

// multer fixes its size limit when it is created; build it per request so the limit follows the setting.
function liveUpload({ storage, capBytes = Infinity, files = 5 }) {
  return {
    array(field, max) {
      return (req, res, next) => {
        const fileSize = Math.floor(Math.min(effectiveMaxUploadMb() * 1024 * 1024, capBytes));
        multer({ storage, fileFilter: attachmentFileFilter, limits: { fileSize, files } }).array(field, max)(req, res, next);
      };
    },
  };
}

// multer's own `limits.fileSize` is fixed at process start from config.json, so it can't reflect
// an admin-panel change made at runtime. Call this right after the upload.array(...) middleware,
// before touching the DB - it deletes the temp files and sends the 400 itself. Returns true if it
// did (caller should just `return`).
function rejectOversizedFiles(req, res) {
  const maxMb = effectiveMaxUploadMb();
  const tooLarge = (req.files || []).some((f) => f.size > maxMb * 1024 * 1024);
  if (!tooLarge) return false;
  for (const f of req.files) { try { fs.unlinkSync(f.path); } catch { /* best-effort cleanup */ } }
  res.status(400).json({ error: `attachment too large - max ${maxMb}MB` });
  return true;
}

module.exports = {
  BLOCKED_EXTENSIONS, sanitizeFilename, isBlockedExtension, fixUtf8Filename,
  isAllowedUpload, attachmentFileFilter, effectiveMaxUploadMb, migrateUploadLimit, liveUpload, rejectOversizedFiles,
};
