'use strict';

// Pure decision logic for the tray's notification state (no Electron API), so it can be tested standalone.
const scopeKey = (n) => `${n.scopeType}:${n.scopeId}`;

function pruneRecent(recent, keys) {
  const cleared = new Set(keys);
  return recent.filter((n) => !cleared.has(scopeKey(n)));
}

// Focusing the window with nothing unread means whatever the tray's "Recent" list holds was seen.
function clearRecentOnFocus(unreadCount) {
  return !(unreadCount > 0);
}

module.exports = { scopeKey, pruneRecent, clearRecentOnFocus };
