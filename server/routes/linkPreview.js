'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { fetchEmbed, fetchImage } = require('../lib/linkPreview');

const router = express.Router();

// Used by encrypted DMs, where the server never sees the message: the sender's client asks for the
// preview and seals the result inside its own ciphertext. Same fetch path and SSRF guard as server-side previews.
router.post('/', requireAuth, async (req, res) => {
  const url = req.body?.url;
  if (typeof url !== 'string' || url.length > 2048 || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'a valid http(s) url is required' });
  }
  let embed = null;
  try { embed = await fetchEmbed(url); } catch { embed = null; }
  res.json({ embed });
});

router.get('/image', requireAuth, rateLimit({ windowMs: 60_000, max: 120 }), async (req, res) => {
  const url = req.query.url;
  if (typeof url !== 'string' || url.length > 2048 || !/^https?:\/\//i.test(url)) return res.status(400).end();
  let img = null;
  try { img = await fetchImage(url); } catch { img = null; }
  if (!img) return res.status(404).end();
  res.set({
    'Content-Type': img.type,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cache-Control': 'private, max-age=86400',
  });
  res.send(img.body);
});

module.exports = router;
