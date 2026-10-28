'use strict';

const express = require('express');
const captcha = require('../lib/security/captcha');
const guard = require('../lib/security/guard');
const settings = require('../lib/security/settings');

const router = express.Router();

// Tells the sign-in screen whether to show a captcha right now, and whether to include the
// honeypot field. Reveals nothing about thresholds or other settings.
router.get('/status', (req, res) => {
  const kind = req.query.kind === 'register' ? 'register' : 'login';
  res.set('Cache-Control', 'no-store');
  res.json({ required: guard.captchaRequired(guard.clientIp(req), kind), honeypot: settings.load().protection.honeypot });
});

router.post('/', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { id, image, expiresInSeconds } = captcha.generate();
  res.json({ id, image, expiresInSeconds });
});

module.exports = router;
