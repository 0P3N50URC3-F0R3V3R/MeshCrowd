'use strict';

const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const multer = require('multer');
const { db, DATA_DIR } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { PERMISSIONS, DEFAULT_EVERYONE_PERMISSIONS, has } = require('../lib/permissions');
const { getMemberPermissionBits, getChannelPermissionBits, removeMember, isPendingMember } = require('../lib/channelAccess');
const { toPublicUser } = require('../lib/publicUser');
const { broadcastToServer, broadcastToChannel, notifyUserIds } = require('../socket/hub');
const { postServerEvent, SERVER_EVENT_TYPES } = require('../lib/systemMessages');
const { searchMessages, parseFieldsParam } = require('../lib/search');
const { singleLine } = require('../lib/textSanitize');
const { logAudit } = require('../lib/auditLog');
const { uploadSticker, createSticker, deleteSticker } = require('../lib/stickers');
const { uploadSound, createSound, deleteSound } = require('../lib/sounds');
const { uploadWebhookIcon, createWebhook, deleteWebhook, regenerateToken } = require('../lib/webhooks');
const voice = require('../socket/voice');
const prune = require('../lib/prune');
const { signPayload } = require('../lib/federationCrypto');
const { safeFetch } = require('../lib/federationSsrf');
// Reused, not re-derived: federationOutboxWorker.js exports this specifically so every signer of
// an outgoing federation envelope (the outbox worker, dms.js, and now this route) agrees on what
// "our own domain" means, instead of each re-deriving `federationPublicUrl ?? publicHost` and
// risking drift from what the outbox worker itself signs with.
const { ownDomain } = require('../lib/federationOutboxWorker');

const router = express.Router();

const { VOICE_QUALITIES, DEFAULT_VOICE_QUALITY } = require('../lib/voiceQuality');
const serverInvites = require('../lib/serverInvites');
const { nsfwBlock } = require('../lib/ageGate');
const { isLevel } = require('../lib/verification');
const onboardingLib = require('../lib/onboarding');
const CHANNEL_TYPES = new Set(['public', 'private', 'announcement', 'readonly', 'voice', 'forum', 'stage', 'notes']);
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const ROLE_EMOJI_RE = /^[\p{Extended_Pictographic}\p{Emoji_Modifier}\u200D\uFE0F]{1,16}$/u;
const VISIBILITIES = new Set(['private', 'public']);

function requireMember(req, res, next) {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id || req.params.serverId);
  if (!server) return res.status(404).json({ error: 'server not found' });
  const membership = db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?')
    .get(server.id, req.user.id);
  if (!membership) return res.status(403).json({ error: 'not a member of this server' });
  req.server = server;
  next();
}

function requirePerm(flag) {
  return (req, res, next) => {
    const bits = getMemberPermissionBits(req.server.id, req.user.id);
    if (!has(bits, flag)) return res.status(403).json({ error: 'missing permission' });
    next();
  };
}

// A role-manager can never grant/hold-via-role permission bits they don't already have
// themselves (server owner is exempt) — otherwise MANAGE_ROLES alone is a path to full
// server takeover (self-grant ADMINISTRATOR).
function assertCanGrant(req, permissionBits) {
  if (req.server.owner_id === req.user.id) return true;
  const mine = getMemberPermissionBits(req.server.id, req.user.id);
  if (mine & PERMISSIONS.ADMINISTRATOR) return true;
  return (permissionBits & ~mine) === 0;
}

router.use(requireAuth);

// A Site (servers.kind = 'site') has no channels, roles, invites or messages: only the detail read and
// the icon upload exist for it here; everything else lives in routes/sites.js.
router.use('/:id', (req, res, next) => {
  if (!/^\d+$/.test(req.params.id)) return next();
  const row = db.prepare('SELECT kind FROM servers WHERE id = ?').get(Number(req.params.id));
  if (!row || row.kind !== 'site') return next();
  if ((req.method === 'GET' && req.path === '/') || (req.method === 'POST' && req.path === '/icon')) return next();
  res.status(404).json({ error: 'not available for sites' });
});

router.post('/', (req, res) => {
  const { name, description, visibility, autoJoin } = req.body || {};
  if (typeof name !== 'string') return res.status(400).json({ error: 'server name required' });
  const cleanName = singleLine(name, 100);
  if (!cleanName) return res.status(400).json({ error: 'server name required' });
  const vis = VISIBILITIES.has(visibility) ? visibility : 'private';
  // auto-join only makes sense for a public server — silently drop it for a private one rather
  // than error, since the client just leaves the toggle in whatever state it was previously in.
  const auto = vis === 'public' && !!autoJoin ? 1 : 0;

  const inviteCode = crypto.randomBytes(6).toString('hex');
  const info = db.prepare('INSERT INTO servers (name, description, owner_id, invite_code, visibility, auto_join) VALUES (?, ?, ?, ?, ?, ?)')
    .run(cleanName, String(description || '').slice(0, 500), req.user.id, inviteCode, vis, auto);
  const serverId = info.lastInsertRowid;

  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(serverId, req.user.id);
  db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, ?, 1)')
    .run(serverId, '@everyone', DEFAULT_EVERYONE_PERMISSIONS, 0);
  db.prepare('INSERT INTO channels (server_id, name, type, position) VALUES (?, ?, ?, ?)')
    .run(serverId, 'general', 'public', 0);

  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
  res.status(201).json({ server });
});

router.get('/', (req, res) => {
  const rows = db.prepare(
    `SELECT s.* FROM servers s JOIN server_members sm ON sm.server_id = s.id WHERE sm.user_id = ?`
  ).all(req.user.id);
  res.json({ servers: rows });
});

// Signs and forwards a redeem_invite envelope to the server's owning instance, shaped exactly
// like the outbox worker's own outgoing envelopes (middleware/federationVerify.js reconstructs
// and verifies the same {event_id, type, origin_domain, created_at, payload} shape on arrival).
async function forwardInviteToOwner(peer, code, user) {
  const payload = {
    event_id: crypto.randomUUID(),
    type: 'redeem_invite',
    origin_domain: ownDomain(),
    created_at: new Date().toISOString(),
    payload: { code, remoteId: user.id, username: user.username, displayName: user.display_name },
  };
  const signature = signPayload(payload);
  const res = await safeFetch(`${peer.public_url.replace(/\/$/, '')}/federation/api/redeem-invite`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, signature }),
    signal: AbortSignal.timeout(10_000),
  });
  return res.json();
}

router.post('/join', async (req, res) => {
  const { inviteCode } = req.body || {};
  if (typeof inviteCode !== 'string' || !inviteCode) return res.status(400).json({ error: 'invite code required' });

  // A cross-instance invite is domain-qualified as `code@domain` (parallel to how a federated
  // friend request is already addressed as `username@domain`) — the invite link a public/
  // federated server hands out is `<code>@<owning instance's domain>` instead of a bare code.
  const at = inviteCode.indexOf('@');
  if (at !== -1) {
    const code = inviteCode.slice(0, at);
    const domain = inviteCode.slice(at + 1);
    const peer = db.prepare(`SELECT * FROM federation_peers WHERE domain = ? AND status = 'active'`).get(domain);
    if (!peer) return res.status(404).json({ error: 'invalid invite code' });
    let result;
    try { result = await forwardInviteToOwner(peer, code, req.user); } catch {  return res.status(502).json({ error: 'the other instance is unreachable' }); }
    if (!result || typeof result !== 'object') return res.status(502).json({ error: 'the other instance is unreachable' });
    if (!result.ok) {
      // Mirrors the local branch's own status split below (403 banned / 404 not found) rather than
      // collapsing every remote failure into 404 — a banned-from-this-server response should read
      // the same to the client regardless of which instance owns the server.
      const status = result.error === 'banned' ? 403 : 404;
      return res.status(status).json({ error: result.error || 'invalid invite code' });
    }
    // No local servers/server_members row: the owner stays the source of truth and is proxied live
    // (routes/remote.js). Only this per-user ledger row is stored so the server can be found again.
    if (!Number.isInteger(result.server?.id)) return res.status(404).json({ error: 'invalid invite code' });
    db.prepare(
      `INSERT INTO remote_memberships (user_id, peer_id, remote_server_id, name) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, peer_id, remote_server_id) DO UPDATE SET name = excluded.name`
    ).run(req.user.id, peer.id, result.server.id, singleLine(String(result.server.name ?? ''), 100));
    return res.json({ server: result.server, channels: result.channels, federated: true, peerDomain: domain, peerId: peer.id });
  }

  const resolved = serverInvites.resolveJoinCode(inviteCode);
  if (!resolved) return res.status(404).json({ error: 'invalid invite code' });
  if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
  const { server, invite } = resolved;

  const banned = db.prepare('SELECT 1 FROM server_bans WHERE server_id = ? AND user_id = ?').get(server.id, req.user.id);
  if (banned) return res.status(403).json({ error: 'banned from this server' });

  const already = db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(server.id, req.user.id);
  if (!already) {
    if (invite && !serverInvites.consumeInvite(invite.id)) return res.status(410).json({ error: 'this invite has reached its use limit' });
    db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(server.id, req.user.id);
    broadcastToServer(server.id, { type: 'member_join', serverId: server.id, user: toPublicUser(req.user, {}) });
    postServerEvent(server.id, 'member_join', req.user.id);
  }
  res.json({ server });
});

