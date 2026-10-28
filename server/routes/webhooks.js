'use strict';

const express = require('express');
const { db, WEBHOOK_SYSTEM_USER_ID } = require('../db');
const { serializeMessage } = require('../lib/messages');
const { broadcastToChannel } = require('../socket/hub');
const { maxMessageChars } = require('../lib/messageLimits');

const router = express.Router();

// No requireAuth here on purpose — this is the one route in the app an external service (a CI
// job, GitHub, a script) posts to directly, authenticated only by the token in the URL itself
// (see lib/webhooks.js). Rate-limited at the app level (server/index.js), same IP-keyed limiter
// every other unauthenticated-ish endpoint uses.
router.post('/:webhookId/:token', (req, res) => {
  const webhook = db.prepare('SELECT * FROM webhooks WHERE id = ? AND token = ?').get(Number(req.params.webhookId), req.params.token);
  if (!webhook) return res.status(404).json({ error: 'unknown webhook' });

  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(webhook.channel_id);
  if (!channel || channel.type === 'voice' || channel.type === 'notes') return res.status(404).json({ error: 'this webhook\'s channel no longer accepts messages' });

  const content = String(req.body?.content || '').trim().slice(0, maxMessageChars());
  if (!content) return res.status(400).json({ error: 'content is required' });

  const info = db.prepare(
    'INSERT INTO messages (scope_type, scope_id, author_id, content, webhook_id) VALUES (?, ?, ?, ?, ?)'
  ).run('channel', channel.id, WEBHOOK_SYSTEM_USER_ID, content, webhook.id);

  const message = serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid));
  broadcastToChannel(channel, { type: 'message_create', message });
  res.status(201).json({ message });
});

module.exports = router;
