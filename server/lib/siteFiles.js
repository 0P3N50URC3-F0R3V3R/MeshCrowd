'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DATA_DIR } = require('../db');

const SITES_DIR = path.join(DATA_DIR, 'sites');
const ALLOWED_EXT = new Set(['php', 'html', 'htm', 'css', 'js', 'json', 'txt', 'md', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico']);
const TEXT_EXT = new Set(['php', 'html', 'htm', 'css', 'js', 'json', 'txt', 'md', 'svg']);
const LIMITS = { maxFileBytes: 2 * 1024 * 1024, maxFiles: 200, maxTotalBytes: 50 * 1024 * 1024 };
const MAX_DEPTH = 8;
// Letters/digits first and last (so no leading dot, no trailing dot/space that Windows would strip).
const NAME_RE = /^[\p{L}\p{N}](?:[\p{L}\p{N}._ -]{0,98}[\p{L}\p{N}_-])?$/u;
const RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

class SiteFileError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const siteDir = (id) => path.join(SITES_DIR, String(Number(id)));
function ensureSiteDir(id) { fs.mkdirSync(siteDir(id), { recursive: true }); return siteDir(id); }

const validName = (name) => NAME_RE.test(name) && !RESERVED_RE.test(name);
const extOf = (name) => path.extname(name).slice(1).toLowerCase();

function splitRel(rel) {
  if (typeof rel !== 'string' || rel.length > 400 || rel.includes('\0')) throw new SiteFileError(400, 'invalid path');
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  if (parts.length > MAX_DEPTH) throw new SiteFileError(400, 'invalid path');
  for (const p of parts) if (!validName(p)) throw new SiteFileError(400, 'invalid path');
  return parts;
}

function hasLinkInPath(root, parts) {
  let st;
  try { st = fs.lstatSync(root); } catch { return false; }
  if (st.isSymbolicLink()) return true;
  let cur = root;
  for (const p of parts) {
    cur = path.join(cur, p);
    try { st = fs.lstatSync(cur); } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
    if (st.isSymbolicLink()) return true;
  }
  return false;
}

function resolveRel(id, rel, { allowEmpty = false } = {}) {
  const parts = splitRel(rel);
  if (!parts.length && !allowEmpty) throw new SiteFileError(400, 'invalid path');
  const root = siteDir(id);
  if (hasLinkInPath(root, parts)) throw new SiteFileError(400, 'invalid path');
  return { root, parts, abs: path.join(root, ...parts) };
}

function listFiles(id) {
  const out = [];
  (function walk(dir, rel, depth) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (!validName(e.name)) continue;
      const full = path.join(dir, e.name);
      let ls;
      try { ls = fs.lstatSync(full); } catch { continue; }
      if (ls.isSymbolicLink()) continue; // symlinks and Windows junctions are never listed or followed
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (ls.isDirectory()) {
        out.push({ path: r, type: 'dir' });
        if (depth + 1 < MAX_DEPTH) walk(full, r, depth + 1);
      } else if (ls.isFile() && ALLOWED_EXT.has(extOf(e.name))) {
        out.push({ path: r, type: 'file', size: ls.size, mtimeMs: Math.round(ls.mtimeMs) });
      }
    }
  })(siteDir(id), '', 0);
  return out;
}

function usage(id) {
  const files = listFiles(id).filter((f) => f.type === 'file');
  return { files: files.length, bytes: files.reduce((a, f) => a + f.size, 0) };
}

function readFile(id, rel) {
  const { abs, parts } = resolveRel(id, rel);
  const e = extOf(parts[parts.length - 1]);
  if (!ALLOWED_EXT.has(e)) throw new SiteFileError(400, 'file type not allowed');
  let st;
  try { st = fs.statSync(abs); } catch { throw new SiteFileError(404, 'file not found'); }
  if (!st.isFile()) throw new SiteFileError(404, 'file not found');
  if (st.size > LIMITS.maxFileBytes) throw new SiteFileError(413, 'file too large');
  const mtimeMs = Math.round(st.mtimeMs);
  if (!TEXT_EXT.has(e)) return { binary: true, size: st.size, mtimeMs };
  return { binary: false, content: fs.readFileSync(abs, 'utf8'), size: st.size, mtimeMs };
}

