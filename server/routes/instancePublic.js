'use strict';

const express = require('express');
const instanceProfile = require('../lib/instanceProfile');

const router = express.Router();

function serve(pick) {
  return (req, res) => {
    const f = pick();
    if (!f) return res.status(404).end();
    res.set({ 'Content-Type': f.mime, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.sendFile(f.file);
  };
}

router.get('/logo', serve(instanceProfile.logoFile));
router.get('/icon', serve(instanceProfile.iconFile));

module.exports = router;
