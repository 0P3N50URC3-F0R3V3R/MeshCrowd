export const UNREAD_DEFAULTS = { unreadLine: 'on', unreadJump: 'firstUnread', unreadContext: 5, initialMessages: 50 };

export function unreadPrefs(uiPrefs) {
  return { ...UNREAD_DEFAULTS, ...(uiPrefs || {}) };
}

// Index of the first message after the read pointer that someone else wrote — the line goes above it.
export function firstUnreadIndex(messages, afterId, isOwn) {
  if (!(afterId > 0)) return -1;
  return messages.findIndex((m) => m.id > afterId && !m.pending && !m.eventType && !isOwn(m));
}

// Which message to scroll to the top of the view so `context` messages stay visible above the line.
export function anchorIndex(dividerIndex, context) {
  return Math.max(0, dividerIndex - context);
}