// One-click "invite this person to my server" from their profile card — grants membership
// immediately instead of making them redeem a code, same shortcut channelInvites' /direct
// already takes at the channel level. Anyone who could share the invite code (CREATE_INVITE) can
// do this too, since the end result — this user becomes a member — is identical either way.
router.post('/:id/invite-direct', requireMember, requirePerm(PERMISSIONS.CREATE_INVITE), (req, res) => {
  const targetId = Number(req.body?.userId);
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  if (!target || target.is_bot) return res.status(404).json({ error: 'user not found' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'cannot invite yourself' });

  const banned = db.prepare('SELECT 1 FROM server_bans WHERE server_id = ? AND user_id = ?').get(req.server.id, target.id);
  if (banned) return res.status(403).json({ error: 'this user is banned from the server' });

  const alreadyMember = db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(req.server.id, target.id);
  if (alreadyMember) return res.status(400).json({ error: 'already a member' });

  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(req.server.id, target.id);
  broadcastToServer(req.server.id, { type: 'member_join', serverId: req.server.id, user: toPublicUser(target, {}) });
  postServerEvent(req.server.id, 'member_join', target.id);
  notifyUserIds([target.id], {
    type: 'server_invite_received',
    server: { id: req.server.id, name: req.server.name },
    invitedBy: toPublicUser(req.user, {}),
  });
  res.json({ ok: true });
});

// Redeeming a channel invite (as opposed to a server-wide invite_code, handled by /join above):
// joins the server if needed, then grants VIEW_CHANNEL on just that one channel via a per-user
// override — the invited person doesn't get any of the channel's role-based access, only this.
router.post('/channel-invites/:code/join', (req, res) => {
  const invite = db.prepare('SELECT * FROM channel_invites WHERE code = ?').get(req.params.code);
  if (!invite) return res.status(404).json({ error: 'invalid invite code' });
  if (invite.expires_at && new Date(invite.expires_at) < new Date()) return res.status(410).json({ error: 'this invite has expired' });
  if (invite.max_uses !== null && invite.uses >= invite.max_uses) return res.status(410).json({ error: 'this invite has reached its use limit' });

  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(invite.channel_id);
  if (!channel) return res.status(404).json({ error: 'channel no longer exists' });
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(channel.server_id);

  const banned = db.prepare('SELECT 1 FROM server_bans WHERE server_id = ? AND user_id = ?').get(server.id, req.user.id);
  if (banned) return res.status(403).json({ error: 'banned from this server' });

  const alreadyMember = db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(server.id, req.user.id);
  if (!alreadyMember) {
    db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(server.id, req.user.id);
    broadcastToServer(server.id, { type: 'member_join', serverId: server.id, user: toPublicUser(req.user, {}) });
    postServerEvent(server.id, 'member_join', req.user.id);
  }

  db.prepare(
    `INSERT INTO channel_user_overrides (channel_id, user_id, allow, deny) VALUES (?, ?, ?, 0)
     ON CONFLICT(channel_id, user_id) DO UPDATE SET allow = allow | excluded.allow`
  ).run(channel.id, req.user.id, PERMISSIONS.VIEW_CHANNEL);
  db.prepare('UPDATE channel_invites SET uses = uses + 1 WHERE id = ?').run(invite.id);

  res.json({ server, channelId: channel.id });
});

// Registered before /:id — a bare "/discover" would otherwise be swallowed by the /:id param route.
router.get('/discover', (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 64);
  const rows = q
    ? db.prepare(`SELECT * FROM servers WHERE visibility = 'public' AND name LIKE ? ORDER BY name COLLATE NOCASE ASC LIMIT 50`).all(`%${q}%`)
    : db.prepare(`SELECT * FROM servers WHERE visibility = 'public' ORDER BY name COLLATE NOCASE ASC LIMIT 50`).all();
  const joinedIds = new Set(
    db.prepare('SELECT server_id FROM server_members WHERE user_id = ?').all(req.user.id).map((r) => r.server_id)
  );
  const servers = rows.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    iconPath: s.icon_path,
    autoJoin: !!s.auto_join,
    memberCount: db.prepare('SELECT COUNT(*) AS c FROM server_members WHERE server_id = ?').get(s.id).c,
    joined: joinedIds.has(s.id),
  }));
  res.json({ servers });
});

router.post('/:id/join-public', (req, res) => {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  if (!server || server.visibility !== 'public') return res.status(404).json({ error: 'server not found' });

  const banned = db.prepare('SELECT 1 FROM server_bans WHERE server_id = ? AND user_id = ?').get(server.id, req.user.id);
  if (banned) return res.status(403).json({ error: 'banned from this server' });

  const already = db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(server.id, req.user.id);
  if (!already) {
    db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(server.id, req.user.id);
    broadcastToServer(server.id, { type: 'member_join', serverId: server.id, user: toPublicUser(req.user, {}) });
    postServerEvent(server.id, 'member_join', req.user.id);
  }
  res.json({ server });
});

router.get('/:id', requireMember, (req, res) => {
  const channels = db.prepare('SELECT * FROM channels WHERE server_id = ? ORDER BY position ASC, id ASC').all(req.server.id)
    .filter((ch) => has(getChannelPermissionBits(ch, req.user.id), PERMISSIONS.VIEW_CHANNEL))
    .map((ch) => ({
      ...ch,
      overrides: db.prepare('SELECT role_id, allow, deny FROM channel_role_overrides WHERE channel_id = ?').all(ch.id),
      last_message_id: db.prepare('SELECT MAX(id) AS id FROM messages WHERE scope_type = \'channel\' AND scope_id = ?').get(ch.id).id,
    }));
  const categories = db.prepare('SELECT * FROM channel_categories WHERE server_id = ? ORDER BY position ASC, id ASC').all(req.server.id);
  const roles = db.prepare('SELECT * FROM roles WHERE server_id = ? ORDER BY position DESC').all(req.server.id);
  const members = db.prepare(
    `SELECT sm.user_id, sm.nickname, sm.name_color, sm.timeout_until, u.* FROM server_members sm JOIN users u ON u.id = sm.user_id WHERE sm.server_id = ?`
  ).all(req.server.id).map((m) => ({
    nickname: m.nickname,
    nameColor: m.name_color || null,
    timeoutUntil: m.timeout_until && new Date(m.timeout_until) > new Date() ? m.timeout_until : null,
    roleIds: db.prepare('SELECT role_id FROM member_roles WHERE server_id = ? AND user_id = ?').all(req.server.id, m.user_id).map((r) => r.role_id),
    user: toPublicUser(m, {}),
  }));

  const myBits = getMemberPermissionBits(req.server.id, req.user.id);
  const server = has(myBits, PERMISSIONS.CREATE_INVITE)
    ? req.server
    : { ...req.server, invite_code: null };

  const welcomeChannels = db.prepare('SELECT * FROM welcome_channels WHERE server_id = ? ORDER BY position ASC, id ASC').all(req.server.id)
    .filter((wc) => channels.some((ch) => ch.id === wc.channel_id));
  const customEmoji = db.prepare('SELECT * FROM custom_emoji WHERE server_id = ? ORDER BY name COLLATE NOCASE ASC').all(req.server.id);
  const stickers = db.prepare('SELECT * FROM stickers WHERE server_id = ? ORDER BY name COLLATE NOCASE ASC').all(req.server.id);
  const sounds = db.prepare('SELECT * FROM sounds WHERE server_id = ? ORDER BY name COLLATE NOCASE ASC').all(req.server.id);

  // Present only while this member still has to accept the rules (membership screening).
  const onboarding = isPendingMember(req.server.id, req.user.id) ? onboardingLib.publicConfig(req.server.id) : null;

  res.json({ server, channels, categories, roles, members, welcomeChannels, customEmoji, stickers, sounds, onboarding });
});

// Server-wide message search, filtered to channels the requester can actually see — a private
// channel they're not granted into never surfaces a result, matching regular channel visibility.
// `channelId` narrows to one channel (still permission-checked) instead of the whole server.
router.get('/:id/search', requireMember, (req, res) => {
  const q = String(req.query.q || '');
  const fields = parseFieldsParam(req.query.fields);
  const viewableChannels = db.prepare('SELECT * FROM channels WHERE server_id = ?').all(req.server.id)
    .filter((ch) => has(getChannelPermissionBits(ch, req.user.id), PERMISSIONS.VIEW_CHANNEL))
    .filter((ch) => !nsfwBlock(ch, req.user.id));
  let channelIds = viewableChannels.map((ch) => ch.id);
  if (req.query.channelId) {
    const wanted = Number(req.query.channelId);
    channelIds = channelIds.filter((id) => id === wanted);
  }
  const limit = req.query.limit;
  // A forum channel's own content is entirely inside its threads (no top-level channel
  // messages at all) — search both scopes and merge, or a search scoped to a forum channel
  // would silently always come back empty.
  const threadIds = channelIds.length
    ? db.prepare(`SELECT id FROM threads WHERE channel_id IN (${channelIds.map(() => '?').join(',')})`).all(...channelIds).map((t) => t.id)
    : [];
  const threadChannelById = new Map(
    threadIds.length
      ? db.prepare(`SELECT id, channel_id FROM threads WHERE id IN (${threadIds.map(() => '?').join(',')})`).all(...threadIds).map((t) => [t.id, t.channel_id])
      : []
  );
  const channelNameById = new Map(viewableChannels.map((ch) => [ch.id, ch.name]));
  const messages = [
    ...searchMessages('channel', channelIds, q, { limit, fields }).map((m) => ({ ...m, channelName: channelNameById.get(m.scopeId) })),
    // channelId lets the client open the right thread panel — a thread result's own scopeId is
    // the thread id, not a channel, so it can't reuse the plain "navigate to channel X" jump path.
    ...searchMessages('thread', threadIds, q, { limit, fields }).map((m) => {
      const channelId = threadChannelById.get(m.scopeId);
      return { ...m, channelId, channelName: channelNameById.get(channelId) };
    }),
  ];
  // "Channel Names" is a match against the channel itself, not a message property, so it's a
  // separate pass: every message in a name-matching channel, content notwithstanding.
  if (fields.channelNames && q.trim()) {
    const nameMatch = q.trim().toLowerCase();
    const matchingChannelIds = channelIds.filter((id) => channelNameById.get(id)?.toLowerCase().includes(nameMatch));
    messages.push(...searchMessages('channel', matchingChannelIds, q, { limit, fields: { everything: true } })
      .map((m) => ({ ...m, channelName: channelNameById.get(m.scopeId) })));
  }
  const deduped = [...new Map(messages.map((m) => [`${m.scopeType}:${m.id}`, m])).values()]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, Math.min(Number(limit) || 25, 50));
  res.json({ messages: deduped });
});