function writeFile(id, rel, buf, { expectMtime, force } = {}) {
  const { abs, parts } = resolveRel(id, rel);
  const name = parts[parts.length - 1];
  if (!ALLOWED_EXT.has(extOf(name))) throw new SiteFileError(400, 'file type not allowed');
  if (!Buffer.isBuffer(buf)) throw new SiteFileError(400, 'invalid body');
  if (buf.length > LIMITS.maxFileBytes) throw new SiteFileError(413, 'file too large');
  let existing = null;
  try { existing = fs.statSync(abs); } catch { /* new file */ }
  if (existing && !existing.isFile()) throw new SiteFileError(400, 'invalid path');
  if (existing && !force && expectMtime != null && Math.round(existing.mtimeMs) !== Math.round(Number(expectMtime))) {
    throw new SiteFileError(409, 'file changed on disk');
  }
  const rel2 = parts.join('/');
  const files = listFiles(id).filter((f) => f.type === 'file');
  if (!existing && files.length >= LIMITS.maxFiles) throw new SiteFileError(413, 'too many files');
  const others = files.filter((f) => f.path !== rel2).reduce((a, f) => a + f.size, 0);
  if (others + buf.length > LIMITS.maxTotalBytes) throw new SiteFileError(413, 'site is full');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = path.join(path.dirname(abs), `.tmp-${crypto.randomBytes(6).toString('hex')}`);
  try {
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, abs);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
  return { path: rel2, mtimeMs: Math.round(fs.statSync(abs).mtimeMs) };
}

function makeDir(id, rel) {
  const { abs } = resolveRel(id, rel);
  fs.mkdirSync(abs, { recursive: true });
}

function renamePath(id, from, to) {
  const src = resolveRel(id, from);
  const dst = resolveRel(id, to);
  let st;
  try { st = fs.statSync(src.abs); } catch { throw new SiteFileError(404, 'not found'); }
  if (fs.existsSync(dst.abs)) throw new SiteFileError(409, 'target exists');
  if (st.isFile() && !ALLOWED_EXT.has(extOf(dst.parts[dst.parts.length - 1]))) throw new SiteFileError(400, 'file type not allowed');
  if (st.isDirectory() && dst.abs.startsWith(src.abs + path.sep)) throw new SiteFileError(400, 'invalid path');
  fs.mkdirSync(path.dirname(dst.abs), { recursive: true });
  fs.renameSync(src.abs, dst.abs);
}

function deletePath(id, rel) {
  const { abs } = resolveRel(id, rel);
  if (!fs.existsSync(abs)) throw new SiteFileError(404, 'not found');
  fs.rmSync(abs, { recursive: true });
}

function removeSiteDir(id) { fs.rmSync(siteDir(id), { recursive: true, force: true }); }

function describe(abs, parts, viaDir) {
  const e = extOf(parts[parts.length - 1] || '');
  return { kind: e === 'php' ? 'php' : 'static', abs, ext: e, rel: parts.join('/'), viaDir };
}

function resolveServeTarget(id, rel) {
  let r;
  try { r = resolveRel(id, rel, { allowEmpty: true }); } catch { return null; }
  let st;
  try { st = fs.statSync(r.abs); } catch { return null; }
  if (st.isDirectory()) {
    for (const idx of ['index.php', 'index.html', 'index.htm']) {
      const p = path.join(r.abs, idx);
      let ls;
      try { ls = fs.lstatSync(p); } catch { continue; }
      if (ls.isFile()) return describe(p, [...r.parts, idx], true);
    }
    return null;
  }
  if (!st.isFile() || !ALLOWED_EXT.has(extOf(r.parts[r.parts.length - 1] || ''))) return null;
  return describe(r.abs, r.parts, false);
}

module.exports = {
  SITES_DIR, ALLOWED_EXT, LIMITS, SiteFileError, siteDir, ensureSiteDir, listFiles, usage,
  readFile, writeFile, makeDir, renamePath, deletePath, removeSiteDir, resolveServeTarget,
};
