export const notifyKey = (n) => `${n.scopeType}:${n.scopeId}`;

// `status(key)` is 'unread' | 'read' | 'unknown'. Pending notifications are dismissed once the user
// is looking at their scope, once that scope is no longer unread, or when nothing is unread at all.
export function keysToClear(pendingKeys, { globalCount, focused, isViewing, status }) {
  const out = [];
  for (const key of pendingKeys) {
    if (globalCount === 0 || (focused && isViewing(key)) || status(key) === 'read') out.push(key);
  }
  return out;
}
