'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { fetchEmbed } = require('../lib/linkPreview');

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

module.exports = router;
