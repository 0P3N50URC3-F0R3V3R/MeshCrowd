'use strict';

const express = require('express');
const { db } = require('../db');
const settings = require('../lib/security/settings');
const guard = require('../lib/security/guard');
const captcha = require('../lib/security/captcha');
const blocklists = require('../lib/security/blocklists');
const { parseEntry, entryCovers, normalizeIp } = require('../lib/security/ipMatch');

// Mounted by routes/admin.js behind the site-administrator check.
const router = express.Router();

const publicSettings = () => settings.load();
const fail = (res, err) => res.status(400).json({ error: err.message });
const myIp = (req) => guard.clientIp(req);

router.get('/overview', (req, res) => {
  res.json({
    ...guard.overview(),
    yourIp: myIp(req),
    recentEvents: eventRows({ limit: 12 }),
  });
});

router.get('/settings', (req, res) => res.json(publicSettings()));

router.patch('/settings', (req, res) => {
  let next;
  try { next = settings.update(req.body || {}); } catch (err) { return fail(res, err); }
  guard.rebuild();
  guard.event('settings_changed', myIp(req), { by: req.user.id, sections: Object.keys(req.body || {}) });
  res.json(next);
});

// Renders a challenge from unsaved settings and shows the answer, so an admin can tune the look.
router.post('/captcha/preview', (req, res) => {
  let cfg;
  try { cfg = settings.mergeCaptcha(settings.load().captcha, (req.body && req.body.captcha) || {}); } catch (err) { return fail(res, err); }
  const sample = captcha.generate(cfg);
  res.json({ image: sample.image, answer: sample.answer });
});

router.post('/words/check', (req, res) => {
  const { words, rejected } = settings.cleanWordList((req.body && req.body.text) || '');
  res.json({ count: words.length, rejected, max: settings.MAX_CUSTOM_WORDS, words });
});

router.post('/under-attack', (req, res) => {
  const on = !!(req.body && req.body.enabled);
  const minutes = on ? (req.body.minutes === undefined ? 60 : Number(req.body.minutes)) : 0;
  if (on && (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440)) return res.status(400).json({ error: 'minutes must be 1-1440' });
  guard.setUnderAttack(minutes, `admin:${req.user.id}`);
  res.json(guard.underAttackInfo());
});

// ---- bans ----

function banRows(source, q) {
  const now = new Date().toISOString();
  const rows = db.prepare(
    `SELECT b.id, b.entry, b.reason, b.source, b.created_at, b.expires_at, u.username AS created_by
       FROM ip_bans b LEFT JOIN users u ON u.id = b.created_by
      WHERE (b.expires_at IS NULL OR b.expires_at > ?) ${source ? 'AND b.source = ?' : ''}
      ORDER BY b.id DESC LIMIT 1000`
  ).all(...(source ? [now, source] : [now]));
  const needle = String(q || '').trim().toLowerCase();
  return needle ? rows.filter((r) => r.entry.includes(needle) || r.reason.toLowerCase().includes(needle)) : rows;
}

router.get('/bans', (req, res) => {
  const source = ['manual', 'auto'].includes(req.query.source) ? req.query.source : null;
  res.json({ bans: banRows(source, req.query.q) });
});

function createBan(req, entry, reason, minutes) {
  const parsed = parseEntry(entry);
  if (!parsed) throw new Error(`"${String(entry).slice(0, 60)}" is not an IP address, range or CIDR`);
  if (entryCovers(parsed, myIp(req))) throw new Error('that would ban your own address');
  if (minutes !== null && (!Number.isInteger(minutes) || minutes < 1 || minutes > 5_256_000)) throw new Error('duration must be a whole number of minutes');
  return guard.addBan(parsed.entry, { reason, source: 'manual', minutes, userId: req.user.id });
}

router.post('/bans', (req, res) => {
  const b = req.body || {};
  const minutes = b.durationMinutes === undefined || b.durationMinutes === null || b.durationMinutes === '' ? null : Number(b.durationMinutes);
  let ban;
  try { ban = createBan(req, b.entry, b.reason || '', minutes); } catch (err) { return fail(res, err); }
  guard.event('ban_manual', ban.entry, { by: req.user.id, reason: ban.reason, minutes });
  res.status(201).json({ ban });
});

