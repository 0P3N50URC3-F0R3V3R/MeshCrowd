'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { pairKey, getFriendship } = require('../lib/friends');
const { toPublicUser } = require('../lib/publicUser');
const { notifyUser } = require('../socket/hub');
const voice = require('../socket/voice');
const { resolveOrCreateRemoteUser } = require('../lib/federationUsers');
const { isFederatedTarget, sendFriendRequestEvent, sendFriendAcceptEvent, sendFriendRemoveEvent } = require('../lib/federationFriendsOutbound');

// A cached remote-user row's real username on its home instance, recovered from federated_uid
// (`username@domain`) — the local `username` column holds an unrelated random placeholder.
function remoteUsernameOf(user) {
  return user.federated_uid.slice(0, user.federated_uid.lastIndexOf('@'));
}

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const rows = db.prepare(
    `SELECT * FROM friendships WHERE user_a = ? OR user_b = ?`
  ).all(req.user.id, req.user.id);

  const shape = (f) => {
    const otherId = f.user_a === req.user.id ? f.user_b : f.user_a;
    const other = db.prepare('SELECT * FROM users WHERE id = ?').get(otherId);
    return {
      status: f.status,
      direction: f.requested_by === req.user.id ? 'outgoing' : 'incoming',
      user: toPublicUser(other, { viewerIsSelf: false, areFriends: f.status === 'accepted' }),
    };
  };

  res.json({
    friends: rows.filter((f) => f.status === 'accepted').map(shape),
    pending: rows.filter((f) => f.status === 'pending').map(shape),
    blocked: rows.filter((f) => f.status === 'blocked' && f.requested_by === req.user.id).map(shape),
  });
});

router.post('/request', requireAuth, (req, res) => {
  const { username } = req.body || {};
  if (typeof username !== 'string') return res.status(400).json({ error: 'username required' });

  const federated = isFederatedTarget(username);
  if (federated) {
    // A local pending row (requested_by us) is what lets friend_accept later prove we asked.
    const peerRow = db.prepare('SELECT * FROM federation_peers WHERE id = ?').get(federated.peerId);
    const remote = resolveOrCreateRemoteUser(peerRow, { remoteId: null, username: federated.username, displayName: federated.username });
    const [fa, fb] = pairKey(req.user.id, remote.id);
    db.prepare(`INSERT OR IGNORE INTO friendships (user_a, user_b, status, requested_by) VALUES (?, ?, 'pending', ?)`).run(fa, fb, req.user.id);
    sendFriendRequestEvent(federated.peerId, { fromRemoteId: req.user.id, fromUsername: req.user.username, toUsername: federated.username });
    return res.status(202).json({ ok: true, pending: 'federated' });
  }

  const target = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
  // The reserved webhook-messages placeholder account (db/index.js WEBHOOK_SYSTEM_USER_ID) is a
  // real row in this table with a guessable, documented username — without this it can be sent a
  // friend request that then sits pending forever, since nothing can ever log in as it to respond.
  if (!target || target.username === '__webhook__' || target.is_bot) return res.status(404).json({ error: 'user not found' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'cannot friend yourself' });

  const existing = getFriendship(req.user.id, target.id);
  if (existing) {
    // A block is deliberately indistinguishable from "user not found" — don't confirm to the
    // sender that they've been blocked.
    if (existing.status === 'blocked') return res.status(404).json({ error: 'user not found' });
    if (existing.status === 'accepted') return res.status(409).json({ error: 'already friends' });
    return res.status(409).json({ error: 'request already pending' });
  }

  const [a, b] = pairKey(req.user.id, target.id);
  db.prepare('INSERT INTO friendships (user_a, user_b, status, requested_by) VALUES (?, ?, ?, ?)')
    .run(a, b, 'pending', req.user.id);
  notifyUser(target.id, { type: 'friend_request', from: toPublicUser(req.user, { viewerIsSelf: false }) });
  res.status(201).json({ ok: true });
});

