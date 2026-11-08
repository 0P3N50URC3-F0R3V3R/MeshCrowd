const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const SUFFIX = '.poster.jpg';
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.m4v', '.ogv']);
const pending = new Map();
let ffmpegMissing = false;

function extract(src, dest) {
  if (pending.has(dest)) return pending.get(dest);
  const tmp = `${dest}.${process.pid}.tmp.jpg`;
  const p = new Promise((resolve) => {
    execFile('ffmpeg', ['-y', '-v', 'error', '-ss', '0.1', '-i', src, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '5', tmp],
      { timeout: 15000, windowsHide: true }, (err) => {
        if (err) {
          if (err.code === 'ENOENT') ffmpegMissing = true;
          fs.unlink(tmp, () => {});
          return resolve(false);
        }
        fs.rename(tmp, dest, (e) => resolve(!e));
      });
  }).finally(() => pending.delete(dest));
  pending.set(dest, p);
  return p;
}

function posterMiddleware(root) {
  const base = path.resolve(root);
  return async (req, res, next) => {
    if (!req.path.endsWith(SUFFIX)) return next();
    let rel;
    try { rel = decodeURIComponent(req.path); } catch { return next(); }
    const dest = path.resolve(base, '.' + rel);
    if (!dest.startsWith(base + path.sep) || /^\/dm-/.test(rel)) return next();
    const src = dest.slice(0, -SUFFIX.length);
    if (!VIDEO_EXT.has(path.extname(src).toLowerCase())) return next();
    if (!fs.existsSync(dest)) {
      if (ffmpegMissing || !fs.existsSync(src)) return res.sendStatus(404);
      if (!(await extract(src, dest))) return res.sendStatus(404);
    }
    res.set('Cache-Control', 'public, max-age=86400').type('image/jpeg').sendFile(dest);
  };
}

module.exports = { posterMiddleware, SUFFIX };