// Many entries at once: one per line (or comma separated). Invalid lines are reported, not fatal.
router.post('/bans/import', (req, res) => {
  const lines = String((req.body && req.body.text) || '').split(/[\r\n,]+/).map((l) => l.replace(/\s*(#|;).*$/, '').trim()).filter(Boolean);
  if (lines.length > 5000) return res.status(400).json({ error: 'at most 5000 entries at a time' });
  const added = []; const invalid = [];
  for (const line of lines) {
    try { added.push(createBan(req, line, (req.body && req.body.reason) || 'imported', null).entry); } catch { invalid.push(line.slice(0, 60)); }
  }
  if (added.length) guard.event('ban_import', myIp(req), { by: req.user.id, count: added.length });
  res.json({ added: added.length, invalid });
});

router.delete('/bans/:id', (req, res) => {
  const row = db.prepare('SELECT entry FROM ip_bans WHERE id = ?').get(req.params.id);
  if (!row || !guard.removeBan(Number(req.params.id))) return res.status(404).json({ error: 'no such ban' });
  guard.event('unban', row.entry, { by: req.user.id });
  res.json({ ok: true });
});

router.delete('/bans', (req, res) => {
  const source = req.query.source;
  if (!['auto', 'manual'].includes(source)) return res.status(400).json({ error: 'source must be auto or manual' });
  const info = db.prepare('DELETE FROM ip_bans WHERE source = ?').run(source);
  guard.rebuild();
  guard.event('bans_cleared', myIp(req), { by: req.user.id, source, count: Number(info.changes) });
  res.json({ removed: Number(info.changes) });
});

// ---- blocklists ----

router.get('/blocklists', (req, res) => res.json({ lists: blocklists.listAll(), presets: blocklists.PRESETS }));

router.post('/blocklists', async (req, res) => {
  let id;
  try { id = blocklists.addList(req.body || {}); } catch (err) { return fail(res, err); }
  let refresh = null; let refreshError = null;
  try { refresh = await blocklists.refreshList(id); } catch (err) { refreshError = err.message; }
  res.status(201).json({ id, refresh, refreshError, lists: blocklists.listAll() });
});

router.patch('/blocklists/:id', (req, res) => {
  const row = db.prepare('SELECT id FROM ip_blocklists WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'no such list' });
  const b = req.body || {};
  if (b.enabled !== undefined) db.prepare('UPDATE ip_blocklists SET enabled = ? WHERE id = ?').run(b.enabled ? 1 : 0, row.id);
  if (b.refreshHours !== undefined) {
    const h = Number(b.refreshHours);
    if (!Number.isInteger(h) || h < 1 || h > 720) return res.status(400).json({ error: 'refreshHours must be 1-720' });
    db.prepare('UPDATE ip_blocklists SET refresh_hours = ? WHERE id = ?').run(h, row.id);
  }
  guard.rebuild();
  res.json({ lists: blocklists.listAll() });
});

router.post('/blocklists/:id/refresh', async (req, res) => {
  try { res.json({ ...(await blocklists.refreshList(Number(req.params.id))), lists: blocklists.listAll() }); } catch (err) { fail(res, err); }
});

router.delete('/blocklists/:id', (req, res) => {
  const info = db.prepare('DELETE FROM ip_blocklists WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'no such list' });
  guard.rebuild();
  res.json({ lists: blocklists.listAll() });
});

// ---- lookup and events ----

router.get('/lookup', (req, res) => {
  const ip = normalizeIp(String(req.query.ip || ''));
  if (!ip) return res.status(400).json({ error: 'enter a valid IP address' });
  res.json(guard.lookup(ip));
});

function eventRows({ type, limit = 100, before }) {
  const rows = db.prepare(
    `SELECT id, ts, type, ip, detail FROM security_events
      WHERE (? IS NULL OR type = ?) AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?`
  ).all(type || null, type || null, before || null, before || null, Math.min(Math.max(Number(limit) || 100, 1), 500));
  return rows.map((e) => ({ ...e, detail: e.detail ? JSON.parse(e.detail) : null }));
}

router.get('/events', (req, res) => {
  const types = db.prepare('SELECT DISTINCT type FROM security_events ORDER BY type').all().map((r) => r.type);
  res.json({ events: eventRows({ type: req.query.type, limit: req.query.limit, before: Number(req.query.before) || null }), types });
});

router.delete('/events', (req, res) => {
  const info = db.prepare('DELETE FROM security_events').run();
  res.json({ removed: Number(info.changes) });
});

module.exports = router;