// Which server members are in a voice channel right now, and where — the initial snapshot for
// the member-list "in a call" indicator; live updates after this arrive over WS as `voice_state`.
// Filtered to voice channels the requester can actually see, same rule as /search above, so this
// never leaks that someone is in a private voice channel the requester has no access to.
router.get('/:id/voice-activity', requireMember, (req, res) => {
  const voiceChannels = db.prepare("SELECT * FROM channels WHERE server_id = ? AND type = 'voice'").all(req.server.id)
    .filter((ch) => has(getChannelPermissionBits(ch, req.user.id), PERMISSIONS.VIEW_CHANNEL));
  const activity = [];
  for (const ch of voiceChannels) {
    for (const userId of voice.participants(ch.id)) activity.push({ userId, channelId: ch.id, channelName: ch.name });
  }
  res.json({ activity });
});

router.patch('/:id', requireMember, requirePerm(PERMISSIONS.MANAGE_SERVER), (req, res) => {
  const { name, description, visibility, autoJoin, welcomeEnabled, welcomeMessage, rawHtmlEnabled, verificationLevel } = req.body || {};
  if (verificationLevel !== undefined && !isLevel(verificationLevel)) return res.status(400).json({ error: 'verificationLevel must be 0, 1, 2 or 3' });
  if (typeof name === 'string' && name.trim()) {
    db.prepare('UPDATE servers SET name = ? WHERE id = ?').run(name.trim().slice(0, 100), req.server.id);
  }
  if (description !== undefined) {
    db.prepare('UPDATE servers SET description = ? WHERE id = ?').run(String(description).slice(0, 500), req.server.id);
  }
  if (visibility !== undefined) {
    if (!VISIBILITIES.has(visibility)) return res.status(400).json({ error: 'visibility must be private or public' });
    db.prepare('UPDATE servers SET visibility = ? WHERE id = ?').run(visibility, req.server.id);
    if (visibility === 'private') db.prepare('UPDATE servers SET auto_join = 0 WHERE id = ?').run(req.server.id);
  }
  if (autoJoin !== undefined) {
    const current = db.prepare('SELECT visibility FROM servers WHERE id = ?').get(req.server.id);
    if (current.visibility === 'public') {
      db.prepare('UPDATE servers SET auto_join = ? WHERE id = ?').run(autoJoin ? 1 : 0, req.server.id);
    }
  }
  if (welcomeEnabled !== undefined) {
    db.prepare('UPDATE servers SET welcome_enabled = ? WHERE id = ?').run(welcomeEnabled ? 1 : 0, req.server.id);
  }
  if (welcomeMessage !== undefined) {
    db.prepare('UPDATE servers SET welcome_message = ? WHERE id = ?').run(singleLine(welcomeMessage, 300), req.server.id);
  }
  if (rawHtmlEnabled !== undefined) {
    db.prepare('UPDATE servers SET raw_html_enabled = ? WHERE id = ?').run(rawHtmlEnabled ? 1 : 0, req.server.id);
  }
  if (verificationLevel !== undefined) {
    db.prepare('UPDATE servers SET verification_level = ? WHERE id = ?').run(verificationLevel, req.server.id);
  }
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.server.id);
  logAudit(req.server.id, req.user.id, 'server_update', 'server', req.server.id, { name, description, visibility, autoJoin, welcomeEnabled, welcomeMessage, rawHtmlEnabled, verificationLevel });
  broadcastToServer(server.id, { type: 'server_update', server });
  if (server.name !== req.server.name) postServerEvent(server.id, 'server_rename', null, { from: req.server.name }, req.user.id);
  res.json({ server });
});

// Welcome-screen highlighted channels — an ordered curated list a new member sees before the
// regular channel list, each row jumping straight into that channel. Position is recomputed as
// 0..n-1 on every add/delete so it stays contiguous without needing fractional slots.
router.post('/:id/welcome-channels', requireMember, requirePerm(PERMISSIONS.MANAGE_SERVER), (req, res) => {
  const { channelId, emoji, description } = req.body || {};
  const channel = db.prepare('SELECT * FROM channels WHERE id = ? AND server_id = ?').get(Number(channelId), req.server.id);
  if (!channel) return res.status(400).json({ error: 'channel not found on this server' });
  const position = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM welcome_channels WHERE server_id = ?').get(req.server.id).pos;
  const info = db.prepare('INSERT INTO welcome_channels (server_id, channel_id, emoji, description, position) VALUES (?, ?, ?, ?, ?)')
    .run(req.server.id, channel.id, singleLine(emoji, 32), singleLine(description, 150), position);
  const welcomeChannel = db.prepare('SELECT * FROM welcome_channels WHERE id = ?').get(info.lastInsertRowid);
  logAudit(req.server.id, req.user.id, 'welcome_channel_add', 'channel', channel.id, { name: channel.name });
  broadcastToServer(req.server.id, { type: 'welcome_channel_add', welcomeChannel });
  res.status(201).json({ welcomeChannel });
});

router.patch('/:id/welcome-channels/:wcId', requireMember, requirePerm(PERMISSIONS.MANAGE_SERVER), (req, res) => {
  const existing = db.prepare('SELECT * FROM welcome_channels WHERE id = ? AND server_id = ?').get(Number(req.params.wcId), req.server.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  const { emoji, description, position } = req.body || {};
  if (emoji !== undefined) db.prepare('UPDATE welcome_channels SET emoji = ? WHERE id = ?').run(singleLine(emoji, 32), existing.id);
  if (description !== undefined) db.prepare('UPDATE welcome_channels SET description = ? WHERE id = ?').run(singleLine(description, 150), existing.id);
  if (position !== undefined) db.prepare('UPDATE welcome_channels SET position = ? WHERE id = ?').run(Number(position) || 0, existing.id);
  const welcomeChannel = db.prepare('SELECT * FROM welcome_channels WHERE id = ?').get(existing.id);
  broadcastToServer(req.server.id, { type: 'welcome_channel_update', welcomeChannel });
  res.json({ welcomeChannel });
});

router.delete('/:id/welcome-channels/:wcId', requireMember, requirePerm(PERMISSIONS.MANAGE_SERVER), (req, res) => {
  const existing = db.prepare('SELECT * FROM welcome_channels WHERE id = ? AND server_id = ?').get(Number(req.params.wcId), req.server.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM welcome_channels WHERE id = ?').run(existing.id);
  logAudit(req.server.id, req.user.id, 'welcome_channel_remove', 'channel', existing.channel_id, {});
  broadcastToServer(req.server.id, { type: 'welcome_channel_remove', serverId: req.server.id, welcomeChannelId: existing.id });
  res.json({ ok: true });
});

const ICON_ALLOWED = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

// Shared shape for both server icons and channel icons: same size cap, same allowed mime types,
// same "<ownerId>-<random>.png" naming — only the destination folder and id source differ.
function makeIconUpload(folder, idFromParams) {
  const storage = multer.diskStorage({
    destination: path.join(DATA_DIR, folder),
    filename: (req, file, cb) => cb(null, `${idFromParams(req)}-${crypto.randomBytes(6).toString('hex')}.png`),
  });
  return multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => cb(null, ICON_ALLOWED.has(file.mimetype)),
  });
}

const uploadIcon = makeIconUpload('servericons', (req) => req.server.id);

router.post('/:id/icon', requireMember, requirePerm(PERMISSIONS.MANAGE_SERVER), uploadIcon.single('icon'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'icon file required' });
  const rel = `/uploads/servericons/${req.file.filename}`;
  db.prepare('UPDATE servers SET icon_path = ? WHERE id = ?').run(rel, req.server.id);
  logAudit(req.server.id, req.user.id, 'server_icon_update', 'server', req.server.id, null);
  broadcastToServer(req.server.id, { type: 'server_update', server: { ...req.server, icon_path: rel } });
  res.json({ iconPath: rel });
});

