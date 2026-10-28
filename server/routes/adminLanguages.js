'use strict';

const express = require('express');
const fs = require('node:fs');
const multer = require('multer');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { SITE_PERMISSIONS, hasSite } = require('../lib/permissions');
const { singleLine } = require('../lib/textSanitize');
const {
  sanitizeCode, validateLanguageJson, diffKeys, readLanguageFile, writeLanguageFile, getLanguage, pathForCode,
} = require('../lib/languages');

const router = express.Router();

function requireSiteAdministrator(req, res, next) {
  if (!hasSite(req.sitePermissions || 0, SITE_PERMISSIONS.SITE_ADMINISTRATOR)) {
    return res.status(403).json({ error: 'missing site permission' });
  }
  next();
}
router.use(requireAuth, requireSiteAdministrator);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype === 'application/json' || file.originalname.toLowerCase().endsWith('.json')),
});

router.get('/', (req, res) => {
  res.json({ languages: db.prepare('SELECT code, name, enabled, builtin FROM languages ORDER BY builtin DESC, name ASC').all() });
});

router.post('/', upload.single('file'), (req, res) => {
  const code = sanitizeCode(req.body.code);
  if (!code) return res.status(400).json({ error: 'code must be 2-8 lowercase letters' });
  const name = singleLine(req.body.name, 40);
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!req.file) return res.status(400).json({ error: 'file is required (a .json file, max 1MB)' });

  let parsed;
  try {
    parsed = JSON.parse(req.file.buffer.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'file is not valid JSON' });
  }

  const validation = validateLanguageJson(parsed);
  if (!validation.ok) return res.status(400).json({ error: `invalid language file: ${validation.reason}` });

  const warnings = [];
  if (code !== 'en') {
    const base = readLanguageFile('en');
    const baseValidation = base && validateLanguageJson(base);
    if (baseValidation?.ok) {
      const { missing, extra } = diffKeys(validation.keys, baseValidation.keys);
      if (missing.length) warnings.push(`missing ${missing.length} key(s): ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ', …' : ''}`);
      if (extra.length) warnings.push(`${extra.length} extra key(s) not in English: ${extra.slice(0, 20).join(', ')}${extra.length > 20 ? ', …' : ''}`);
    }
  }

  writeLanguageFile(code, parsed);
  const existing = getLanguage(code);
  if (existing) {
    db.prepare('UPDATE languages SET name = ?, enabled = 1 WHERE code = ?').run(name, code);
  } else {
    db.prepare('INSERT INTO languages (code, name, enabled, builtin) VALUES (?, ?, 1, 0)').run(code, name);
  }
  res.json({ ok: true, code, warnings });
});

router.patch('/:code', (req, res) => {
  const code = sanitizeCode(req.params.code);
  if (!code) return res.status(400).json({ error: 'invalid language code' });
  if (code === 'en') return res.status(400).json({ error: 'the English fallback language cannot be disabled' });
  if (!getLanguage(code)) return res.status(404).json({ error: 'language not found' });
  db.prepare('UPDATE languages SET enabled = ? WHERE code = ?').run(req.body?.enabled ? 1 : 0, code);
  res.json({ ok: true });
});

router.delete('/:code', (req, res) => {
  const code = sanitizeCode(req.params.code);
  if (!code) return res.status(400).json({ error: 'invalid language code' });
  const lang = getLanguage(code);
  if (!lang) return res.status(404).json({ error: 'language not found' });
  if (lang.builtin) return res.status(400).json({ error: 'built-in languages cannot be deleted' });
  db.prepare('DELETE FROM languages WHERE code = ?').run(code);
  const filePath = pathForCode(code);
  if (filePath) { try { fs.unlinkSync(filePath); } catch { /* already gone */ } }
  res.json({ ok: true });
});

module.exports = router;
