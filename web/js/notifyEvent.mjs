// Pin and thread-start notifications arrive as a normal "notify" payload with kind/actor set.
export function eventNotice(payload, t) {
  if (payload.kind !== 'pin' && payload.kind !== 'thread') return null;
  const name = payload.actor.displayName;
  const m = payload.message;
  let title;
  let body;
  if (payload.kind === 'thread') {
    title = t('shell.notifyThreadStarted', { name });
    body = payload.threadTitle || m.content || '';
  } else {
    title = payload.scopeType === 'dm'
      ? t('shell.notifyPinnedDm', { name })
      : t('shell.notifyPinned', { name, channel: payload.channelName });
    body = m.isEncrypted ? '' : m.content || (m.sticker ? t('sidebar.sentASticker') : '');
  }
  if (payload.scopeType !== 'dm' && payload.serverName) title += ` (${payload.serverName})`;
  return { title, body };
}

// Where a feed/tray entry leads. Thread starts open the thread, pins jump to the pinned message.
export function entryTarget(n) {
  if (n.scopeType === 'dm') return { type: 'dm', dmId: n.scopeId, ...(n.messageId ? { jumpToMessageId: n.messageId } : {}) };
  if (n.scopeType === 'friends') return { type: 'friends', tab: n.scopeId };
  return {
    type: 'server', serverId: n.serverId, channelId: n.scopeId,
    ...(n.threadId ? { threadId: n.threadId } : {}),
    ...(n.messageId ? { jumpToMessageId: n.messageId } : {}),
  };
}
