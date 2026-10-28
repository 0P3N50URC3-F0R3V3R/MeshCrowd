'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { PERMISSIONS, has } = require('../lib/permissions');
const { getMemberPermissionBits } = require('../lib/channelAccess');
const { logAudit } = require('../lib/auditLog');
const templates = require('../lib/serverTemplates');

const guard = (fn) => (req, res, next) => {
  try { fn(req, res, next); } catch (err) {
    if (err instanceof templates.TemplateError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
};

// /api/servers/:id/templates - managing the templates made from one server
const serverRouter = express.Router({ mergeParams: true });

serverRouter.use(requireAuth, (req, res, next) => {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(Number(req.params.id));
  if (!server || server.kind !== 'chat') return res.status(404).json({ error: 'server not found' });
  if (!db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(server.id, req.user.id)) return res.status(403).json({ error: 'not a member of this server' });
  if (!has(getMemberPermissionBits(server.id, req.user.id), PERMISSIONS.MANAGE_SERVER)) return res.status(403).json({ error: 'missing permission' });
  req.server = server;
  next();
});

serverRouter.get('/', guard((req, res) => res.json({ templates: templates.listTemplates(req.server.id) })));

serverRouter.post('/', guard((req, res) => {
  const t = templates.createTemplate({ serverId: req.server.id, userId: req.user.id, name: req.body?.name, description: req.body?.description });
  logAudit(req.server.id, req.user.id, 'template_create', 'template', t.id, { name: t.name });
  res.status(201).json({ template: t });
}));

serverRouter.post('/:templateId/sync', guard((req, res) => {
  const t = templates.syncTemplate(req.server.id, Number(req.params.templateId));
  logAudit(req.server.id, req.user.id, 'template_sync', 'template', t.id, { name: t.name });
  res.json({ template: t });
}));

serverRouter.delete('/:templateId', guard((req, res) => {
  templates.deleteTemplate(req.server.id, Number(req.params.templateId));
  logAudit(req.server.id, req.user.id, 'template_delete', 'template', Number(req.params.templateId), null);
  res.json({ ok: true });
}));

// /api/templates/:code - what anyone holding a code can do with it
const codeRouter = express.Router();
codeRouter.use(requireAuth);

codeRouter.get('/:code', guard((req, res) => res.json({ template: templates.previewTemplate(req.params.code) })));

codeRouter.post('/:code/use', guard((req, res) => {
  const server = templates.instantiate(req.user, req.params.code, { name: req.body?.name, description: req.body?.description });
  res.status(201).json({ server });
}));

module.exports = { serverRouter, codeRouter };
