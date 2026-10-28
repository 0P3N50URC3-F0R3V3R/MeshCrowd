'use strict';

// Pure WS-connection registry: which sockets belong to which user, right now. Deliberately has
// zero dependencies on db/permissions/publicUser so both socket/hub.js and lib/publicUser.js can
// depend on it without creating a require() cycle between them.

// userId -> Set<WebSocket>
const connections = new Map();

function registerConnection(userId, ws) {
  if (!connections.has(userId)) connections.set(userId, new Set());
  connections.get(userId).add(ws);
}

function unregisterConnection(userId, ws) {
  const set = connections.get(userId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) connections.delete(userId);
}

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function notifyUser(userId, payload) {
  const set = connections.get(userId);
  if (!set) return;
  for (const ws of set) send(ws, payload);
}

function isOnline(userId) {
  return connections.has(userId);
}

function onlineUserIds() {
  return [...connections.keys()];
}

// Force-close every socket a user currently holds (used when an account is disabled).
function disconnectUser(userId, code = 4001, reason = 'account disabled') {
  const set = connections.get(userId);
  if (!set) return;
  for (const ws of [...set]) {
    try { ws.close(code, reason); } catch { /* already closing */ }
  }
}

module.exports = { registerConnection, unregisterConnection, notifyUser, isOnline, onlineUserIds, disconnectUser };
