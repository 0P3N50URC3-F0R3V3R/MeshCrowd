'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const push = require('../lib/pushEndpoints');

const router = express.Router();

const guard = (fn) => (req, res, next) => {
  try { fn(req, res, next); } catch (err) {
    if (err instanceof push.PushError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
};

router.use(requireAuth);

router.get('/', (req, res) => res.json({ endpoints: push.list(req.user.id) }));

router.put('/endpoint', guard((req, res) => {
  res.json({ endpoint: push.register(req.user.id, req.body?.endpoint, req.body?.label) });
}));

router.delete('/endpoint', guard((req, res) => {
  res.json({ ok: true, removed: push.remove(req.user.id, req.body?.endpoint) });
}));

module.exports = router;