// Custom emoji — self-hosted (data/emoji/, served from this instance, no third-party emoji CDN).
// Usable in message content as :name: (see textSanitize-free rendering in the client's markdown
// pipeline) and as reaction values, both scoped to this server only.
const EMOJI_NAME_RE = /^[a-zA-Z0-9_]{2,32}$/;
// Unlike makeIconUpload (which always names the file .png — fine for a static server/channel
// icon), an emoji keeps its real extension: GIF and animated WebP need it to actually animate,
// and served Content-Type is decided by extension, not the bytes underneath. A still or animated
// PNG both stay .png — APNG frames within a plain image/png file animate on their own, no special
// handling needed server-side.
const EMOJI_EXT = { 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/jpeg': '.jpg' };
const uploadEmoji = multer({
  storage: multer.diskStorage({
    destination: path.join(DATA_DIR, 'emoji'),
    filename: (req, file, cb) => cb(null, `${req.server.id}-${crypto.randomBytes(6).toString('hex')}${EMOJI_EXT[file.mimetype] || '.png'}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ICON_ALLOWED.has(file.mimetype)),
});

router.post('/:id/emoji', requireMember, requirePerm(PERMISSIONS.MANAGE_SERVER), uploadEmoji.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'image file required' });
  const name = String(req.body?.name || '');
  if (!EMOJI_NAME_RE.test(name)) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'name must be 2-32 chars: letters, numbers, underscore' });
  }
  const existing = db.prepare('SELECT id FROM custom_emoji WHERE server_id = ? AND name = ? COLLATE NOCASE').get(req.server.id, name);
  if (existing) {
    fs.unlink(req.file.path, () => {});
    return res.status(409).json({ error: 'an emoji with that name already exists on this server' });
  }
  const rel = `/uploads/emoji/${req.file.filename}`;
  const info = db.prepare('INSERT INTO custom_emoji (server_id, name, image_path, created_by) VALUES (?, ?, ?, ?)')
    .run(req.server.id, name, rel, req.user.id);
  const emoji = db.prepare('SELECT * FROM custom_emoji WHERE id = ?').get(info.lastInsertRowid);
  logAudit(req.server.id, req.user.id, 'emoji_add', 'emoji', emoji.id, { name });
  broadcastToServer(req.server.id, { type: 'emoji_add', emoji });
  res.status(201).json({ emoji });
});

router.delete('/:id/emoji/:emojiId', requireMember, requirePerm(PERMISSIONS.MANAGE_SERVER), (req, res) => {
  const emoji = db.prepare('SELECT * FROM custom_emoji WHERE id = ? AND server_id = ?').get(Number(req.params.emojiId), req.server.id);
  if (!emoji) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM custom_emoji WHERE id = ?').run(emoji.id);
  const filePath = path.join(DATA_DIR, 'emoji', path.basename(emoji.image_path));
  fs.unlink(filePath, () => {});
  logAudit(req.server.id, req.user.id, 'emoji_remove', 'emoji', emoji.id, { name: emoji.name });
  broadcastToServer(req.server.id, { type: 'emoji_remove', serverId: req.server.id, emojiId: emoji.id });
  res.json({ ok: true });
});

// Stickers — sent as their own thing attached to a message (messages.sticker_id), not typed
// inline like custom emoji, and not usable as a reaction. Same MANAGE_SERVER gate, no separate
// moderation system; createSticker/deleteSticker are shared with the site-admin route in admin.js.
router.post('/:id/stickers', requireMember, requirePerm(PERMISSIONS.MANAGE_SERVER), uploadSticker.single('image'), (req, res) => {
  const result = createSticker({ serverId: req.server.id, name: req.body?.name, description: req.body?.description, file: req.file, userId: req.user.id });
  if (result.error) return res.status(result.status || 400).json({ error: result.error });
  logAudit(req.server.id, req.user.id, 'sticker_add', 'sticker', result.sticker.id, { name: result.sticker.name });
  broadcastToServer(req.server.id, { type: 'sticker_add', sticker: result.sticker });
  res.status(201).json({ sticker: result.sticker });
});

router.delete('/:id/stickers/:stickerId', requireMember, requirePerm(PERMISSIONS.MANAGE_SERVER), (req, res) => {
  const sticker = deleteSticker(req.server.id, Number(req.params.stickerId));
  if (!sticker) return res.status(404).json({ error: 'not found' });
  logAudit(req.server.id, req.user.id, 'sticker_remove', 'sticker', sticker.id, { name: sticker.name });
  broadcastToServer(req.server.id, { type: 'sticker_remove', serverId: req.server.id, stickerId: sticker.id });
  res.json({ ok: true });
});

// Soundboard clips — see server/socket/index.js's voice_soundboard_play for how they're actually
// played (WS broadcast to everyone currently in the voice call, not mixed into anyone's own
// outgoing mic stream). Same MANAGE_SERVER gate, no separate moderation system.
router.post('/:id/sounds', requireMember, requirePerm(PERMISSIONS.MANAGE_SERVER), uploadSound.single('audio'), (req, res) => {
  const result = createSound({ serverId: req.server.id, name: req.body?.name, emoji: req.body?.emoji, file: req.file, userId: req.user.id });
  if (result.error) return res.status(result.status || 400).json({ error: result.error });
  logAudit(req.server.id, req.user.id, 'sound_add', 'sound', result.sound.id, { name: result.sound.name });
  broadcastToServer(req.server.id, { type: 'sound_add', sound: result.sound });
  res.status(201).json({ sound: result.sound });
});

router.delete('/:id/sounds/:soundId', requireMember, requirePerm(PERMISSIONS.MANAGE_SERVER), (req, res) => {
  const sound = deleteSound(req.server.id, Number(req.params.soundId));
  if (!sound) return res.status(404).json({ error: 'not found' });
  logAudit(req.server.id, req.user.id, 'sound_remove', 'sound', sound.id, { name: sound.name });
  broadcastToServer(req.server.id, { type: 'sound_remove', serverId: req.server.id, soundId: sound.id });
  res.json({ ok: true });
});

// Scheduled events — server-wide (not embedded in GET /:id since they're only needed when the
// Events modal is actually opened, unlike emoji/stickers/sounds which the message/composer/voice
// pipelines need on every server load). Creation/editing gated on MANAGE_SERVER, same as Welcome
// Screen — RSVP is open to any member.
function shapeEvent(row, viewerId) {
  const channel = row.channel_id ? db.prepare('SELECT id, name, type FROM channels WHERE id = ?').get(row.channel_id) : null;
  return {
    id: row.id,
    serverId: row.server_id,
    channelId: row.channel_id,
    channelName: channel?.name || null,
    channelType: channel?.type || null,
    name: row.name,
    description: row.description,
    location: row.location,
    startTime: row.start_time,
    endTime: row.end_time,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    rsvpCount: db.prepare('SELECT COUNT(*) AS c FROM event_rsvps WHERE event_id = ?').get(row.id).c,
    amInterested: !!db.prepare('SELECT 1 FROM event_rsvps WHERE event_id = ? AND user_id = ?').get(row.id, viewerId),
  };
}

// Shared create/update validation — {error} on failure, else {name, description, location,
// channelId, startTime, endTime} cleaned and ready to persist. `existing` (an update) makes each
// field optional (only overwrite what's provided); omit it (a create) to require name+startTime
// and the channel-or-location choice.
function validateEventFields(req, body, existing) {
  const out = {};
  if (body.name !== undefined || !existing) {
    const name = String(body.name || '').trim().slice(0, 100);
    if (!name) return { error: 'name is required' };
    out.name = name;
  }
  if (body.description !== undefined) out.description = String(body.description || '').slice(0, 1000);
  if (body.startTime !== undefined || !existing) {
    const start = new Date(body.startTime);
    if (Number.isNaN(start.getTime())) return { error: 'a valid startTime is required' };
    out.startTime = start.toISOString();
  }
  if (body.endTime !== undefined) {
    if (body.endTime === null || body.endTime === '') {
      out.endTime = null;
    } else {
      const end = new Date(body.endTime);
      const startRef = out.startTime || existing?.start_time;
      if (Number.isNaN(end.getTime()) || (startRef && end <= new Date(startRef))) return { error: 'endTime must be a valid time after startTime' };
      out.endTime = end.toISOString();
    }
  }
  if (body.channelId !== undefined || body.location !== undefined) {
    const channelId = body.channelId ? Number(body.channelId) : null;
    if (channelId) {
      const channel = db.prepare('SELECT * FROM channels WHERE id = ? AND server_id = ?').get(channelId, req.server.id);
      if (!channel || (channel.type !== 'voice' && channel.type !== 'stage')) return { error: 'channelId must be a voice or stage channel on this server' };
      out.channelId = channelId;
      out.location = '';
    } else {
      const location = singleLine(body.location, 100);
      if (!location) return { error: 'either channelId or location is required' };
      out.channelId = null;
      out.location = location;
    }
  } else if (!existing) {
    return { error: 'either channelId or location is required' };
  }
  return { fields: out };
}

router.get('/:id/events', requireMember, (req, res) => {
  const rows = db.prepare('SELECT * FROM scheduled_events WHERE server_id = ? ORDER BY start_time ASC').all(req.server.id);
  res.json({ events: rows.map((r) => shapeEvent(r, req.user.id)) });
});

router.post('/:id/events', requireMember, requirePerm(PERMISSIONS.MANAGE_SERVER), (req, res) => {
  const result = validateEventFields(req, req.body || {}, null);
  if (result.error) return res.status(400).json({ error: result.error });
  const f = result.fields;
  const info = db.prepare(
    'INSERT INTO scheduled_events (server_id, channel_id, name, description, location, start_time, end_time, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(req.server.id, f.channelId ?? null, f.name, f.description || '', f.location || '', f.startTime, f.endTime ?? null, req.user.id);
  const event = shapeEvent(db.prepare('SELECT * FROM scheduled_events WHERE id = ?').get(info.lastInsertRowid), req.user.id);
  logAudit(req.server.id, req.user.id, 'event_add', 'event', event.id, { name: event.name });
  // amInterested is per-viewer (computed above for req.user.id, the creator) — strip it from the
  // broadcast so no other client can mistake the creator's own RSVP status for its own. Each
  // client refetches its own copy of the list on this event instead of trusting the payload.
  broadcastToServer(req.server.id, { type: 'event_add', event: { ...event, amInterested: undefined } });
  res.status(201).json({ event });
});

router.patch('/:id/events/:eventId', requireMember, requirePerm(PERMISSIONS.MANAGE_SERVER), (req, res) => {
  const existing = db.prepare('SELECT * FROM scheduled_events WHERE id = ? AND server_id = ?').get(req.params.eventId, req.server.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  const body = req.body || {};
  if (body.status !== undefined) {
    if (!['scheduled', 'cancelled'].includes(body.status)) return res.status(400).json({ error: 'invalid status' });
    db.prepare('UPDATE scheduled_events SET status = ? WHERE id = ?').run(body.status, existing.id);
  }
  const result = validateEventFields(req, body, existing);
  if (result.error) return res.status(400).json({ error: result.error });
  const f = result.fields;
  const updates = []; const params = [];
  for (const [col, key] of [['name', 'name'], ['description', 'description'], ['location', 'location'], ['channel_id', 'channelId'], ['start_time', 'startTime'], ['end_time', 'endTime']]) {
    if (f[key] !== undefined) { updates.push(`${col} = ?`); params.push(f[key]); }
  }
  if (updates.length) {
    params.push(existing.id);
    db.prepare(`UPDATE scheduled_events SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }
  const event = shapeEvent(db.prepare('SELECT * FROM scheduled_events WHERE id = ?').get(existing.id), req.user.id);
  logAudit(req.server.id, req.user.id, 'event_update', 'event', event.id, { name: event.name, status: body.status });
  broadcastToServer(req.server.id, { type: 'event_update', event: { ...event, amInterested: undefined } });
  res.json({ event });
});

router.delete('/:id/events/:eventId', requireMember, requirePerm(PERMISSIONS.MANAGE_SERVER), (req, res) => {
  const existing = db.prepare('SELECT * FROM scheduled_events WHERE id = ? AND server_id = ?').get(req.params.eventId, req.server.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM scheduled_events WHERE id = ?').run(existing.id);
  logAudit(req.server.id, req.user.id, 'event_remove', 'event', existing.id, { name: existing.name });
  broadcastToServer(req.server.id, { type: 'event_remove', serverId: req.server.id, eventId: existing.id });
  res.json({ ok: true });
});

// Broadcasts only the count, never `amInterested` — that field is computed per-viewer in
// shapeEvent, and the two RSVP routes below only ever compute it for the one user who just acted.
// Broadcasting a full shapeEvent() here would show every other member their OWN interest as
// whatever the actor's happened to be, which is wrong for everyone except the actor themselves
// (who already gets their own correct copy back in the direct HTTP response).
function broadcastRsvpCount(server, eventId) {
  const rsvpCount = db.prepare('SELECT COUNT(*) AS c FROM event_rsvps WHERE event_id = ?').get(eventId).c;
  broadcastToServer(server.id, { type: 'event_rsvp_update', eventId, rsvpCount });
}

router.put('/:id/events/:eventId/rsvp', requireMember, (req, res) => {
  const existing = db.prepare('SELECT * FROM scheduled_events WHERE id = ? AND server_id = ?').get(req.params.eventId, req.server.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  db.prepare('INSERT OR IGNORE INTO event_rsvps (event_id, user_id) VALUES (?, ?)').run(existing.id, req.user.id);
  const event = shapeEvent(existing, req.user.id);
  broadcastRsvpCount(req.server, existing.id);
  res.json({ event });
});

router.delete('/:id/events/:eventId/rsvp', requireMember, (req, res) => {
  const existing = db.prepare('SELECT * FROM scheduled_events WHERE id = ? AND server_id = ?').get(req.params.eventId, req.server.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM event_rsvps WHERE event_id = ? AND user_id = ?').run(existing.id, req.user.id);
  const event = shapeEvent(existing, req.user.id);
  broadcastRsvpCount(req.server, existing.id);
  res.json({ event });
});

router.delete('/:id', requireMember, (req, res) => {
  if (req.server.owner_id !== req.user.id) return res.status(403).json({ error: 'only the owner can delete this server' });
  const memberIds = db.prepare('SELECT user_id FROM server_members WHERE server_id = ?').all(req.server.id).map((r) => r.user_id);
  db.prepare('DELETE FROM servers WHERE id = ?').run(req.server.id);
  require('../lib/noteFiles').sweepNoteFiles();
  notifyUserIds(memberIds, { type: 'server_delete', serverId: req.server.id });
  res.json({ ok: true });
});

router.post('/:id/leave', requireMember, (req, res) => {
  if (req.server.owner_id === req.user.id) return res.status(400).json({ error: 'owner cannot leave; delete or transfer the server' });
  removeMember(req.server.id, req.user.id);
  broadcastToServer(req.server.id, { type: 'member_leave', userId: req.user.id, serverId: req.server.id });
  postServerEvent(req.server.id, 'member_leave', req.user.id);
  res.json({ ok: true });
});

router.post('/:id/invite/regenerate', requireMember, requirePerm(PERMISSIONS.MANAGE_SERVER), (req, res) => {
  const code = crypto.randomBytes(6).toString('hex');
  db.prepare('UPDATE servers SET invite_code = ? WHERE id = ?').run(code, req.server.id);
  logAudit(req.server.id, req.user.id, 'invite_regenerate', 'server', req.server.id, null);
  res.json({ inviteCode: code });
});

// ---- Categories ----

// `categoryId` on a channel is either null (renders ungrouped, above the first category) or a
// category belonging to this same server — never trust a bare id across servers.
function validCategoryId(req, categoryId) {
  if (categoryId === null || categoryId === undefined) return null;
  const id = Number(categoryId);
  if (!Number.isInteger(id)) return undefined; // signals "invalid" to the caller
  const row = db.prepare('SELECT id FROM channel_categories WHERE id = ? AND server_id = ?').get(id, req.server.id);
  return row ? id : undefined;
}

router.post('/:id/categories', requireMember, requirePerm(PERMISSIONS.MANAGE_CHANNELS), (req, res) => {
  const { name } = req.body || {};
  if (typeof name !== 'string') return res.status(400).json({ error: 'category name required' });
  const cleanName = singleLine(name, 50);
  if (!cleanName) return res.status(400).json({ error: 'category name required' });
  const maxPos = db.prepare('SELECT MAX(position) AS m FROM channel_categories WHERE server_id = ?').get(req.server.id).m || 0;
  const info = db.prepare('INSERT INTO channel_categories (server_id, name, position) VALUES (?, ?, ?)')
    .run(req.server.id, cleanName, maxPos + 1);
  const category = db.prepare('SELECT * FROM channel_categories WHERE id = ?').get(info.lastInsertRowid);
  logAudit(req.server.id, req.user.id, 'category_create', 'category', category.id, { name: cleanName });
  broadcastToServer(req.server.id, { type: 'category_create', category });
  postServerEvent(req.server.id, 'category_create', null, { category: category.name }, req.user.id);
  res.status(201).json({ category });
});

router.patch('/:id/categories/:categoryId', requireMember, requirePerm(PERMISSIONS.MANAGE_CHANNELS), (req, res) => {
  const category = db.prepare('SELECT * FROM channel_categories WHERE id = ? AND server_id = ?').get(req.params.categoryId, req.server.id);
  if (!category) return res.status(404).json({ error: 'category not found' });
  const { name, position } = req.body || {};
  const updates = []; const params = [];
  if (name !== undefined) {
    const cleanName = singleLine(name, 50);
    if (!cleanName) return res.status(400).json({ error: 'category name cannot be empty' });
    updates.push('name = ?'); params.push(cleanName);
  }
  if (position !== undefined) { updates.push('position = ?'); params.push(Number(position) || 0); }
  if (updates.length) {
    params.push(category.id);
    db.prepare(`UPDATE channel_categories SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }
  const updated = db.prepare('SELECT * FROM channel_categories WHERE id = ?').get(category.id);
  logAudit(req.server.id, req.user.id, 'category_update', 'category', category.id, { name, position });
  broadcastToServer(req.server.id, { type: 'category_update', category: updated });
  if (updated.name !== category.name) postServerEvent(req.server.id, 'category_rename', null, { from: category.name, category: updated.name }, req.user.id);
  res.json({ category: updated });
});

router.delete('/:id/categories/:categoryId', requireMember, requirePerm(PERMISSIONS.MANAGE_CHANNELS), (req, res) => {
  const category = db.prepare('SELECT * FROM channel_categories WHERE id = ? AND server_id = ?').get(req.params.categoryId, req.server.id);
  if (!category) return res.status(404).json({ error: 'category not found' });
  // Member channels just fall back to ungrouped (ON DELETE SET NULL on channels.category_id) —
  // deleting a category is never destructive to the channels inside it.
  db.prepare('DELETE FROM channel_categories WHERE id = ?').run(category.id);
  logAudit(req.server.id, req.user.id, 'category_delete', 'category', category.id, { name: category.name });
  broadcastToServer(req.server.id, { type: 'category_delete', serverId: req.server.id, categoryId: category.id });
  postServerEvent(req.server.id, 'category_delete', null, { category: category.name }, req.user.id);
  res.json({ ok: true });
});

// ---- Channels ----

// Announcement channels list the event types they should NOT log; anything unknown is rejected so a
// typo can't silently disable nothing.
function cleanEventFilter(value) {
  if (!Array.isArray(value) || !value.every((v) => SERVER_EVENT_TYPES.includes(v))) return null;
  return [...new Set(value)];
}

router.post('/:id/channels', requireMember, requirePerm(PERMISSIONS.MANAGE_CHANNELS), (req, res) => {
  const { name, type, topic, categoryId, voiceQuality, nsfw, eventFilter } = req.body || {};
  if (typeof name !== 'string') return res.status(400).json({ error: 'channel name required' });
  const filter = eventFilter === undefined ? [] : cleanEventFilter(eventFilter);
  if (!filter) return res.status(400).json({ error: 'invalid eventFilter' });
  const cleanName = singleLine(name, 80);
  if (!cleanName) return res.status(400).json({ error: 'channel name required' });
  const chType = CHANNEL_TYPES.has(type) ? type : 'public';
  const catId = validCategoryId(req, categoryId);
  if (catId === undefined) return res.status(400).json({ error: 'invalid categoryId' });
  if (voiceQuality !== undefined && !VOICE_QUALITIES.has(voiceQuality)) return res.status(400).json({ error: 'invalid voiceQuality' });
  const maxPos = db.prepare('SELECT MAX(position) AS m FROM channels WHERE server_id = ?').get(req.server.id).m || 0;
  const info = db.prepare('INSERT INTO channels (server_id, name, type, topic, position, category_id, voice_quality, nsfw, event_filter) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.server.id, cleanName, chType, singleLine(topic, 200), maxPos + 1, catId, voiceQuality || DEFAULT_VOICE_QUALITY, nsfw && chType !== 'notes' ? 1 : 0, JSON.stringify(filter));
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(info.lastInsertRowid);
  logAudit(req.server.id, req.user.id, 'channel_create', 'channel', channel.id, { name: cleanName, type: chType });
  broadcastToChannel(channel, { type: 'channel_create', channel });
  postServerEvent(req.server.id, 'channel_create', null, { channel: channel.name }, req.user.id);
  res.status(201).json({ channel });
});

router.patch('/:id/channels/:channelId', requireMember, requirePerm(PERMISSIONS.MANAGE_CHANNELS), (req, res) => {
  const channel = db.prepare('SELECT * FROM channels WHERE id = ? AND server_id = ?').get(req.params.channelId, req.server.id);
  if (!channel) return res.status(404).json({ error: 'channel not found' });
  const { name, type, topic, position, categoryId, voiceQuality, nsfw, eventFilter } = req.body || {};
  if (voiceQuality !== undefined) return res.status(400).json({ error: 'voiceQuality is fixed at channel creation' });
  const updates = []; const params = [];
  if (name !== undefined) { updates.push('name = ?'); params.push(singleLine(name, 80)); }
  if (type !== undefined && CHANNEL_TYPES.has(type)) {
    if (type !== channel.type && (type === 'notes' || channel.type === 'notes')) return res.status(400).json({ error: 'a notes channel cannot be converted to or from another type' });
    updates.push('type = ?'); params.push(type);
  }
  if (topic !== undefined) { updates.push('topic = ?'); params.push(singleLine(topic, 200)); }
  if (nsfw !== undefined) { updates.push('nsfw = ?'); params.push(nsfw && channel.type !== 'notes' ? 1 : 0); }
  if (position !== undefined) { updates.push('position = ?'); params.push(Number(position) || 0); }
  if (eventFilter !== undefined) {
    const filter = cleanEventFilter(eventFilter);
    if (!filter) return res.status(400).json({ error: 'invalid eventFilter' });
    updates.push('event_filter = ?'); params.push(JSON.stringify(filter));
  }
  if (categoryId !== undefined) {
    const catId = validCategoryId(req, categoryId);
    if (catId === undefined) return res.status(400).json({ error: 'invalid categoryId' });
    updates.push('category_id = ?'); params.push(catId);
  }
  if (updates.length) {
    params.push(channel.id);
    db.prepare(`UPDATE channels SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }
  const updated = db.prepare('SELECT * FROM channels WHERE id = ?').get(channel.id);
  logAudit(req.server.id, req.user.id, 'channel_update', 'channel', channel.id, { name, type, topic, position, categoryId, nsfw });
  broadcastToChannel(updated, { type: 'channel_update', channel: updated });
  if (updated.name !== channel.name) postServerEvent(req.server.id, 'channel_rename', null, { from: channel.name, channel: updated.name }, req.user.id);
  if (updated.topic !== channel.topic) postServerEvent(req.server.id, 'channel_topic', null, { channel: updated.name, topic: updated.topic }, req.user.id);
  res.json({ channel: updated });
});

const uploadChannelIcon = makeIconUpload('channelicons', (req) => req.params.channelId);

router.post('/:id/channels/:channelId/icon', requireMember, requirePerm(PERMISSIONS.MANAGE_CHANNELS), uploadChannelIcon.single('icon'), (req, res) => {
  const channel = db.prepare('SELECT * FROM channels WHERE id = ? AND server_id = ?').get(req.params.channelId, req.server.id);
  if (!channel) return res.status(404).json({ error: 'channel not found' });
  if (!req.file) return res.status(400).json({ error: 'icon file required' });
  const rel = `/uploads/channelicons/${req.file.filename}`;
  db.prepare('UPDATE channels SET icon_path = ? WHERE id = ?').run(rel, channel.id);
  const updated = db.prepare('SELECT * FROM channels WHERE id = ?').get(channel.id);
  broadcastToChannel(updated, { type: 'channel_update', channel: updated });
  res.json({ iconPath: rel });
});

// Incoming webhooks — channel-scoped (Manage Channels, not full Manage Server, matches how
// webhooks are a channel-level integration in real Discord too), full token always visible to
// anyone who can manage the channel (not a one-time-reveal secret, same as Discord's own model).
router.get('/:id/channels/:channelId/webhooks', requireMember, requirePerm(PERMISSIONS.MANAGE_CHANNELS), (req, res) => {
  const channel = db.prepare('SELECT * FROM channels WHERE id = ? AND server_id = ?').get(req.params.channelId, req.server.id);
  if (!channel) return res.status(404).json({ error: 'channel not found' });
  const webhooks = db.prepare('SELECT * FROM webhooks WHERE channel_id = ? ORDER BY id ASC').all(channel.id);
  res.json({ webhooks });
});

router.post('/:id/channels/:channelId/webhooks', requireMember, requirePerm(PERMISSIONS.MANAGE_CHANNELS), (req, res) => {
  const channel = db.prepare('SELECT * FROM channels WHERE id = ? AND server_id = ?').get(req.params.channelId, req.server.id);
  if (!channel || channel.type === 'notes') return res.status(404).json({ error: 'channel not found' });
  const result = createWebhook({ channelId: channel.id, serverId: req.server.id, name: req.body?.name, userId: req.user.id });
  if (result.error) return res.status(result.status || 400).json({ error: result.error });
  logAudit(req.server.id, req.user.id, 'webhook_add', 'webhook', result.webhook.id, { name: result.webhook.name, channelName: channel.name });
  res.status(201).json({ webhook: result.webhook });
});

router.post('/:id/channels/:channelId/webhooks/:webhookId/icon', requireMember, requirePerm(PERMISSIONS.MANAGE_CHANNELS), uploadWebhookIcon.single('icon'), (req, res) => {
  const webhook = db.prepare('SELECT * FROM webhooks WHERE id = ? AND channel_id = ?').get(req.params.webhookId, req.params.channelId);
  if (!webhook || webhook.server_id !== req.server.id) return res.status(404).json({ error: 'webhook not found' });
  if (!req.file) return res.status(400).json({ error: 'icon file required' });
  const rel = `/uploads/webhookicons/${req.file.filename}`;
  db.prepare('UPDATE webhooks SET avatar_path = ? WHERE id = ?').run(rel, webhook.id);
  res.json({ avatarPath: rel });
});

router.post('/:id/channels/:channelId/webhooks/:webhookId/regenerate', requireMember, requirePerm(PERMISSIONS.MANAGE_CHANNELS), (req, res) => {
  const existing = db.prepare('SELECT * FROM webhooks WHERE id = ? AND channel_id = ?').get(req.params.webhookId, req.params.channelId);
  if (!existing || existing.server_id !== req.server.id) return res.status(404).json({ error: 'webhook not found' });
  const webhook = regenerateToken(existing.channel_id, existing.id);
  logAudit(req.server.id, req.user.id, 'webhook_regenerate', 'webhook', webhook.id, { name: webhook.name });
  res.json({ webhook });
});

router.delete('/:id/channels/:channelId/webhooks/:webhookId', requireMember, requirePerm(PERMISSIONS.MANAGE_CHANNELS), (req, res) => {
  const existing = db.prepare('SELECT * FROM webhooks WHERE id = ? AND channel_id = ?').get(req.params.webhookId, req.params.channelId);
  if (!existing || existing.server_id !== req.server.id) return res.status(404).json({ error: 'webhook not found' });
  const webhook = deleteWebhook(Number(req.params.channelId), Number(req.params.webhookId));
  logAudit(req.server.id, req.user.id, 'webhook_remove', 'webhook', webhook.id, { name: webhook.name });
  res.json({ ok: true });
});

router.delete('/:id/channels/:channelId', requireMember, requirePerm(PERMISSIONS.MANAGE_CHANNELS), (req, res) => {
  const channel = db.prepare('SELECT * FROM channels WHERE id = ? AND server_id = ?').get(req.params.channelId, req.server.id);
  if (!channel) return res.status(404).json({ error: 'channel not found' });
  db.prepare('DELETE FROM channels WHERE id = ?').run(channel.id);
  if (channel.type === 'notes') require('../lib/noteFiles').sweepNoteFiles();
  logAudit(req.server.id, req.user.id, 'channel_delete', 'channel', channel.id, { name: channel.name });
  broadcastToServer(req.server.id, { type: 'channel_delete', channelId: channel.id, serverId: req.server.id });
  postServerEvent(req.server.id, 'channel_delete', null, { channel: channel.name }, req.user.id);
  res.json({ ok: true });
});

const MAX_SLOWMODE_SECONDS = 6 * 60 * 60; // 6 hours, same ceiling Discord uses

router.put('/:id/channels/:channelId/slowmode', requireMember, requirePerm(PERMISSIONS.MODERATE_MEMBERS), (req, res) => {
  const channel = db.prepare('SELECT * FROM channels WHERE id = ? AND server_id = ?').get(req.params.channelId, req.server.id);
  if (!channel) return res.status(404).json({ error: 'channel not found' });
  const seconds = Math.max(0, Math.min(MAX_SLOWMODE_SECONDS, Number(req.body?.seconds) || 0));
  db.prepare('UPDATE channels SET slowmode_seconds = ? WHERE id = ?').run(seconds, channel.id);
  logAudit(req.server.id, req.user.id, 'channel_slowmode_update', 'channel', channel.id, { seconds });
  const updated = db.prepare('SELECT * FROM channels WHERE id = ?').get(channel.id);
  broadcastToChannel(updated, { type: 'channel_update', channel: updated });
  res.json({ channel: updated });
});

router.put('/:id/channels/:channelId/overrides/:roleId', requireMember, requirePerm(PERMISSIONS.MANAGE_CHANNELS), (req, res) => {
  const channel = db.prepare('SELECT * FROM channels WHERE id = ? AND server_id = ?').get(req.params.channelId, req.server.id);
  const role = db.prepare('SELECT * FROM roles WHERE id = ? AND server_id = ?').get(req.params.roleId, req.server.id);
  if (!channel || !role) return res.status(404).json({ error: 'channel or role not found' });
  const allow = Number(req.body?.allow) || 0;
  const deny = Number(req.body?.deny) || 0;
  // Without this, MANAGE_CHANNELS alone lets a member grant themselves ADMINISTRATOR (or any
  // other bit) scoped to this one channel via `allow`, the same escalation class already fixed
  // for role permission edits.
  if (!assertCanGrant(req, allow)) {
    return res.status(403).json({ error: 'cannot grant permissions you do not hold' });
  }
  db.prepare(
    `INSERT INTO channel_role_overrides (channel_id, role_id, allow, deny) VALUES (?, ?, ?, ?)
     ON CONFLICT(channel_id, role_id) DO UPDATE SET allow = excluded.allow, deny = excluded.deny`
  ).run(channel.id, role.id, allow, deny);
  logAudit(req.server.id, req.user.id, 'channel_overrides_update', 'channel', channel.id, { roleId: role.id, allow, deny });
  res.json({ ok: true });
});

// ---- Roles ----

router.post('/:id/roles', requireMember, requirePerm(PERMISSIONS.MANAGE_ROLES), (req, res) => {
  const { name, color } = req.body || {};
  if (typeof name !== 'string') return res.status(400).json({ error: 'role name required' });
  const cleanName = singleLine(name, 50);
  if (!cleanName) return res.status(400).json({ error: 'role name required' });
  if (color !== undefined && !HEX_COLOR_RE.test(String(color))) {
    return res.status(400).json({ error: 'color must be #rrggbb' });
  }
  const maxPos = db.prepare('SELECT MAX(position) AS m FROM roles WHERE server_id = ?').get(req.server.id).m || 0;
  const info = db.prepare('INSERT INTO roles (server_id, name, color, position) VALUES (?, ?, ?, ?)')
    .run(req.server.id, cleanName, color || '#99aab5', maxPos + 1);
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(info.lastInsertRowid);
  logAudit(req.server.id, req.user.id, 'role_create', 'role', role.id, { name: cleanName });
  broadcastToServer(req.server.id, { type: 'role_create', role });
  postServerEvent(req.server.id, 'role_create', null, { role: role.name }, req.user.id);
  res.status(201).json({ role });
});

router.patch('/:id/roles/:roleId', requireMember, requirePerm(PERMISSIONS.MANAGE_ROLES), (req, res) => {
  const role = db.prepare('SELECT * FROM roles WHERE id = ? AND server_id = ?').get(req.params.roleId, req.server.id);
  if (!role) return res.status(404).json({ error: 'role not found' });
  const { name, color, permissions, position, iconEmoji } = req.body || {};
  if (iconEmoji !== undefined && iconEmoji !== null && iconEmoji !== '' && (typeof iconEmoji !== 'string' || !ROLE_EMOJI_RE.test(iconEmoji))) {
    return res.status(400).json({ error: 'iconEmoji must be a single emoji' });
  }
  if (!assertCanGrant(req, role.permissions)) {
    return res.status(403).json({ error: 'cannot edit a role with permissions you do not hold' });
  }
  if (permissions !== undefined && !assertCanGrant(req, Number(permissions) || 0)) {
    return res.status(403).json({ error: 'cannot grant permissions you do not hold' });
  }
  if (color !== undefined && !HEX_COLOR_RE.test(String(color))) {
    return res.status(400).json({ error: 'color must be #rrggbb' });
  }
  const updates = []; const params = [];
  if (name !== undefined && !role.is_default) { updates.push('name = ?'); params.push(singleLine(name, 50)); }
  if (color !== undefined) { updates.push('color = ?'); params.push(String(color)); }
  if (permissions !== undefined) { updates.push('permissions = ?'); params.push(Number(permissions) || 0); }
  if (position !== undefined && !role.is_default) { updates.push('position = ?'); params.push(Number(position) || 0); }
  if (iconEmoji !== undefined && !role.is_default) {
    updates.push('icon_emoji = ?'); params.push(iconEmoji || null);
    if (iconEmoji) updates.push('icon_path = NULL');
  }
  if (updates.length) {
    params.push(role.id);
    db.prepare(`UPDATE roles SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }
  const updated = db.prepare('SELECT * FROM roles WHERE id = ?').get(role.id);
  logAudit(req.server.id, req.user.id, 'role_update', 'role', role.id, { name, color, permissions, position, iconEmoji });
  broadcastToServer(req.server.id, { type: 'role_update', role: updated });
  res.json({ role: updated });
});

const uploadRoleIcon = makeIconUpload('roleicons', (req) => req.params.roleId);

router.post('/:id/roles/:roleId/icon', requireMember, requirePerm(PERMISSIONS.MANAGE_ROLES), uploadRoleIcon.single('icon'), (req, res) => {
  const role = db.prepare('SELECT * FROM roles WHERE id = ? AND server_id = ?').get(req.params.roleId, req.server.id);
  if (!role || role.is_default) return res.status(404).json({ error: 'role not found' });
  if (!assertCanGrant(req, role.permissions)) return res.status(403).json({ error: 'cannot edit a role with permissions you do not hold' });
  if (!req.file) return res.status(400).json({ error: 'icon file required' });
  const rel = `/uploads/roleicons/${req.file.filename}`;
  db.prepare('UPDATE roles SET icon_path = ?, icon_emoji = NULL WHERE id = ?').run(rel, role.id);
  const updated = db.prepare('SELECT * FROM roles WHERE id = ?').get(role.id);
  logAudit(req.server.id, req.user.id, 'role_update', 'role', role.id, { icon: true });
  broadcastToServer(req.server.id, { type: 'role_update', role: updated });
  res.json({ role: updated });
});

router.delete('/:id/roles/:roleId/icon', requireMember, requirePerm(PERMISSIONS.MANAGE_ROLES), (req, res) => {
  const role = db.prepare('SELECT * FROM roles WHERE id = ? AND server_id = ?').get(req.params.roleId, req.server.id);
  if (!role || role.is_default) return res.status(404).json({ error: 'role not found' });
  if (!assertCanGrant(req, role.permissions)) return res.status(403).json({ error: 'cannot edit a role with permissions you do not hold' });
  db.prepare('UPDATE roles SET icon_path = NULL, icon_emoji = NULL WHERE id = ?').run(role.id);
  const updated = db.prepare('SELECT * FROM roles WHERE id = ?').get(role.id);
  broadcastToServer(req.server.id, { type: 'role_update', role: updated });
  res.json({ role: updated });
});

router.delete('/:id/roles/:roleId', requireMember, requirePerm(PERMISSIONS.MANAGE_ROLES), (req, res) => {
  const role = db.prepare('SELECT * FROM roles WHERE id = ? AND server_id = ?').get(req.params.roleId, req.server.id);
  if (!role) return res.status(404).json({ error: 'role not found' });
  if (role.is_default) return res.status(400).json({ error: 'cannot delete @everyone' });
  if (!assertCanGrant(req, role.permissions)) {
    return res.status(403).json({ error: 'cannot delete a role with permissions you do not hold' });
  }
  db.prepare('DELETE FROM roles WHERE id = ?').run(role.id);
  logAudit(req.server.id, req.user.id, 'role_delete', 'role', role.id, { name: role.name });
  broadcastToServer(req.server.id, { type: 'role_delete', roleId: role.id, serverId: req.server.id });
  postServerEvent(req.server.id, 'role_delete', null, { role: role.name }, req.user.id);
  res.json({ ok: true });
});

router.put('/:id/members/:userId/roles/:roleId', requireMember, requirePerm(PERMISSIONS.MANAGE_ROLES), (req, res) => {
  const target = db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(req.server.id, req.params.userId);
  const role = db.prepare('SELECT * FROM roles WHERE id = ? AND server_id = ?').get(req.params.roleId, req.server.id);
  if (!target || !role) return res.status(404).json({ error: 'member or role not found' });
  if (!assertCanGrant(req, role.permissions)) {
    return res.status(403).json({ error: 'cannot grant a role with permissions you do not hold' });
  }
  db.prepare('INSERT OR IGNORE INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)')
    .run(req.server.id, req.params.userId, role.id);
  logAudit(req.server.id, req.user.id, 'member_role_add', 'user', Number(req.params.userId), { roleId: role.id, roleName: role.name });
  broadcastToServer(req.server.id, { type: 'member_role_update', userId: Number(req.params.userId), serverId: req.server.id });
  postServerEvent(req.server.id, 'member_role_add', Number(req.params.userId), { role: role.name }, req.user.id);
  res.json({ ok: true });
});

router.delete('/:id/members/:userId/roles/:roleId', requireMember, requirePerm(PERMISSIONS.MANAGE_ROLES), (req, res) => {
  const role = db.prepare('SELECT * FROM roles WHERE id = ? AND server_id = ?').get(req.params.roleId, req.server.id);
  if (!role) return res.status(404).json({ error: 'role not found' });
  if (!assertCanGrant(req, role.permissions)) {
    return res.status(403).json({ error: 'cannot remove a role with permissions you do not hold' });
  }
  db.prepare('DELETE FROM member_roles WHERE server_id = ? AND user_id = ? AND role_id = ?')
    .run(req.server.id, req.params.userId, req.params.roleId);
  logAudit(req.server.id, req.user.id, 'member_role_remove', 'user', Number(req.params.userId), { roleId: role.id, roleName: role.name });
  broadcastToServer(req.server.id, { type: 'member_role_update', userId: Number(req.params.userId), serverId: req.server.id });
  postServerEvent(req.server.id, 'member_role_remove', Number(req.params.userId), { role: role.name }, req.user.id);
  res.json({ ok: true });
});

router.patch('/:id/members/:userId/nickname', requireMember, (req, res) => {
  const targetId = Number(req.params.userId);
  const target = db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(req.server.id, targetId);
  if (!target) return res.status(404).json({ error: 'member not found' });

  const bits = getMemberPermissionBits(req.server.id, req.user.id);
  const isSelf = targetId === req.user.id;
  const allowed = isSelf ? has(bits, PERMISSIONS.CHANGE_NICKNAME) : has(bits, PERMISSIONS.MANAGE_NICKNAMES);
  if (!allowed) return res.status(403).json({ error: 'missing permission' });

  const nickname = req.body?.nickname === null || req.body?.nickname === undefined
    ? null
    : singleLine(req.body.nickname, 32) || null;
  db.prepare('UPDATE server_members SET nickname = ? WHERE server_id = ? AND user_id = ?').run(nickname, req.server.id, targetId);
  if (!isSelf) logAudit(req.server.id, req.user.id, 'member_nickname_update', 'user', targetId, { nickname });
  broadcastToServer(req.server.id, { type: 'member_role_update', userId: targetId, serverId: req.server.id });
  res.json({ ok: true });
});

// A per-member override that beats their highest colored role - lets a moderator give an
// individual member a name color without creating (or fighting over membership in) a role just
// for that. Always someone-else-managed, like MANAGE_NICKNAMES's non-self path - there's no
// self-service color, matching how role colors themselves are never self-assignable either.
router.patch('/:id/members/:userId/color', requireMember, requirePerm(PERMISSIONS.MANAGE_NICKNAMES), (req, res) => {
  const targetId = Number(req.params.userId);
  const target = db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(req.server.id, targetId);
  if (!target) return res.status(404).json({ error: 'member not found' });

  const { color } = req.body || {};
  if (color !== null && !HEX_COLOR_RE.test(color || '')) {
    return res.status(400).json({ error: 'color must be a 6-digit hex code (e.g. #f04747) or null' });
  }
  db.prepare('UPDATE server_members SET name_color = ? WHERE server_id = ? AND user_id = ?').run(color, req.server.id, targetId);
  logAudit(req.server.id, req.user.id, 'member_color_update', 'user', targetId, { color });
  broadcastToServer(req.server.id, { type: 'member_role_update', userId: targetId, serverId: req.server.id });
  res.json({ ok: true });
});

router.post('/:id/members/:userId/kick', requireMember, requirePerm(PERMISSIONS.KICK_MEMBERS), (req, res) => {
  const targetId = Number(req.params.userId);
  if (targetId === req.server.owner_id) return res.status(400).json({ error: 'cannot kick the owner' });
  // Holding KICK_MEMBERS shouldn't let a low-privilege member remove someone who outranks them —
  // same ceiling rule used for granting roles/permissions.
  if (!assertCanGrant(req, getMemberPermissionBits(req.server.id, targetId))) {
    return res.status(403).json({ error: 'cannot kick a member with permissions you do not hold' });
  }
  const memberIds = db.prepare('SELECT user_id FROM server_members WHERE server_id = ?').all(req.server.id).map((r) => r.user_id);
  removeMember(req.server.id, targetId);
  logAudit(req.server.id, req.user.id, 'member_kick', 'user', targetId, null);
  notifyUserIds(memberIds, { type: 'member_kick', userId: targetId, serverId: req.server.id });
  postServerEvent(req.server.id, 'member_kick', targetId, {}, req.user.id);
  res.json({ ok: true });
});

router.post('/:id/members/:userId/ban', requireMember, requirePerm(PERMISSIONS.BAN_MEMBERS), (req, res) => {
  const targetId = Number(req.params.userId);
  if (targetId === req.server.owner_id) return res.status(400).json({ error: 'cannot ban the owner' });
  if (!assertCanGrant(req, getMemberPermissionBits(req.server.id, targetId))) {
    return res.status(403).json({ error: 'cannot ban a member with permissions you do not hold' });
  }
  const memberIds = db.prepare('SELECT user_id FROM server_members WHERE server_id = ?').all(req.server.id).map((r) => r.user_id);
  const reason = String(req.body?.reason || '');
  db.prepare('INSERT OR REPLACE INTO server_bans (server_id, user_id, reason, banned_by) VALUES (?, ?, ?, ?)')
    .run(req.server.id, targetId, reason, req.user.id);
  removeMember(req.server.id, targetId);
  logAudit(req.server.id, req.user.id, 'member_ban', 'user', targetId, { reason });
  notifyUserIds(memberIds, { type: 'member_ban', userId: targetId, serverId: req.server.id });
  postServerEvent(req.server.id, 'member_ban', targetId, { reason }, req.user.id);
  res.json({ ok: true });
});

router.delete('/:id/bans/:userId', requireMember, requirePerm(PERMISSIONS.BAN_MEMBERS), (req, res) => {
  db.prepare('DELETE FROM server_bans WHERE server_id = ? AND user_id = ?').run(req.server.id, req.params.userId);
  logAudit(req.server.id, req.user.id, 'member_unban', 'user', Number(req.params.userId), null);
  postServerEvent(req.server.id, 'member_unban', Number(req.params.userId), {}, req.user.id);
  res.json({ ok: true });
});

const MAX_TIMEOUT_MINUTES = 28 * 24 * 60; // 28 days, same ceiling Discord uses

router.put('/:id/members/:userId/timeout', requireMember, requirePerm(PERMISSIONS.MODERATE_MEMBERS), (req, res) => {
  const targetId = Number(req.params.userId);
  const target = db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(req.server.id, targetId);
  if (!target) return res.status(404).json({ error: 'member not found' });
  if (targetId === req.server.owner_id) return res.status(400).json({ error: 'cannot time out the owner' });
  if (!assertCanGrant(req, getMemberPermissionBits(req.server.id, targetId))) {
    return res.status(403).json({ error: 'cannot time out a member with permissions you do not hold' });
  }
  const minutes = Math.max(1, Math.min(MAX_TIMEOUT_MINUTES, Number(req.body?.minutes) || 0));
  if (!minutes) return res.status(400).json({ error: 'minutes required' });
  const until = new Date(Date.now() + minutes * 60_000).toISOString();
  db.prepare('UPDATE server_members SET timeout_until = ? WHERE server_id = ? AND user_id = ?').run(until, req.server.id, targetId);
  logAudit(req.server.id, req.user.id, 'member_timeout', 'user', targetId, { until, minutes });
  broadcastToServer(req.server.id, { type: 'member_role_update', userId: targetId, serverId: req.server.id });
  postServerEvent(req.server.id, 'member_timeout', targetId, { minutes }, req.user.id);
  res.json({ ok: true, timeoutUntil: until });
});

router.delete('/:id/members/:userId/timeout', requireMember, requirePerm(PERMISSIONS.MODERATE_MEMBERS), (req, res) => {
  const targetId = Number(req.params.userId);
  db.prepare('UPDATE server_members SET timeout_until = NULL WHERE server_id = ? AND user_id = ?').run(req.server.id, targetId);
  logAudit(req.server.id, req.user.id, 'member_timeout_clear', 'user', targetId, null);
  postServerEvent(req.server.id, 'member_timeout_clear', targetId, {}, req.user.id);
  broadcastToServer(req.server.id, { type: 'member_role_update', userId: targetId, serverId: req.server.id });
  res.json({ ok: true });
});

// ---- Audit log ----

router.get('/:id/audit-log', requireMember, requirePerm(PERMISSIONS.VIEW_AUDIT_LOG), (req, res) => {
  const before = Number(req.query.before) || null;
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const rows = before
    ? db.prepare('SELECT * FROM audit_log WHERE server_id = ? AND id < ? ORDER BY id DESC LIMIT ?').all(req.server.id, before, limit)
    : db.prepare('SELECT * FROM audit_log WHERE server_id = ? ORDER BY id DESC LIMIT ?').all(req.server.id, limit);
  const actorIds = [...new Set(rows.map((r) => r.actor_id).filter(Boolean))];
  const actors = new Map(
    actorIds.length
      ? db.prepare(`SELECT * FROM users WHERE id IN (${actorIds.map(() => '?').join(',')})`).all(...actorIds).map((u) => [u.id, toPublicUser(u, {})])
      : []
  );
  const entries = rows.map((r) => ({
    id: r.id,
    action: r.action,
    targetType: r.target_type,
    targetId: r.target_id,
    details: r.details ? JSON.parse(r.details) : null,
    createdAt: r.created_at,
    actor: r.actor_id ? actors.get(r.actor_id) || null : null,
  }));
  res.json({ entries });
});

// ---- Data pruning (PRUNE_CONTENT — scoped to this server's own channels only) ----

router.get('/:id/prune/channels', requireMember, requirePerm(PERMISSIONS.PRUNE_CONTENT), (req, res) => {
  const channels = db.prepare("SELECT id, name, type FROM channels WHERE server_id = ? AND type != 'notes' ORDER BY position ASC, id ASC").all(req.server.id);
  res.json({ channels });
});

function parsePruneBody(server, body) {
  if (!body?.cutoff || Number.isNaN(new Date(body.cutoff).getTime())) return { error: 'a valid cutoff date is required' };
  const cutoffAt = new Date(body.cutoff).toISOString();
  const ids = Array.isArray(body.channelIds) ? body.channelIds.map(Number).filter(Number.isInteger) : [];
  if (!ids.length) return { error: 'at least one channel is required' };
  const placeholders = ids.map(() => '?').join(',');
  const owned = db.prepare(`SELECT id FROM channels WHERE server_id = ? AND id IN (${placeholders})`).all(server.id, ...ids);
  if (owned.length !== ids.length) return { error: 'one or more channels do not belong to this server' };
  return { ids, cutoffAt, purgeAttachments: !!body.purgeAttachments };
}

router.post('/:id/prune/preview', requireMember, requirePerm(PERMISSIONS.PRUNE_CONTENT), (req, res) => {
  const parsed = parsePruneBody(req.server, req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const pairs = prune.resolveScopePairs('channels', parsed.ids);
  res.json(prune.previewPrune(pairs, parsed.cutoffAt, parsed.purgeAttachments));
});

router.post('/:id/prune/execute', requireMember, requirePerm(PERMISSIONS.PRUNE_CONTENT), (req, res) => {
  const parsed = parsePruneBody(req.server, req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const notify = req.body?.notify === 'grace' ? 'grace' : 'immediate';
  const result = prune.executePrune({
    scopeKind: 'channels', ids: parsed.ids, cutoffAt: parsed.cutoffAt, purgeAttachments: parsed.purgeAttachments,
    notify, requestedBy: req.user.id, serverId: req.server.id,
  });
  logAudit(req.server.id, req.user.id, notify === 'grace' ? 'data_prune_scheduled' : 'data_prune', 'channels', null,
    { channelIds: parsed.ids, cutoff: parsed.cutoffAt });
  res.json(result);
});

module.exports = router;
