'use strict';

const express = require('express');
const { sealFor } = require('../lib/atRest');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { serializeMessage } = require('../lib/messages');
const { singleLine } = require('../lib/textSanitize');
const { canViewScope, canSendToScope } = require('../lib/scopeAccess');
const { PERMISSIONS, has } = require('../lib/permissions');
const { getChannelPermissionBits } = require('../lib/channelAccess');
const { getMemberTimeout } = require('../lib/moderation');

const router = express.Router();
router.use(requireAuth);

const MAX_ITEMS = 50;
const MAX_TITLE = 300;
const MAX_LABEL = 200;

function cleanItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map((o) => singleLine(o, MAX_LABEL)).filter(Boolean);
}

function canCreateIn(scopeType, ctx, userId) {
  if (scopeType === 'dm') return !ctx.dm.e2ee_enabled;
  if (ctx.channel.type === 'private') return true;
  const bits = getChannelPermissionBits(ctx.channel, userId);
  return has(bits, PERMISSIONS.CREATE_CHECKLISTS) || has(bits, PERMISSIONS.MANAGE_MESSAGES);
}

function insertItems(listId, scopeType, labels, startPos = 0) {
  const ins = db.prepare('INSERT INTO checklist_items (checklist_id, position, label) VALUES (?, ?, ?)');
  labels.forEach((label, i) => ins.run(listId, startPos + i, sealFor(scopeType, label)));
}

function validHelpers(editors, ctx, scopeType, scopeId, creatorId) {
  if (!Array.isArray(editors)) return null;
  const out = new Map();
  for (const e of editors) {
    const userId = Number(e && e.userId);
    if (!Number.isInteger(userId) || userId === creatorId) continue;
    if (!e || !['check', 'edit'].includes(e.level)) return null;
    if (!canViewScope(scopeType, scopeId, userId).ok) return null;
    out.set(userId, e.level);
  }
  return out;
}

function saveHelpers(listId, helpers) {
  db.prepare('DELETE FROM checklist_editors WHERE checklist_id = ?').run(listId);
  for (const [userId, level] of helpers) {
    db.prepare('INSERT INTO checklist_editors (checklist_id, user_id, level) VALUES (?, ?, ?)').run(listId, userId, level);
  }
}

router.post('/', (req, res) => {
  const { scopeType, scopeId, title, items, editors } = req.body || {};
  if (!['channel', 'thread', 'dm'].includes(scopeType)) return res.status(400).json({ error: 'invalid scope' });
  const scopeIdNum = Number(scopeId);
  if (!Number.isInteger(scopeIdNum)) return res.status(400).json({ error: 'invalid scope' });

  const cleanTitle = singleLine(title, MAX_TITLE);
  if (!cleanTitle) return res.status(400).json({ error: 'title required' });
  const labels = cleanItems(items);
  if (labels.length < 1 || labels.length > MAX_ITEMS) return res.status(400).json({ error: `a checklist needs 1-${MAX_ITEMS} items` });

  const access = canSendToScope(scopeType, scopeIdNum, req.user.id);
  if (!access.ok) return res.status(access.status).json({ error: access.error });
  if (!canCreateIn(scopeType, access.ctx, req.user.id)) return res.status(403).json({ error: 'missing permission' });

  let helpers = new Map();
  if (editors !== undefined) {
    helpers = validHelpers(editors, access.ctx, scopeType, scopeIdNum, req.user.id);
    if (!helpers) return res.status(400).json({ error: 'invalid helpers' });
  }

  const messageId = db.prepare('INSERT INTO messages (scope_type, scope_id, author_id, content) VALUES (?, ?, ?, ?)')
    .run(scopeType, scopeIdNum, req.user.id, sealFor(scopeType, cleanTitle)).lastInsertRowid;
  const listId = db.prepare('INSERT INTO checklists (message_id, creator_id) VALUES (?, ?)').run(messageId, req.user.id).lastInsertRowid;
  insertItems(listId, scopeType, labels);
  saveHelpers(listId, helpers);

  const message = serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId));
  access.ctx.broadcast({ type: 'message_create', message });
  res.status(201).json({ message });
});

function loadList(req, res, next) {
  const list = db.prepare('SELECT * FROM checklists WHERE id = ?').get(req.params.id);
  if (!list) return res.status(404).json({ error: 'checklist not found' });
  const message = db.prepare('SELECT * FROM messages WHERE id = ? AND deleted_at IS NULL').get(list.message_id);
  if (!message) return res.status(404).json({ error: 'checklist not found' });
  const access = canViewScope(message.scope_type, message.scope_id, req.user.id);
  if (!access.ok) return res.status(access.status).json({ error: access.error });
  const { ctx } = access;
  if (ctx.thread && ctx.thread.archived) return res.status(403).json({ error: 'this thread is archived' });
  if (ctx.channel) {
    const timeoutUntil = getMemberTimeout(ctx.channel.server_id, req.user.id);
    if (timeoutUntil) return res.status(403).json({ error: 'you are timed out in this server', timeoutUntil });
  }
  let level = null;
  if (list.creator_id === req.user.id) level = 'edit';
  else level = db.prepare('SELECT level FROM checklist_editors WHERE checklist_id = ? AND user_id = ?').get(list.id, req.user.id)?.level || null;
  req.list = list; req.listMessage = message; req.ctx = ctx; req.level = level;
  next();
}

