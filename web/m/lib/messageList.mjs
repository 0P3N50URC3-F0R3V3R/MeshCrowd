// Pure helpers for the loaded window of messages (ascending by id).
export function mergeMessages(list, incoming, deleted) {
  const byId = new Map(list.map((m) => [m.id, m]));
  for (const m of incoming) if (!byId.has(m.id) && !(deleted && deleted.has(m.id))) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

export function applyUpdate(list, message) {
  const i = list.findIndex((m) => m.id === message.id);
  if (i === -1) return list;
  const next = list.slice();
  next[i] = { ...list[i], ...message, ...(message.isEncrypted ? { decryptFailed: undefined } : {}) };
  return next;
}

export function applyDelete(list, id) {
  return list.some((m) => m.id === id) ? list.filter((m) => m.id !== id) : list;
}

export function shouldCompact(prev, cur, windowMs = 5 * 60 * 1000) {
  if (!prev || prev.eventType || cur.eventType) return false;
  if (cur.replyTo || cur.forwardedFrom) return false;
  if (prev.author.id !== cur.author.id) return false;
  return new Date(cur.createdAt) - new Date(prev.createdAt) < windowMs;
}

// After a reconnect: `page` is the freshly fetched (and decrypted) newest page. Edits and deletes
// inside its range replace what we hold; older history is kept; a gap or whole-history page resets.
export function reconcileLatest(list, page, pageSize) {
  if (!page.length || page.length < pageSize) return page;
  const minId = page[0].id;
  if (!list.length || list[list.length - 1].id < minId) return page;
  return [...list.filter((m) => m.id < minId), ...page];
}

// An own message that arrived over the websocket before its HTTP response: drop the pending bubble.
export function dropMatchingPending(pending, message, meId, maxChars = 15000) {
  if (message.author.id !== meId) return pending;
  const i = pending.findIndex((p) => !p.failed && p.text.slice(0, maxChars) === (message.content || ''));
  return i === -1 ? pending : pending.filter((_, j) => j !== i);
}

// A window loaded `around` a message: the server returns up to half a page after it, so fewer
// than that means the window already ends at the newest message.
export function windowReachesLatest(list, aroundId, pageSize) {
  return list.filter((m) => m.id > aroundId).length < Math.floor(pageSize / 2);
}
