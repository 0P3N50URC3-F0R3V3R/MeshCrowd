'use strict';

const express = require('express');
const { listLanguages } = require('../lib/languages');

const router = express.Router();

// No auth required — needed by the pre-login screen's language toggle.
router.get('/', (req, res) => {
  res.json({ languages: listLanguages({ onlyEnabled: true }).map((l) => ({ code: l.code, name: l.name })) });
});

module.exports = router;
