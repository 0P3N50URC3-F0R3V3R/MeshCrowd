'use strict';

const express = require('express');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');
const splitAuth = require('../lib/splitAuth');
const accounts = require('../lib/accounts');
const pendingLogin = require('../lib/pendingLogin');
const { authAudit } = require('../lib/authAudit');
const { db, DATA_DIR } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { SITE_PERMISSIONS, hasSite } = require('../lib/permissions');
const { getSitePermissionBits } = require('../lib/siteAuth');
const { destroyAllSessionsForUser } = require('../lib/session');
const { toPublicUser } = require('../lib/publicUser');
const siteSettings = require('../lib/siteSettings');
const hub = require('../socket/hub');
const { singleLine } = require('../lib/textSanitize');
const { uploadSticker, createSticker, deleteSticker } = require('../lib/stickers');
const { uploadSound, createSound, deleteSound } = require('../lib/sounds');
const prune = require('../lib/prune');
const { logAudit } = require('../lib/auditLog');
const turnManager = require('../lib/turn/manager');
const registration = require('../lib/registration');
const appConfig = require('../lib/config');

const router = express.Router();

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Pushes the edited user's own fresh profile straight to their live connections, same mechanism
// as the self-presence sync on WS connect — otherwise an admin-edited name/avatar/email only
// shows up for that user after their next reload.
function syncTargetUser(userId) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return;
  hub.notifyUser(userId, { type: 'presence', user: toPublicUser(user, { viewerIsSelf: true }) });
  hub.broadcastPresence(userId);
}

