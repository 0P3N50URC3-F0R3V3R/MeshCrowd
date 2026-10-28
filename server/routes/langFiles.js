'use strict';

const express = require('express');
const { getLanguage, readLanguageFile } = require('../lib/languages');

const router = express.Router();

// Serves an installed language's translation JSON. Looked up against the `languages` table
// (never the filesystem directly) so a crafted code can't be used to read arbitrary files.
router.get('/:code.json', (req, res) => {
  const lang = getLanguage(req.params.code);
  if (!lang) return res.status(404).json({ error: 'language not found' });
  const data = readLanguageFile(lang.code);
  if (!data) return res.status(404).json({ error: 'language file missing' });
  res.json(data);
});

module.exports = router;
