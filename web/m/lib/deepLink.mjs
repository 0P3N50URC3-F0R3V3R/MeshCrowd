// `#open=...` links come from Android notifications (and could come from shared links later).
const SHAPES = {
  dm: (n) => (n.length === 1 || n.length === 2 ? { kind: 'dm', dmId: n[0], jumpToMessageId: n[1] } : null),
  channel: (n) => (n.length === 2 || n.length === 3 ? { kind: 'channel', serverId: n[0], channelId: n[1], jumpToMessageId: n[2] } : null),
  thread: (n) => (n.length === 3 || n.length === 4 ? { kind: 'thread', serverId: n[0], channelId: n[1], threadId: n[2], jumpToMessageId: n[3] } : null),
};

export function parseDeepLink(hash) {
  const m = /^#open=([a-z]+):(\d+(?::\d+)*)$/.exec(hash || '');
  if (!m || !SHAPES[m[1]]) return null;
  return SHAPES[m[1]](m[2].split(':').map(Number));
}
