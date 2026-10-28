'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const scheduled = require('../lib/scheduledMessages');

const router = express.Router();

const guard = (fn) => (req, res, next) => {
  try { fn(req, res, next); } catch (err) {
    if (err instanceof scheduled.ScheduleError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
};

router.use(requireAuth);

router.get('/', (req, res) => res.json({ scheduled: scheduled.list(req.user.id) }));

router.post('/', guard((req, res) => {
  const b = req.body || {};
  res.status(201).json({ scheduled: scheduled.create(req.user, { scopeType: b.scopeType, scopeId: Number(b.scopeId), content: b.content, sendAt: b.sendAt, replyToMessageId: b.replyToMessageId }) });
}));

router.patch('/:id', guard((req, res) => {
  res.json({ scheduled: scheduled.update(req.user, Number(req.params.id), { content: req.body?.content, sendAt: req.body?.sendAt }) });
}));

router.delete('/:id', guard((req, res) => {
  scheduled.cancel(req.user.id, Number(req.params.id));
  res.json({ ok: true });
}));

module.exports = router;