const AVATAR_ALLOWED = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const uploadUserAvatar = multer({
  storage: multer.diskStorage({
    destination: path.join(DATA_DIR, 'avatars'),
    filename: (req, file, cb) => {
      const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' }[file.mimetype] || '';
      cb(null, `${req.params.id}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, AVATAR_ALLOWED.has(file.mimetype)),
});

function requireSitePerm(flag) {
  return (req, res, next) => {
    if (!hasSite(req.sitePermissions || 0, flag)) return res.status(403).json({ error: 'missing site permission' });
    next();
  };
}

// A staffer can never grant/hold-via-role permission bits they don't already have themselves
// (unless they're a full SITE_ADMINISTRATOR) — otherwise MANAGE_SITE_ROLES alone is a path to
// full instance takeover.
function assertCanGrant(req, permissionBits) {
  const mine = req.sitePermissions || 0;
  if (hasSite(mine, SITE_PERMISSIONS.SITE_ADMINISTRATOR)) return true;
  return (permissionBits & ~mine) === 0;
}

function adminUserShape(u) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    email: u.email,
    avatarPath: u.avatar_path || null,
    isDisabled: !!u.is_disabled,
    authMode: u.auth_mode || 'password',
    createdAt: u.created_at,
    siteRoleIds: db.prepare('SELECT role_id FROM user_site_roles WHERE user_id = ?').all(u.id).map((r) => r.role_id),
  };
}

router.use(requireAuth, requireSitePerm(SITE_PERMISSIONS.VIEW_ADMIN_PANEL));
router.use('/security', requireSitePerm(SITE_PERMISSIONS.SITE_ADMINISTRATOR), require('./adminSecurity'));

router.get('/settings', (req, res) => {
  res.json({
    sessionTtlDays: siteSettings.getSessionTtlDays(),
    maxUploadMb: siteSettings.getMaxUploadMb(),
    allowedAttachmentExtensions: siteSettings.getAllowedExtensions() || [],
    registrationMode: registration.getMode(),
  });
});

router.patch('/settings', requireSitePerm(SITE_PERMISSIONS.SITE_ADMINISTRATOR), (req, res) => {
  if (req.body?.sessionTtlDays !== undefined) {
    const days = Number(req.body.sessionTtlDays);
    if (!Number.isFinite(days)) return res.status(400).json({ error: 'sessionTtlDays must be a number' });
    siteSettings.set('session_ttl_days', Math.trunc(days));
  }
  if (req.body?.maxUploadMb !== undefined) {
    const mb = Number(req.body.maxUploadMb);
    if (!Number.isFinite(mb) || mb <= 0) return res.status(400).json({ error: 'maxUploadMb must be a positive number' });
    siteSettings.setMaxUploadMb(mb);
  }
  if (req.body?.allowedAttachmentExtensions !== undefined) {
    const list = req.body.allowedAttachmentExtensions;
    if (!Array.isArray(list) || !list.every((s) => typeof s === 'string')) {
      return res.status(400).json({ error: 'allowedAttachmentExtensions must be an array of strings' });
    }
    siteSettings.setAllowedExtensions(list.map((s) => s.trim().toLowerCase()).filter(Boolean));
  }
  res.json({
    sessionTtlDays: siteSettings.getSessionTtlDays(),
    maxUploadMb: siteSettings.getMaxUploadMb(),
    allowedAttachmentExtensions: siteSettings.getAllowedExtensions() || [],
    registrationMode: registration.getMode(),
  });
});

// ---- Registration mode (config.json: registrationMode) ----
router.get('/registration', (req, res) => res.json({ mode: registration.getMode() }));

router.patch('/registration', requireSitePerm(SITE_PERMISSIONS.SITE_ADMINISTRATOR), (req, res) => {
  const mode = req.body?.mode;
  if (!registration.MODES.includes(mode)) return res.status(400).json({ error: 'mode must be open, closed or invite' });
  appConfig.save({ registrationMode: mode });
  require('../lib/logger').log(`[registration] mode set to ${mode} by user ${req.user.id}`);
  res.json({ mode: registration.getMode() });
});

// ---- Calls: built-in STUN/TURN server and external ICE servers ----
const ICE_URL_RE = /^(stun|stuns|turn|turns):[^\s]+$/i;

function callsPayload() {
  const cfg = appConfig.load();
  const { secret, ...turn } = cfg.turn;
  return { turn: { ...turn, secretSet: !!secret }, iceServers: cfg.iceServers || [], publicHost: cfg.publicHost, status: turnManager.status() };
}

const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

function validateTurnPatch(p) {
  const bool = (k) => p[k] === undefined || typeof p[k] === 'boolean';
  if (!['enabled', 'tcp', 'allowPrivatePeers'].every(bool)) return 'enabled, tcp and allowPrivatePeers must be booleans';
  if (p.port !== undefined && !intIn(p.port, 1, 65535)) return 'port must be 1-65535';
  for (const k of ['relayPortMin', 'relayPortMax']) if (p[k] !== undefined && !intIn(p[k], 1024, 65535)) return `${k} must be 1024-65535`;
  if (p.maxAllocations !== undefined && !intIn(p.maxAllocations, 1, 100000)) return 'maxAllocations must be 1-100000';
  if (p.maxAllocationsPerUser !== undefined && !intIn(p.maxAllocationsPerUser, 1, 1000)) return 'maxAllocationsPerUser must be 1-1000';
  if (p.maxKbps !== undefined && !intIn(p.maxKbps, 0, 10_000_000)) return 'maxKbps must be 0-10000000';
  if (p.credentialTtlSeconds !== undefined && !intIn(p.credentialTtlSeconds, 300, 604800)) return 'credentialTtlSeconds must be 300-604800';
  if (p.externalIp !== undefined && p.externalIp !== '' && !turnManager.isIpv4(String(p.externalIp))) return 'externalIp must be an IPv4 address or empty';
  if (p.listenAddress !== undefined && !turnManager.isIpv4(String(p.listenAddress))) return 'listenAddress must be an IPv4 address';
  if (p.advertisedHost !== undefined && (typeof p.advertisedHost !== 'string' || p.advertisedHost.length > 253 || /[\s/?#]/.test(p.advertisedHost))) return 'advertisedHost must be a host name or address';
  if (p.realm !== undefined && !/^[A-Za-z0-9.-]{1,64}$/.test(String(p.realm))) return 'realm must be 1-64 letters, digits, dots or dashes';
  return null;
}

function validateIceServers(list) {
  if (!Array.isArray(list) || list.length > 10) return 'iceServers must be a list of at most 10 entries';
  for (const s of list) {
    if (!s || typeof s !== 'object') return 'each ICE server must be an object';
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
    if (!urls.length || urls.length > 6 || !urls.every((u) => typeof u === 'string' && u.length < 300 && ICE_URL_RE.test(u))) return 'urls must be stun:, stuns:, turn: or turns: addresses';
    for (const k of ['username', 'credential']) if (s[k] !== undefined && (typeof s[k] !== 'string' || s[k].length > 300)) return `${k} must be a string`;
  }
  return null;
}

router.get('/calls', requireSitePerm(SITE_PERMISSIONS.SITE_ADMINISTRATOR), (req, res) => res.json(callsPayload()));

router.patch('/calls', requireSitePerm(SITE_PERMISSIONS.SITE_ADMINISTRATOR), async (req, res) => {
  const body = req.body || {};
  const patch = {};
  if (body.turn !== undefined) {
    if (!body.turn || typeof body.turn !== 'object') return res.status(400).json({ error: 'turn must be an object' });
    const allowed = ['enabled', 'port', 'listenAddress', 'tcp', 'externalIp', 'advertisedHost', 'relayPortMin', 'relayPortMax', 'realm', 'credentialTtlSeconds', 'allowPrivatePeers', 'maxAllocations', 'maxAllocationsPerUser', 'maxKbps'];
    const turn = Object.fromEntries(Object.entries(body.turn).filter(([k]) => allowed.includes(k)));
    const err = validateTurnPatch(turn);
    if (err) return res.status(400).json({ error: err });
    const cur = appConfig.load().turn;
    const lo = turn.relayPortMin ?? cur.relayPortMin;
    const hi = turn.relayPortMax ?? cur.relayPortMax;
    if (hi - lo < 9) return res.status(400).json({ error: 'the relay port range must hold at least 10 ports' });
    if (body.turn.rotateSecret === true) turn.secret = require('../lib/turn/credentials').newSecret();
    patch.turn = turn;
  }
  if (body.iceServers !== undefined) {
    const err = validateIceServers(body.iceServers);
    if (err) return res.status(400).json({ error: err });
    patch.iceServers = body.iceServers.map((s) => ({ urls: s.urls, ...(s.username ? { username: s.username } : {}), ...(s.credential ? { credential: s.credential } : {}) }));
  }
  if (Object.keys(patch).length) {
    appConfig.save(patch);
    require('../lib/logger').log(`[calls] settings updated by user ${req.user.id}:`, patch.turn ? Object.keys(patch.turn).filter((k) => k !== 'secret').join(',') : '', patch.iceServers ? `iceServers=${patch.iceServers.length}` : '');
    if (patch.turn) await turnManager.reload();
  }
  res.json(callsPayload());
});

router.post('/calls/test', requireSitePerm(SITE_PERMISSIONS.SITE_ADMINISTRATOR), async (req, res) => {
  res.json(await turnManager.selfTest());
});

router.post('/calls/detect-ip', requireSitePerm(SITE_PERMISSIONS.SITE_ADMINISTRATOR), async (req, res) => {
  const ip = await turnManager.detectExternalIp();
  if (!ip) return res.status(502).json({ error: 'could not reach a public STUN server' });
  res.json({ ip });
});

router.get('/stats', (req, res) => {
  const users = db.prepare("SELECT COUNT(*) AS c FROM users WHERE username != '__webhook__' AND is_bot = 0").get().c;
  const servers = db.prepare('SELECT COUNT(*) AS c FROM servers').get().c;
  const messages = db.prepare('SELECT COUNT(*) AS c FROM messages').get().c;
  res.json({ users, servers, messages });
});

router.get('/users', requireSitePerm(SITE_PERMISSIONS.MANAGE_USERS), (req, res) => {
  // Excludes the reserved webhook-messages placeholder account (db/index.js WEBHOOK_SYSTEM_USER_ID)
  // — it's not a real account, nothing here to manage/disable/edit for it.
  const rows = db.prepare("SELECT * FROM users WHERE username != '__webhook__' AND is_bot = 0 ORDER BY id ASC").all();
  res.json({ users: rows.map(adminUserShape) });
});

router.patch('/users/:id', requireSitePerm(SITE_PERMISSIONS.MANAGE_USERS), (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'user not found' });
  // MANAGE_USERS alone must not let staff edit/disable/reset-password on someone who outranks
  // them — same ceiling rule as assertCanGrant, applied to the target's own site permission bits.
  if (!assertCanGrant(req, getSitePermissionBits(target.id))) {
    return res.status(403).json({ error: 'cannot modify a user with permissions you do not hold' });
  }
  const { displayName, email, password, authKey, authSalt, isDisabled } = req.body || {};

  let credentialReset = null;
  if (password !== undefined || authKey !== undefined || authSalt !== undefined) {
    // A split account's password never reaches the server: the admin's browser derives authKey with a
    // fresh salt. The shape must match the target's mode; the mode itself never changes here.
    const split = target.auth_mode === 'split';
    if (split ? password !== undefined : (authKey !== undefined || authSalt !== undefined)) {
      return res.status(400).json({
        error: split ? 'this account uses strengthened sign-in; reload the admin panel and try again' : 'this account signs in with a plain password',
      });
    }
    const next = split ? { authKey, authSalt } : { password };
    const problem = split ? splitAuth.splitKeyProblem(next) : splitAuth.credentialProblem(next);
    if (problem) return res.status(400).json({ error: problem });
    credentialReset = next;
  }

  if (displayName !== undefined) {
    const v = singleLine(displayName, 64);
    if (!v) return res.status(400).json({ error: 'displayName cannot be empty' });
    db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(v, target.id);
  }
  if (email !== undefined) {
    if (typeof email !== 'string' || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'invalid email' });
    const taken = db.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE AND id != ?').get(email, target.id);
    if (taken) return res.status(409).json({ error: 'email already taken' });
    db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, target.id);
  }
  if (credentialReset) {
    // Force re-login everywhere — the old password is no longer valid, and an admin-initiated
    // reset (compromised account, lost password) should invalidate any session an attacker held.
    accounts.inTransaction(() => {
      splitAuth.setCredential(target.id, credentialReset);
      destroyAllSessionsForUser(target.id);
    });
    pendingLogin.removeForUser(target.id);
    hub.disconnectUser(target.id);
    authAudit(target.id, target.passport_id, 'admin_reset', true, req, req.user.id);
  }
  if (isDisabled !== undefined) {
    const disabled = isDisabled ? 1 : 0;
    db.prepare('UPDATE users SET is_disabled = ? WHERE id = ?').run(disabled, target.id);
    if (disabled) {
      destroyAllSessionsForUser(target.id);
      hub.disconnectUser(target.id);
    }
  }
  syncTargetUser(target.id);
  res.json({ ok: true });
});

router.post('/users/:id/avatar', requireSitePerm(SITE_PERMISSIONS.MANAGE_USERS), uploadUserAvatar.single('avatar'), (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'user not found' });
  if (!assertCanGrant(req, getSitePermissionBits(target.id))) {
    return res.status(403).json({ error: 'cannot modify a user with permissions you do not hold' });
  }
  if (!req.file) return res.status(400).json({ error: 'avatar file required (png/jpg/gif/webp, max 5MB)' });
  const rel = `/uploads/avatars/${req.file.filename}`;
  db.prepare('UPDATE users SET avatar_path = ? WHERE id = ?').run(rel, target.id);
  syncTargetUser(target.id);
  res.json({ avatarPath: rel });
});

router.delete('/servers/:id', requireSitePerm(SITE_PERMISSIONS.MANAGE_ANY_SERVER), (req, res) => {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'server not found' });
  const memberIds = db.prepare('SELECT user_id FROM server_members WHERE server_id = ?').all(server.id).map((r) => r.user_id);
  db.prepare('DELETE FROM servers WHERE id = ?').run(server.id);
  if (server.kind === 'site') {
    require('../lib/siteProcesses').stop(server.id);
    require('../lib/siteFiles').removeSiteDir(server.id);
  }
  hub.notifyUserIds(memberIds, { type: 'server_delete', serverId: server.id });
  res.json({ ok: true });
});

// Every server on the instance, for the Stickers tab's server picker — site staff managing
// stickers there need not be a member of (or have MANAGE_SERVER on) the server they're editing.
router.get('/servers', requireSitePerm(SITE_PERMISSIONS.MANAGE_ANY_SERVER), (req, res) => {
  const rows = db.prepare('SELECT id, name, icon_path FROM servers ORDER BY name COLLATE NOCASE ASC').all();
  res.json({ servers: rows.map((s) => ({ id: s.id, name: s.name, iconPath: s.icon_path })) });
});

router.get('/servers/:id/stickers', requireSitePerm(SITE_PERMISSIONS.MANAGE_ANY_SERVER), (req, res) => {
  const server = db.prepare('SELECT id FROM servers WHERE id = ?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'server not found' });
  const stickers = db.prepare('SELECT * FROM stickers WHERE server_id = ? ORDER BY name COLLATE NOCASE ASC').all(server.id);
  res.json({ stickers });
});

router.post('/servers/:id/stickers', requireSitePerm(SITE_PERMISSIONS.MANAGE_ANY_SERVER), uploadSticker.single('image'), (req, res) => {
  const server = db.prepare('SELECT id FROM servers WHERE id = ?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'server not found' });
  const result = createSticker({ serverId: server.id, name: req.body?.name, description: req.body?.description, file: req.file, userId: req.user.id });
  if (result.error) return res.status(result.status || 400).json({ error: result.error });
  hub.broadcastToServer(server.id, { type: 'sticker_add', sticker: result.sticker });
  res.status(201).json({ sticker: result.sticker });
});

router.delete('/servers/:id/stickers/:stickerId', requireSitePerm(SITE_PERMISSIONS.MANAGE_ANY_SERVER), (req, res) => {
  const sticker = deleteSticker(Number(req.params.id), Number(req.params.stickerId));
  if (!sticker) return res.status(404).json({ error: 'not found' });
  hub.broadcastToServer(Number(req.params.id), { type: 'sticker_remove', serverId: Number(req.params.id), stickerId: sticker.id });
  res.json({ ok: true });
});

router.get('/servers/:id/sounds', requireSitePerm(SITE_PERMISSIONS.MANAGE_ANY_SERVER), (req, res) => {
  const server = db.prepare('SELECT id FROM servers WHERE id = ?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'server not found' });
  const sounds = db.prepare('SELECT * FROM sounds WHERE server_id = ? ORDER BY name COLLATE NOCASE ASC').all(server.id);
  res.json({ sounds });
});

router.post('/servers/:id/sounds', requireSitePerm(SITE_PERMISSIONS.MANAGE_ANY_SERVER), uploadSound.single('audio'), (req, res) => {
  const server = db.prepare('SELECT id FROM servers WHERE id = ?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'server not found' });
  const result = createSound({ serverId: server.id, name: req.body?.name, emoji: req.body?.emoji, file: req.file, userId: req.user.id });
  if (result.error) return res.status(result.status || 400).json({ error: result.error });
  hub.broadcastToServer(server.id, { type: 'sound_add', sound: result.sound });
  res.status(201).json({ sound: result.sound });
});

router.delete('/servers/:id/sounds/:soundId', requireSitePerm(SITE_PERMISSIONS.MANAGE_ANY_SERVER), (req, res) => {
  const sound = deleteSound(Number(req.params.id), Number(req.params.soundId));
  if (!sound) return res.status(404).json({ error: 'not found' });
  hub.broadcastToServer(Number(req.params.id), { type: 'sound_remove', serverId: Number(req.params.id), soundId: sound.id });
  res.json({ ok: true });
});

// ---------------- data pruning (master admin — instance-wide, PRUNE_DATA) ----------------

router.get('/prune/servers', requireSitePerm(SITE_PERMISSIONS.PRUNE_DATA), (req, res) => {
  const rows = db.prepare('SELECT id, name FROM servers ORDER BY name COLLATE NOCASE ASC').all();
  res.json({ servers: rows });
});

router.get('/prune/servers/:id/channels', requireSitePerm(SITE_PERMISSIONS.PRUNE_DATA), (req, res) => {
  const server = db.prepare('SELECT id FROM servers WHERE id = ?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'server not found' });
  const channels = db.prepare('SELECT id, name, type FROM channels WHERE server_id = ? ORDER BY position ASC, id ASC').all(server.id);
  res.json({ channels });
});

// Sorted by total size (messages + attachments) so an admin freeing up space can find the biggest
// conversations without ever seeing who's in them beyond username, or any message content.
router.get('/prune/dms', requireSitePerm(SITE_PERMISSIONS.PRUNE_DATA), (req, res) => {
  const rows = db.prepare('SELECT * FROM dm_channels').all();
  const shaped = rows.map((dm) => {
    const participants = db.prepare(
      `SELECT u.username, u.display_name AS displayName FROM dm_members m JOIN users u ON u.id = m.user_id WHERE m.dm_channel_id = ?`
    ).all(dm.id);
    const sizeRow = db.prepare(
      `SELECT COUNT(*) AS messageCount,
              COALESCE(SUM(LENGTH(m.content)), 0) AS textBytes,
              COALESCE((SELECT SUM(a.size_bytes) FROM attachments a JOIN messages mm ON mm.id = a.message_id WHERE mm.scope_type = 'dm' AND mm.scope_id = ?), 0) AS attachmentBytes
         FROM messages m WHERE m.scope_type = 'dm' AND m.scope_id = ?`
    ).get(dm.id, dm.id);
    const lastActivity = db.prepare("SELECT MAX(created_at) AS t FROM messages WHERE scope_type = 'dm' AND scope_id = ?").get(dm.id).t;
    return {
      id: dm.id,
      isGroup: !!dm.is_group,
      name: dm.name,
      participants,
      messageCount: sizeRow.messageCount,
      sizeBytes: sizeRow.textBytes + sizeRow.attachmentBytes,
      lastActivity,
    };
  }).sort((a, b) => b.sizeBytes - a.sizeBytes);
  res.json({ conversations: shaped });
});

function parsePruneBody(body) {
  if (!body?.cutoff || Number.isNaN(new Date(body.cutoff).getTime())) return { error: 'a valid cutoff date is required' };
  const cutoffAt = new Date(body.cutoff).toISOString();
  const scopeKind = body.scopeKind;
  const purgeAttachments = !!body.purgeAttachments;
  if (scopeKind === 'channels') {
    const ids = Array.isArray(body.channelIds) ? body.channelIds.map(Number).filter(Number.isInteger) : [];
    if (!ids.length) return { error: 'at least one channel is required' };
    return { scopeKind, ids, cutoffAt, purgeAttachments };
  }
  if (scopeKind === 'dm') {
    const dmId = Number(body.dmChannelId);
    if (!Number.isInteger(dmId)) return { error: 'dmChannelId is required' };
    return { scopeKind, ids: [dmId], cutoffAt, purgeAttachments };
  }
  return { error: 'scopeKind must be "channels" or "dm"' };
}

router.post('/prune/preview', requireSitePerm(SITE_PERMISSIONS.PRUNE_DATA), (req, res) => {
  const parsed = parsePruneBody(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const pairs = prune.resolveScopePairs(parsed.scopeKind, parsed.ids);
  res.json(prune.previewPrune(pairs, parsed.cutoffAt, parsed.purgeAttachments));
});

router.post('/prune/execute', requireSitePerm(SITE_PERMISSIONS.PRUNE_DATA), (req, res) => {
  const parsed = parsePruneBody(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const notify = req.body?.notify === 'grace' ? 'grace' : 'immediate';

  let serverId = null;
  if (parsed.scopeKind === 'channels') {
    const rows = db.prepare(`SELECT DISTINCT server_id FROM channels WHERE id IN (${parsed.ids.map(() => '?').join(',')})`).all(...parsed.ids);
    if (rows.length !== 1) return res.status(400).json({ error: 'channels must all belong to the same server' });
    serverId = rows[0].server_id;
  }

  const result = prune.executePrune({ ...parsed, notify, requestedBy: req.user.id, serverId });
  if (serverId) {
    logAudit(serverId, req.user.id, notify === 'grace' ? 'data_prune_scheduled' : 'data_prune', 'channels', null,
      { channelIds: parsed.ids, cutoff: parsed.cutoffAt });
  }
  res.json(result);
});

// Ciphertext is never shown to admins: an encrypted message only has the text its reporter chose to disclose.
function shapeReportedMessage(message, evidence) {
  if (!message.is_encrypted) return { id: message.id, content: message.content, createdAt: message.created_at };
  return { id: message.id, content: evidence || '', encrypted: true, hasEvidence: !!evidence, createdAt: message.created_at };
}

function shapeReport(r) {
  const reporter = r.reporter_id ? db.prepare('SELECT * FROM users WHERE id = ?').get(r.reporter_id) : null;
  const reported = db.prepare('SELECT * FROM users WHERE id = ?').get(r.reported_user_id);
  const message = r.message_id ? db.prepare('SELECT * FROM messages WHERE id = ?').get(r.message_id) : null;
  return {
    id: r.id,
    reporter: reporter ? toPublicUser(reporter, {}) : null, // null = the reporting account was since deleted
    reportedUser: toPublicUser(reported, {}),
    reason: r.reason,
    details: r.details,
    message: message ? shapeReportedMessage(message, r.plaintext_evidence) : null,
    status: r.status,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  };
}

router.get('/reports', requireSitePerm(SITE_PERMISSIONS.MANAGE_REPORTS), (req, res) => {
  const status = ['open', 'resolved', 'dismissed'].includes(req.query.status) ? req.query.status : 'open';
  const rows = db.prepare('SELECT * FROM reports WHERE status = ? ORDER BY id DESC').all(status);
  res.json({ reports: rows.map(shapeReport) });
});

router.patch('/reports/:id', requireSitePerm(SITE_PERMISSIONS.MANAGE_REPORTS), (req, res) => {
  const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!report) return res.status(404).json({ error: 'report not found' });
  const status = req.body?.status;
  if (!['resolved', 'dismissed'].includes(status)) return res.status(400).json({ error: 'status must be resolved or dismissed' });
  db.prepare("UPDATE reports SET status = ?, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), resolved_by = ? WHERE id = ?")
    .run(status, req.user.id, report.id);
  res.json({ report: shapeReport(db.prepare('SELECT * FROM reports WHERE id = ?').get(report.id)) });
});

router.get('/site-roles', (req, res) => {
  const roles = db.prepare('SELECT * FROM site_roles ORDER BY position DESC').all();
  res.json({ roles });
});

router.post('/site-roles', requireSitePerm(SITE_PERMISSIONS.MANAGE_SITE_ROLES), (req, res) => {
  const { name, color } = req.body || {};
  if (typeof name !== 'string') return res.status(400).json({ error: 'name required' });
  const cleanName = singleLine(name, 50);
  if (!cleanName) return res.status(400).json({ error: 'name required' });
  if (color !== undefined && !HEX_COLOR_RE.test(String(color))) {
    return res.status(400).json({ error: 'color must be #rrggbb' });
  }
  const maxPos = db.prepare('SELECT MAX(position) AS m FROM site_roles').get().m || 0;
  const info = db.prepare('INSERT INTO site_roles (name, color, position) VALUES (?, ?, ?)')
    .run(cleanName, color || '#99aab5', maxPos + 1);
  res.status(201).json({ role: db.prepare('SELECT * FROM site_roles WHERE id = ?').get(info.lastInsertRowid) });
});

router.patch('/site-roles/:id', requireSitePerm(SITE_PERMISSIONS.MANAGE_SITE_ROLES), (req, res) => {
  const role = db.prepare('SELECT * FROM site_roles WHERE id = ?').get(req.params.id);
  if (!role) return res.status(404).json({ error: 'role not found' });
  const { name, color, permissions, position } = req.body || {};

  if (!assertCanGrant(req, role.permissions)) {
    return res.status(403).json({ error: 'cannot edit a site role with permissions you do not hold' });
  }
  if (permissions !== undefined) {
    const next = Number(permissions) || 0;
    if (!assertCanGrant(req, next)) {
      return res.status(403).json({ error: 'cannot grant site permissions you do not hold' });
    }
  }
  if (color !== undefined && !HEX_COLOR_RE.test(String(color))) {
    return res.status(400).json({ error: 'color must be #rrggbb' });
  }

  const updates = []; const params = [];
  if (name !== undefined) { updates.push('name = ?'); params.push(singleLine(name, 50)); }
  if (color !== undefined) { updates.push('color = ?'); params.push(String(color)); }
  if (permissions !== undefined) { updates.push('permissions = ?'); params.push(Number(permissions) || 0); }
  if (position !== undefined) { updates.push('position = ?'); params.push(Number(position) || 0); }
  if (updates.length) {
    params.push(role.id);
    db.prepare(`UPDATE site_roles SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }
  res.json({ role: db.prepare('SELECT * FROM site_roles WHERE id = ?').get(role.id) });
});

router.delete('/site-roles/:id', requireSitePerm(SITE_PERMISSIONS.MANAGE_SITE_ROLES), (req, res) => {
  const role = db.prepare('SELECT * FROM site_roles WHERE id = ?').get(req.params.id);
  if (!role) return res.status(404).json({ error: 'role not found' });
  if (!assertCanGrant(req, role.permissions)) {
    return res.status(403).json({ error: 'cannot delete a role with permissions you do not hold' });
  }
  const stillAssigned = db.prepare('SELECT COUNT(*) AS c FROM user_site_roles WHERE role_id = ?').get(role.id).c;
  if (stillAssigned > 0) {
    return res.status(409).json({ error: 'unassign this role from every user before deleting it (prevents accidental admin lockout)' });
  }
  db.prepare('DELETE FROM site_roles WHERE id = ?').run(role.id);
  res.json({ ok: true });
});

router.put('/users/:id/site-roles/:roleId', requireSitePerm(SITE_PERMISSIONS.MANAGE_SITE_ROLES), (req, res) => {
  const role = db.prepare('SELECT * FROM site_roles WHERE id = ?').get(req.params.roleId);
  if (!role) return res.status(404).json({ error: 'role not found' });
  if (!assertCanGrant(req, role.permissions)) {
    return res.status(403).json({ error: 'cannot grant site permissions you do not hold' });
  }
  db.prepare('INSERT OR IGNORE INTO user_site_roles (user_id, role_id) VALUES (?, ?)')
    .run(req.params.id, req.params.roleId);
  res.json({ ok: true });
});

router.delete('/users/:id/site-roles/:roleId', requireSitePerm(SITE_PERMISSIONS.MANAGE_SITE_ROLES), (req, res) => {
  const role = db.prepare('SELECT * FROM site_roles WHERE id = ?').get(req.params.roleId);
  if (!role) return res.status(404).json({ error: 'role not found' });
  if (!assertCanGrant(req, role.permissions)) {
    return res.status(403).json({ error: 'cannot remove a site role with permissions you do not hold' });
  }
  db.prepare('DELETE FROM user_site_roles WHERE user_id = ? AND role_id = ?').run(req.params.id, req.params.roleId);
  res.json({ ok: true });
});

module.exports = router;
