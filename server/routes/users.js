'use strict';

const express = require('express');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');
const { db } = require('../db');
const { DATA_DIR } = require('../db');
const { toPublicUser } = require('../lib/publicUser');
const { requireAuth } = require('../middleware/auth');
const { isValidBackup, isValidBackupFor } = require('../lib/passportCrypto');
const { areFriends, isBlocked } = require('../lib/friends');
const { broadcastPresence } = require('../socket/hub');
const { sanitizeServerLayout } = require('../lib/serverLayout');
const { sanitizeTheme } = require('../lib/theme');
const { singleLine, statusEmoji } = require('../lib/textSanitize');
const { sanitizeCode, getLanguage } = require('../lib/languages');
const { acknowledgeNsfw } = require('../lib/ageGate');

const router = express.Router();

const AVATAR_ALLOWED = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const avatarStorage = multer.diskStorage({
  destination: path.join(DATA_DIR, 'avatars'),
  filename: (req, file, cb) => {
    const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' }[file.mimetype] || '';
    cb(null, `${req.user.id}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  },
});
const uploadAvatar = multer({
  storage: avatarStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, AVATAR_ALLOWED.has(file.mimetype)),
});

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// Same upload shape as the avatar (folder + column differ) — shared by the profile card's
// customizable top ("banner") and bottom ("card") background images.
function makeCardImageUpload(folder) {
  return multer({
    storage: multer.diskStorage({
      destination: path.join(DATA_DIR, folder),
      filename: (req, file, cb) => {
        const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' }[file.mimetype] || '';
        cb(null, `${req.user.id}-${crypto.randomBytes(6).toString('hex')}${ext}`);
      },
    }),
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter: (req, file, cb) => cb(null, AVATAR_ALLOWED.has(file.mimetype)),
  });
}
const uploadBanner = makeCardImageUpload('banners');
const uploadCard = makeCardImageUpload('cards');
const uploadFolderIcon = makeCardImageUpload('foldericons');

router.patch('/me', requireAuth, (req, res) => {
  const { displayName, bio, dmPrivacy, profilePrivacy, discoverable, bannerColor, cardColor } = req.body || {};
  const updates = [];
  const params = [];

  if (bannerColor !== undefined) {
    if (bannerColor !== '' && !HEX_COLOR_RE.test(String(bannerColor))) return res.status(400).json({ error: 'bannerColor must be #rrggbb or empty' });
    updates.push('banner_color = ?'); params.push(String(bannerColor));
  }
  if (cardColor !== undefined) {
    if (cardColor !== '' && !HEX_COLOR_RE.test(String(cardColor))) return res.status(400).json({ error: 'cardColor must be #rrggbb or empty' });
    updates.push('card_color = ?'); params.push(String(cardColor));
  }
  if (displayName !== undefined) {
    const v = singleLine(displayName, 64);
    if (!v) return res.status(400).json({ error: 'displayName cannot be empty' });
    updates.push('display_name = ?'); params.push(v);
  }
  if (bio !== undefined) {
    updates.push('bio = ?'); params.push(String(bio).slice(0, 500));
  }
  if (dmPrivacy !== undefined) {
    if (!['everyone', 'friends', 'none'].includes(dmPrivacy)) return res.status(400).json({ error: 'invalid dmPrivacy' });
    updates.push('dm_privacy = ?'); params.push(dmPrivacy);
  }
  if (profilePrivacy !== undefined) {
    if (!['everyone', 'friends'].includes(profilePrivacy)) return res.status(400).json({ error: 'invalid profilePrivacy' });
    updates.push('profile_privacy = ?'); params.push(profilePrivacy);
  }
  if (discoverable !== undefined) {
    updates.push('discoverable = ?'); params.push(discoverable ? 1 : 0);
  }
  if (updates.length === 0) return res.status(400).json({ error: 'nothing to update' });

  params.push(req.user.id);
  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: toPublicUser(user, { viewerIsSelf: true }) });
});

// Server rail grouping (folders) — purely a personal organizational preference, stored as one
// JSON blob rather than normalized tables since it's just an ordered list this one user edits.
router.get('/me/server-layout', requireAuth, (req, res) => {
  let layout;
  try { layout = JSON.parse(req.user.server_layout || '[]'); } catch { layout = []; }
  res.json({ layout });
});

router.put('/me/server-layout', requireAuth, (req, res) => {
  if (!Array.isArray(req.body?.layout)) return res.status(400).json({ error: 'layout must be an array' });

  // Only servers this user is actually a member of are allowed in — silently drops anything
  // else rather than erroring, since a stale entry (e.g. left a server in another tab a moment
  // ago) shouldn't block saving the rest of a legitimate reorder.
  const myServerIds = new Set(
    db.prepare('SELECT server_id FROM server_members WHERE user_id = ?').all(req.user.id).map((r) => r.server_id)
  );
  const cleaned = sanitizeServerLayout(req.body.layout, myServerIds);

  db.prepare('UPDATE users SET server_layout = ? WHERE id = ?').run(JSON.stringify(cleaned), req.user.id);
  res.json({ ok: true, layout: cleaned });
});

// Personal appearance preference — a curated set of CSS custom-property overrides, never raw
// CSS (see lib/theme.js sanitizeTheme for why). Only ever applied to this user's own client.
// Personal language preference (see server/lib/languages.js). Follows the user across devices,
// the same way theme/ui-prefs do.
// One-time "I am 18 or older" click-through for age-restricted channels; nothing is verified.
router.post('/me/age-confirmation', requireAuth, (req, res) => {
  acknowledgeNsfw(req.user.id);
  res.json({ ok: true });
});

router.get('/me/language', requireAuth, (req, res) => {
  res.json({ language: req.user.language || null });
});

router.put('/me/language', requireAuth, (req, res) => {
  const code = sanitizeCode(req.body?.code);
  if (!code) return res.status(400).json({ error: 'invalid language code' });
  const lang = getLanguage(code);
  if (!lang || !lang.enabled) return res.status(400).json({ error: 'language is not installed or not enabled' });
  db.prepare('UPDATE users SET language = ? WHERE id = ?').run(code, req.user.id);
  res.json({ ok: true, language: code });
});

router.get('/me/theme', requireAuth, (req, res) => {
  let stored;
  try { stored = JSON.parse(req.user.theme || '{}'); } catch { stored = {}; }
  res.json({ theme: sanitizeTheme(stored) });
});

router.put('/me/theme', requireAuth, (req, res) => {
  const cleaned = sanitizeTheme(req.body?.theme);
  db.prepare('UPDATE users SET theme = ? WHERE id = ?').run(JSON.stringify(cleaned), req.user.id);
  res.json({ ok: true, theme: cleaned });
});

// Resizable-sidebar widths (channel sidebar, member list/right-panel slot) - a personal layout
// preference like theme/server-layout above, so it gets the same "own JSON column, sanitize on
// the way in" treatment rather than a bespoke table for two numbers.
const UI_PREF_BOUNDS = { sidebarWidth: [180, 400], membersWidth: [180, 400], unreadContext: [0, 50], initialMessages: [20, 100] };
const LANDING_VIEWS = new Set(['home', 'lastLocation']);
const UI_PREF_ENUMS = { unreadLine: new Set(['on', 'off']), unreadJump: new Set(['firstUnread', 'bottom']) };
function sanitizeUiPrefs(raw) {
  const cleaned = {};
  for (const [key, [min, max]] of Object.entries(UI_PREF_BOUNDS)) {
    const n = Number(raw?.[key]);
    if (Number.isFinite(n)) cleaned[key] = Math.round(Math.max(min, Math.min(max, n)));
  }
  if (LANDING_VIEWS.has(raw?.landingView)) cleaned.landingView = raw.landingView;
  for (const [key, allowed] of Object.entries(UI_PREF_ENUMS)) {
    if (allowed.has(raw?.[key])) cleaned[key] = raw[key];
  }
  return cleaned;
}

router.get('/me/ui-prefs', requireAuth, (req, res) => {
  let stored;
  try { stored = JSON.parse(req.user.ui_prefs || '{}'); } catch { stored = {}; }
  res.json({ uiPrefs: sanitizeUiPrefs(stored) });
});

router.put('/me/ui-prefs', requireAuth, (req, res) => {
  let stored;
  try { stored = JSON.parse(req.user.ui_prefs || '{}'); } catch { stored = {}; }
  const merged = sanitizeUiPrefs({ ...stored, ...req.body });
  db.prepare('UPDATE users SET ui_prefs = ? WHERE id = ?').run(JSON.stringify(merged), req.user.id);
  res.json({ ok: true, uiPrefs: merged });
});

// A folder icon isn't tied to a DB column the way avatar/banner/card are — folders themselves
// only exist inside the server_layout JSON blob — so this just stores the file and hands back a
// path; the client embeds it into the folder object it PUTs to /me/server-layout right after.
router.post('/me/folder-icon', requireAuth, uploadFolderIcon.single('icon'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'icon file required (png/jpg/gif/webp, max 8MB)' });
  res.json({ iconPath: `/uploads/foldericons/${req.file.filename}` });
});

router.post('/me/avatar', requireAuth, uploadAvatar.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'avatar file required (png/jpg/gif/webp, max 5MB)' });
  const rel = `/uploads/avatars/${req.file.filename}`;
  db.prepare('UPDATE users SET avatar_path = ? WHERE id = ?').run(rel, req.user.id);
  res.json({ avatarPath: rel });
});

router.post('/me/banner', requireAuth, uploadBanner.single('banner'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'banner file required (png/jpg/gif/webp, max 8MB)' });
  const rel = `/uploads/banners/${req.file.filename}`;
  db.prepare('UPDATE users SET banner_path = ? WHERE id = ?').run(rel, req.user.id);
  res.json({ bannerPath: rel });
});

router.delete('/me/banner', requireAuth, (req, res) => {
  db.prepare('UPDATE users SET banner_path = NULL WHERE id = ?').run(req.user.id);
  res.json({ ok: true });
});

router.post('/me/card', requireAuth, uploadCard.single('card'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'card background file required (png/jpg/gif/webp, max 8MB)' });
  const rel = `/uploads/cards/${req.file.filename}`;
  db.prepare('UPDATE users SET card_path = ? WHERE id = ?').run(rel, req.user.id);
  res.json({ cardPath: rel });
});

router.delete('/me/card', requireAuth, (req, res) => {
  db.prepare('UPDATE users SET card_path = NULL WHERE id = ?').run(req.user.id);
  res.json({ ok: true });
});

router.put('/me/status', requireAuth, (req, res) => {
  const { status, customStatusText, customStatusEmoji, notifySoundMode } = req.body || {};
  const valid = ['online', 'idle', 'dnd', 'invisible'];
  if (status !== undefined && !valid.includes(status)) {
    return res.status(400).json({ error: `status must be one of ${valid.join(', ')}` });
  }
  const validSoundModes = ['auto', 'always', 'never'];
  if (notifySoundMode !== undefined && !validSoundModes.includes(notifySoundMode)) {
    return res.status(400).json({ error: `notifySoundMode must be one of ${validSoundModes.join(', ')}` });
  }
  const updates = [];
  const params = [];
  if (status !== undefined) { updates.push('status = ?'); params.push(status); }
  if (customStatusText !== undefined) { updates.push('custom_status_text = ?'); params.push(singleLine(customStatusText, 128)); }
  if (customStatusEmoji !== undefined) { updates.push('custom_status_emoji = ?'); params.push(statusEmoji(customStatusEmoji)); }
  if (notifySoundMode !== undefined) { updates.push('notify_sound_mode = ?'); params.push(notifySoundMode); }
  if (updates.length === 0) return res.status(400).json({ error: 'nothing to update' });
  params.push(req.user.id);
  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  broadcastPresence(req.user.id);
  res.json({ ok: true });
});

// A base64 X25519 public key, 32 raw bytes when decoded. Validated by length only — the server
// has no way to verify it's a real curve point, but a malformed key just breaks that user's own
// E2EE for others trying to DH with them, no security implication for anyone else.
router.put('/me/e2ee-key', requireAuth, (req, res) => {
  const publicKey = req.body?.publicKey;
  if (typeof publicKey !== 'string' || Buffer.from(publicKey, 'base64').length !== 32) {
    return res.status(400).json({ error: 'publicKey must be a base64-encoded 32-byte X25519 key' });
  }
  db.prepare('UPDATE users SET e2ee_public_key = ? WHERE id = ?').run(publicKey, req.user.id);
  res.json({ ok: true });
});

router.put('/me/e2ee-backup', requireAuth, (req, res) => {
  if (!isValidBackup(req.body)) {
    return res.status(400).json({ error: 'encryptedKey, salt, and nonce are all required non-empty strings (max 4096 chars)' });
  }
  const { auth_mode: authMode } = db.prepare('SELECT auth_mode FROM users WHERE id = ?').get(req.user.id);
  if (!isValidBackupFor(authMode, req.body)) {
    return res.status(400).json({ error: 'backup does not match the account sign-in mode' });
  }
  const { encryptedKey, salt, nonce } = req.body;
  db.prepare(
    `INSERT INTO e2ee_key_backups (user_id, encrypted_key, salt, nonce) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET encrypted_key = excluded.encrypted_key, salt = excluded.salt, nonce = excluded.nonce, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).run(req.user.id, encryptedKey, salt, nonce);
  res.json({ ok: true });
});

router.get('/me/e2ee-backup', requireAuth, (req, res) => {
  const row = db.prepare('SELECT encrypted_key, salt, nonce FROM e2ee_key_backups WHERE user_id = ?').get(req.user.id);
  if (!row) return res.status(404).json({ error: 'no key backup on file' });
  res.json({ encryptedKey: row.encrypted_key, salt: row.salt, nonce: row.nonce });
});

// Registered before /:id — otherwise Express would match "search" itself as an :id value.
router.get('/search', requireAuth, (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 64);
  if (!q) return res.json({ users: [] });

  const rows = db.prepare(
    `SELECT * FROM users
      WHERE discoverable = 1 AND id != ? AND (username LIKE ? OR display_name LIKE ?)
      ORDER BY username COLLATE NOCASE ASC
      LIMIT 20`
  ).all(req.user.id, `%${q}%`, `%${q}%`);

  const results = rows
    .filter((u) => !isBlocked(req.user.id, u.id))
    .map((u) => toPublicUser(u, { viewerIsSelf: false, areFriends: areFriends(req.user.id, u.id) }));
  res.json({ users: results });
});

