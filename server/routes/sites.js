'use strict';

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db } = require('../db');
const hub = require('../socket/hub');
const { requireAuth } = require('../middleware/auth');
const { hasSite, SITE_PERMISSIONS, DEFAULT_EVERYONE_PERMISSIONS } = require('../lib/permissions');
const { singleLine } = require('../lib/textSanitize');
const { logAudit } = require('../lib/auditLog');
const siteFiles = require('../lib/siteFiles');
const siteProcesses = require('../lib/siteProcesses');
const phpRuntime = require('../lib/phpRuntime');
const { normalizeOrigins } = require('../lib/siteCsp');

const router = express.Router();
router.use(requireAuth);

const STARTER_INDEX = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Welcome</title></head>
<body>
  <h1>Welcome</h1>
  <p>Edit this page with the Edit button.</p>
  <p>Server time: <?= date('Y-m-d H:i') ?></p>
</body>
</html>
`;

const isStaff = (req) => hasSite(req.sitePermissions || 0, SITE_PERMISSIONS.MANAGE_ANY_SERVER);
const memberIds = (serverId) => db.prepare('SELECT user_id FROM server_members WHERE server_id = ?').all(serverId).map((r) => r.user_id);
const getRow = (id) => db.prepare('SELECT * FROM servers WHERE id = ?').get(id);

function loadSite(req, res, next) {
  const site = db.prepare("SELECT * FROM servers WHERE id = ? AND kind = 'site'").get(Number(req.params.id));
  if (!site) return res.status(404).json({ error: 'site not found' });
  const member = db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(site.id, req.user.id);
  if (!member) return res.status(403).json({ error: 'not a member of this site' });
  req.site = site;
  req.canEdit = site.owner_id === req.user.id || isStaff(req);
  next();
}

const requireEditor = (req, res, next) => (req.canEdit ? next() : res.status(403).json({ error: 'not allowed to edit this site' }));

function guard(fn) {
  return (req, res) => {
    try { fn(req, res); } catch (err) {
      if (err instanceof siteFiles.SiteFileError) return res.status(err.status).json({ error: err.message });
      throw err;
    }
  };
}

router.get('/runtime', (req, res) => {
  if (!isStaff(req)) return res.status(403).json({ error: 'site admin required' });
  res.json(phpRuntime.getStatus());
});

router.post('/', (req, res) => {
  if (!isStaff(req)) return res.status(403).json({ error: 'site admin required' });
  const { name, description } = req.body || {};
  const cleanName = typeof name === 'string' ? singleLine(name, 100) : '';
  if (!cleanName) return res.status(400).json({ error: 'site name required' });

  const info = db.prepare(
    "INSERT INTO servers (name, description, owner_id, invite_code, visibility, auto_join, kind) VALUES (?, ?, ?, ?, 'public', 1, 'site')"
  ).run(cleanName, String(description || '').slice(0, 500), req.user.id, crypto.randomBytes(6).toString('hex'));
  const id = Number(info.lastInsertRowid);
  db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 0, 1)').run(id, '@everyone', DEFAULT_EVERYONE_PERMISSIONS);
  const users = db.prepare("SELECT id FROM users WHERE is_disabled = 0 AND username != '__webhook__' AND is_bot = 0").all();
  const addMember = db.prepare('INSERT OR IGNORE INTO server_members (server_id, user_id) VALUES (?, ?)');
  for (const u of users) addMember.run(id, u.id);
  addMember.run(id, req.user.id);

  siteFiles.ensureSiteDir(id);
  fs.writeFileSync(path.join(siteFiles.siteDir(id), 'index.php'), STARTER_INDEX);
  logAudit(id, req.user.id, 'site_create', 'server', id, null);
  const server = getRow(id);
  hub.notifyUserIds(memberIds(id), { type: 'server_update', server });
  res.status(201).json({ server });
});

router.get('/:id', loadSite, (req, res) => {
  res.json({ server: req.site, canEdit: req.canEdit, origins: JSON.parse(req.site.site_csp_origins || '[]') });
});

router.patch('/:id', loadSite, requireEditor, (req, res) => {
  const { name, description, origins } = req.body || {};
  if (name !== undefined) {
    const clean = typeof name === 'string' ? singleLine(name, 100) : '';
    if (!clean) return res.status(400).json({ error: 'site name required' });
    db.prepare('UPDATE servers SET name = ? WHERE id = ?').run(clean, req.site.id);
  }
  if (description !== undefined) db.prepare('UPDATE servers SET description = ? WHERE id = ?').run(String(description).slice(0, 500), req.site.id);
  if (origins !== undefined) {
    const r = normalizeOrigins(origins);
    if (!r.ok) return res.status(400).json({ error: r.error });
    db.prepare('UPDATE servers SET site_csp_origins = ? WHERE id = ?').run(JSON.stringify(r.origins), req.site.id);
    logAudit(req.site.id, req.user.id, 'site_origins_change', 'server', req.site.id, { origins: r.origins });
  }
  const server = getRow(req.site.id);
  hub.notifyUserIds(memberIds(req.site.id), { type: 'server_update', server });
  res.json({ server });
});

router.delete('/:id', loadSite, (req, res) => {
  if (req.site.owner_id !== req.user.id && !isStaff(req)) return res.status(403).json({ error: 'not allowed to delete this site' });
  const ids = memberIds(req.site.id);
  siteProcesses.stop(req.site.id);
  db.prepare('DELETE FROM servers WHERE id = ?').run(req.site.id);
  siteFiles.removeSiteDir(req.site.id);
  hub.notifyUserIds(ids, { type: 'server_delete', serverId: req.site.id });
  res.json({ ok: true });
});

router.get('/:id/files', loadSite, requireEditor, (req, res) => {
  res.json({ files: siteFiles.listFiles(req.site.id), usage: siteFiles.usage(req.site.id), limits: siteFiles.LIMITS });
});

router.get('/:id/files/content', loadSite, requireEditor, guard((req, res) => {
  res.json(siteFiles.readFile(req.site.id, String(req.query.path || '')));
}));

router.put('/:id/files/content', loadSite, requireEditor,
  express.raw({ type: 'application/octet-stream', limit: siteFiles.LIMITS.maxFileBytes }),
  guard((req, res) => {
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const out = siteFiles.writeFile(req.site.id, String(req.query.path || ''), buf, {
      expectMtime: req.query.mtime !== undefined ? Number(req.query.mtime) : undefined,
      force: req.query.force === '1',
    });
    siteProcesses.resetCrashes(req.site.id);
    logAudit(req.site.id, req.user.id, 'site_file_write', 'file', null, { path: out.path, bytes: buf.length });
    res.json(out);
  }));

router.post('/:id/files/mkdir', loadSite, requireEditor, guard((req, res) => {
  siteFiles.makeDir(req.site.id, String(req.body?.path || ''));
  res.json({ ok: true });
}));

router.post('/:id/files/rename', loadSite, requireEditor, guard((req, res) => {
  siteFiles.renamePath(req.site.id, String(req.body?.from || ''), String(req.body?.to || ''));
  siteProcesses.resetCrashes(req.site.id);
  res.json({ ok: true });
}));

router.delete('/:id/files', loadSite, requireEditor, guard((req, res) => {
  const p = String(req.query.path || '');
  siteFiles.deletePath(req.site.id, p);
  logAudit(req.site.id, req.user.id, 'site_file_delete', 'file', null, { path: p });
  res.json({ ok: true });
}));

module.exports = router;
