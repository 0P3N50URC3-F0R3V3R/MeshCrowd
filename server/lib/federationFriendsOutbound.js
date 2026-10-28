'use strict';

const { db } = require('../db');
const { enqueueEvent } = require('./federationOutbox');

function isFederatedTarget(usernameInput) {
  const at = usernameInput.indexOf('@');
  if (at === -1) return null;
  const username = usernameInput.slice(0, at);
  const domain = usernameInput.slice(at + 1);
  const peer = db.prepare(`SELECT id FROM federation_peers WHERE domain = ? AND status = 'active'`).get(domain);
  if (!peer) return null;
  return { username, domain, peerId: peer.id };
}

function sendFriendRequestEvent(peerId, { fromRemoteId, fromUsername, toUsername }) {
  enqueueEvent(peerId, 'friend_request', { fromRemoteId, fromUsername, toUsername });
}
function sendFriendAcceptEvent(peerId, { fromRemoteId, fromUsername, toUsername }) {
  enqueueEvent(peerId, 'friend_accept', { fromRemoteId, fromUsername, toUsername });
}
function sendFriendRemoveEvent(peerId, { fromRemoteId, fromUsername, toUsername }) {
  enqueueEvent(peerId, 'friend_remove', { fromRemoteId, fromUsername, toUsername });
}

module.exports = { isFederatedTarget, sendFriendRequestEvent, sendFriendAcceptEvent, sendFriendRemoveEvent };