const needCheck = (req, res, next) => (req.level ? next() : res.status(403).json({ error: 'missing permission' }));
const needEdit = (req, res, next) => (req.level === 'edit' ? next() : res.status(403).json({ error: 'missing permission' }));
const needCreator = (req, res, next) => (req.list.creator_id === req.user.id ? next() : res.status(403).json({ error: 'missing permission' }));

function finish(req, res) {
  const message = serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(req.listMessage.id));
  req.ctx.broadcast({ type: 'message_update', message });
  res.json({ message });
}

function loadItem(req, res, next) {
  const item = db.prepare('SELECT * FROM checklist_items WHERE id = ? AND checklist_id = ?').get(req.params.itemId, req.list.id);
  if (!item) return res.status(404).json({ error: 'item not found' });
  req.item = item;
  next();
}

function setChecked(checked) {
  return (req, res) => {
    if (checked) db.prepare('UPDATE checklist_items SET checked = 1, checked_by = ?, checked_at = ? WHERE id = ?').run(req.user.id, new Date().toISOString(), req.item.id);
    else db.prepare('UPDATE checklist_items SET checked = 0, checked_by = NULL, checked_at = NULL WHERE id = ?').run(req.item.id);
    finish(req, res);
  };
}
router.put('/:id/items/:itemId/check', loadList, needCheck, loadItem, setChecked(true));
router.delete('/:id/items/:itemId/check', loadList, needCheck, loadItem, setChecked(false));

router.patch('/:id', loadList, needEdit, (req, res) => {
  const title = singleLine(req.body && req.body.title, MAX_TITLE);
  if (!title) return res.status(400).json({ error: 'title required' });
  db.prepare('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?')
    .run(sealFor(req.listMessage.scope_type, title), new Date().toISOString(), req.listMessage.id);
  finish(req, res);
});

router.post('/:id/items', loadList, needEdit, (req, res) => {
  const labels = cleanItems([req.body && req.body.label]);
  if (!labels.length) return res.status(400).json({ error: 'label required' });
  const count = db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(position), -1) AS p FROM checklist_items WHERE checklist_id = ?').get(req.list.id);
  if (count.n >= MAX_ITEMS) return res.status(400).json({ error: `a checklist needs 1-${MAX_ITEMS} items` });
  insertItems(req.list.id, req.listMessage.scope_type, labels, count.p + 1);
  finish(req, res);
});

router.patch('/:id/items/:itemId', loadList, needEdit, loadItem, (req, res) => {
  const [label] = cleanItems([req.body && req.body.label]);
  if (!label) return res.status(400).json({ error: 'label required' });
  db.prepare('UPDATE checklist_items SET label = ? WHERE id = ?').run(sealFor(req.listMessage.scope_type, label), req.item.id);
  finish(req, res);
});

router.delete('/:id/items/:itemId', loadList, needEdit, loadItem, (req, res) => {
  const n = db.prepare('SELECT COUNT(*) AS n FROM checklist_items WHERE checklist_id = ?').get(req.list.id).n;
  if (n <= 1) return res.status(400).json({ error: `a checklist needs 1-${MAX_ITEMS} items` });
  db.prepare('DELETE FROM checklist_items WHERE id = ?').run(req.item.id);
  finish(req, res);
});

router.put('/:id/order', loadList, needEdit, (req, res) => {
  const ids = Array.isArray(req.body && req.body.itemIds) ? req.body.itemIds.map(Number) : [];
  const existing = db.prepare('SELECT id FROM checklist_items WHERE checklist_id = ?').all(req.list.id).map((r) => r.id);
  if (ids.length !== existing.length || new Set(ids).size !== ids.length || !ids.every((i) => existing.includes(i))) {
    return res.status(400).json({ error: 'invalid order' });
  }
  const upd = db.prepare('UPDATE checklist_items SET position = ? WHERE id = ?');
  ids.forEach((id, pos) => upd.run(pos, id));
  finish(req, res);
});

router.put('/:id/editors', loadList, needCreator, (req, res) => {
  const helpers = validHelpers(req.body && req.body.editors, req.ctx, req.listMessage.scope_type, req.listMessage.scope_id, req.list.creator_id);
  if (!helpers) return res.status(400).json({ error: 'invalid helpers' });
  saveHelpers(req.list.id, helpers);
  finish(req, res);
});

module.exports = router;