router.get('/:id', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'user not found' });
  const viewerIsSelf = user.id === req.user.id;
  const friends = areFriends(req.user.id, user.id);
  const shaped = toPublicUser(user, { viewerIsSelf, areFriends: friends });
  if (!viewerIsSelf) {
    // Servers both people are in — same "safe to reveal" tier as mutual friends, shown on the
    // profile card so a viewer can see shared context and pick a server to invite this person
    // into (only ones they're NOT already in, filtered client-side against this list).
    shaped.mutualServers = db.prepare(
      `SELECT s.id, s.name FROM servers s
        JOIN server_members mine ON mine.server_id = s.id AND mine.user_id = ?
        JOIN server_members theirs ON theirs.server_id = s.id AND theirs.user_id = ?`
    ).all(req.user.id, user.id);
    shaped.mutualFriends = db.prepare(
      `SELECT u.* FROM users u WHERE u.id != ? AND u.id != ?
         AND u.id IN (SELECT CASE WHEN user_a = ? THEN user_b ELSE user_a END FROM friendships WHERE status = 'accepted' AND (user_a = ? OR user_b = ?))
         AND u.id IN (SELECT CASE WHEN user_a = ? THEN user_b ELSE user_a END FROM friendships WHERE status = 'accepted' AND (user_a = ? OR user_b = ?))`
    ).all(req.user.id, user.id, req.user.id, req.user.id, req.user.id, user.id, user.id, user.id)
      .map((u) => toPublicUser(u, { viewerIsSelf: false, areFriends: true }));
    const friendship = db.prepare("SELECT created_at, accepted_at FROM friendships WHERE status = 'accepted' AND ((user_a = ? AND user_b = ?) OR (user_a = ? AND user_b = ?))")
      .get(req.user.id, user.id, user.id, req.user.id);
    shaped.friendsSince = friendship ? (friendship.accepted_at || friendship.created_at) : null;
    shaped.canMessage = require('./dms').canDm(req.user, user);
  }
  shaped.createdAt = user.created_at;
  res.json({ user: shaped });
});

module.exports = router;