router.post('/:userId/accept', requireAuth, (req, res) => {
  const otherId = Number(req.params.userId);
  const f = getFriendship(req.user.id, otherId);
  if (!f || f.status !== 'pending' || f.requested_by === req.user.id) {
    return res.status(404).json({ error: 'no pending request from this user' });
  }
  const [a, b] = pairKey(req.user.id, otherId);
  db.prepare("UPDATE friendships SET status = ?, accepted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_a = ? AND user_b = ?").run('accepted', a, b);

  const other = db.prepare('SELECT * FROM users WHERE id = ?').get(otherId);
  if (other.home_instance_id) {
    sendFriendAcceptEvent(other.home_instance_id, { fromRemoteId: req.user.id, fromUsername: req.user.username, toUsername: remoteUsernameOf(other) });
  } else {
    notifyUser(otherId, { type: 'friend_accept', by: toPublicUser(req.user, { viewerIsSelf: false }) });
  }
  res.json({ ok: true });
});

router.post('/:userId/block', requireAuth, (req, res) => {
  const otherId = Number(req.params.userId);
  if (!Number.isInteger(otherId)) return res.status(400).json({ error: 'invalid user id' });
  if (otherId === req.user.id) return res.status(400).json({ error: 'cannot block yourself' });
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(otherId);
  if (!target) return res.status(404).json({ error: 'user not found' });
  const [a, b] = pairKey(req.user.id, otherId);
  const existing = getFriendship(req.user.id, otherId);
  if (existing) {
    // Already blocked by the other side — leave requested_by pointing at them. Otherwise the
    // side that blocks second silently steals ownership and could unilaterally unblock later.
    if (existing.status === 'blocked') return res.json({ ok: true });
    db.prepare('UPDATE friendships SET status = ?, requested_by = ? WHERE user_a = ? AND user_b = ?')
      .run('blocked', req.user.id, a, b);
  } else {
    db.prepare('INSERT INTO friendships (user_a, user_b, status, requested_by) VALUES (?, ?, ?, ?)')
      .run(a, b, 'blocked', req.user.id);
  }
  res.json({ ok: true });
});

router.delete('/:userId', requireAuth, (req, res) => {
  const otherId = Number(req.params.userId);
  const existing = getFriendship(req.user.id, otherId);
  if (!existing) return res.json({ ok: true });
  // Only the party who set a block can lift it — the blocked party can't unilaterally clear it.
  if (existing.status === 'blocked' && existing.requested_by !== req.user.id) {
    return res.status(403).json({ error: 'you cannot remove this' });
  }
  const [a, b] = pairKey(req.user.id, otherId);
  db.prepare('DELETE FROM friendships WHERE user_a = ? AND user_b = ?').run(a, b);

  const other = db.prepare('SELECT * FROM users WHERE id = ?').get(otherId);
  if (other.home_instance_id) {
    sendFriendRemoveEvent(other.home_instance_id, { fromRemoteId: req.user.id, fromUsername: req.user.username, toUsername: remoteUsernameOf(other) });
  }
  res.json({ ok: true });
});

// Which of my friends are in a voice channel right now, and where — the initial snapshot for the
// activity feed; live updates after this arrive over WS as `friend_voice`.
router.get('/activity/voice', requireAuth, (req, res) => {
  const friendRows = db.prepare(
    `SELECT user_a, user_b FROM friendships WHERE (user_a = ? OR user_b = ?) AND status = 'accepted'`
  ).all(req.user.id, req.user.id);
  const friendIds = friendRows.map((f) => (f.user_a === req.user.id ? f.user_b : f.user_a));
  const activeMap = voice.activeChannelFor(friendIds);

  const activity = [...activeMap.entries()].map(([userId, channelId]) => {
    const channel = db.prepare('SELECT id, name, server_id FROM channels WHERE id = ?').get(channelId);
    if (!channel) return null;
    const server = db.prepare('SELECT id, name FROM servers WHERE id = ?').get(channel.server_id);
    return { userId, channel: { id: channel.id, name: channel.name, serverId: server?.id, serverName: server?.name } };
  }).filter(Boolean);

  res.json({ activity });
});

module.exports = router;
