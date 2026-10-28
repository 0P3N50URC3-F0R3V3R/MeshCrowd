'use strict';

const crypto = require('node:crypto');
const { db } = require('../db');

// Cached local row for a remote person. A random, non-guessable local `username`/`email` are
// used since neither is ever addressed directly for a remote user (federated_uid is the real
// key) — but both columns are NOT NULL in the schema and must stay locally unique.
// Peer-supplied profile fields are hostile input: bounded, and avatars limited to the avatar upload
// path shape so a peer cannot point clients at arbitrary same-origin URLs.
function cleanProfile(remoteUser) {
  const username = String(remoteUser.username ?? '').slice(0, 64);
  const displayName = String(remoteUser.displayName ?? username).replace(/[\r\n]+/g, ' ').trim().slice(0, 100) || username;
  const avatarPath = typeof remoteUser.avatarPath === 'string' && /^\/uploads\/avatars\/[\w.-]+$/.test(remoteUser.avatarPath) ? remoteUser.avatarPath : null;
  return { ...remoteUser, username, displayName, avatarPath };
}

function resolveOrCreateRemoteUser(peer, rawRemoteUser) {
  const remoteUser = cleanProfile(rawRemoteUser);
  const federatedUid = `${remoteUser.username}@${peer.domain}`;
  const existing = db.prepare('SELECT * FROM users WHERE federated_uid = ?').get(federatedUid);

  if (existing) {
    db.prepare('UPDATE users SET display_name = ?, avatar_path = ? WHERE id = ?')
      .run(remoteUser.displayName ?? remoteUser.username, remoteUser.avatarPath ?? existing.avatar_path, existing.id);
    return db.prepare('SELECT * FROM users WHERE id = ?').get(existing.id);
  }

  const localUsername = `remote_${crypto.randomBytes(6).toString('hex')}`;
  const info = db.prepare(
    `INSERT INTO users (username, email, password_hash, display_name, avatar_path, home_instance_id, remote_user_id, federated_uid)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    localUsername, `${localUsername}@remote.invalid`, crypto.randomBytes(32).toString('hex'),
    remoteUser.displayName ?? remoteUser.username, remoteUser.avatarPath ?? null,
    peer.id, remoteUser.remoteId, federatedUid,
  );
  return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
}

module.exports = { resolveOrCreateRemoteUser };
