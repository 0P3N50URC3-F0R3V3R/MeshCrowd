export const UNREAD_DEFAULTS = { unreadLine: 'on', unreadAlways: 'off', unreadJump: 'firstUnread', unreadContext: 5, initialMessages: 50 };

export function unreadPrefs(uiPrefs) {
  return { ...UNREAD_DEFAULTS, ...(uiPrefs || {}) };
}

import { wasOffline } from './offlineLog.mjs';

// Which unread messages may carry the line: only those present when the chat opened (upToId — live
// arrivals while in view never do) and, unless the user opted in to always, only ones that arrived
// while this device had no connection.
export function unreadEligible({ upToId, always, windows }) {
  return (m) => m.id <= upToId && (always || wasOffline(windows, Date.parse(m.createdAt)));
}

// Index of the first message after the read pointer that someone else wrote — the line goes above it.
export function firstUnreadIndex(messages, afterId, isOwn, eligible = () => true) {
  if (!(afterId > 0)) return -1;
  return messages.findIndex((m) => m.id > afterId && !m.pending && !m.eventType && !isOwn(m) && eligible(m));
}

export function unreadCount(messages, afterId, isOwn, eligible = () => true) {
  return messages.filter((m) => m.id > afterId && !m.pending && !m.eventType && !isOwn(m) && eligible(m)).length;
}

// Which message to scroll to the top of the view so `context` messages stay visible above the line.
export function anchorIndex(dividerIndex, context) {
  return Math.max(0, dividerIndex - context);
}
