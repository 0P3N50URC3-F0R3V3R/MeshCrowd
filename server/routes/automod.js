'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { PERMISSIONS, has } = require('../lib/permissions');
const { getMemberPermissionBits } = require('../lib/channelAccess');
const { logAudit } = require('../lib/auditLog');
const automod = require('../lib/automod');

const router = express.Router({ mergeParams: true });

function loadServer(req, res, next) {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(Number(req.params.id));
  if (!server || server.kind !== 'chat') return res.status(404).json({ error: 'server not found' });
  const member = db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(server.id, req.user.id);
  if (!member) return res.status(403).json({ error: 'not a member of this server' });
  if (!has(getMemberPermissionBits(server.id, req.user.id), PERMISSIONS.MANAGE_SERVER)) return res.status(403).json({ error: 'missing permission' });
  req.server = server;
  next();
}

const guard = (fn) => (req, res, next) => {
  try { fn(req, res, next); } catch (err) {
    if (err instanceof automod.AutomodError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
};

router.use(requireAuth, loadServer);

router.get('/', guard((req, res) => {
  res.json({ rules: automod.listRules(req.server.id), log: automod.listLog(req.server.id, { limit: 50 }) });
}));

router.get('/log', guard((req, res) => {
  res.json({ log: automod.listLog(req.server.id, { before: req.query.before, limit: req.query.limit }) });
}));

router.post('/rules', guard((req, res) => {
  const rule = automod.createRule(req.server.id, req.body);
  logAudit(req.server.id, req.user.id, 'automod_rule_create', 'automod_rule', rule.id, { name: rule.name, kind: rule.kind });
  res.status(201).json({ rule });
}));

router.patch('/rules/:ruleId', guard((req, res) => {
  const rule = automod.updateRule(req.server.id, Number(req.params.ruleId), req.body);
  logAudit(req.server.id, req.user.id, 'automod_rule_update', 'automod_rule', rule.id, { name: rule.name, enabled: rule.enabled });
  res.json({ rule });
}));

router.delete('/rules/:ruleId', guard((req, res) => {
  const existing = db.prepare('SELECT name FROM automod_rules WHERE id = ? AND server_id = ?').get(Number(req.params.ruleId), req.server.id);
  automod.deleteRule(req.server.id, Number(req.params.ruleId));
  logAudit(req.server.id, req.user.id, 'automod_rule_delete', 'automod_rule', Number(req.params.ruleId), { name: existing?.name });
  res.json({ ok: true });
}));

module.exports = router;
