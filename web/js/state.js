import { bus } from './bus.js';

// Single in-memory store for everything the shell needs across views. Not reactive/proxied —
// mutate via the helpers below, which emit bus events that views subscribe to individually.
export const state = {
  me: null, // current user, camelCase (from toPublicUser)
  config: { maxUploadMb: 25, maxMessageChars: 15000 },

  servers: [], // raw rows: {id, name, icon_path, owner_id, invite_code, created_at}
  remoteServers: [], // ledger of servers owned by paired instances: {peerId, serverId, name, domain, reachable}
  serverDetail: new Map(), // serverId -> {server, channels, roles, members}

  dms: [], // [{id, isGroup, name, members, lastMessage}]

  friends: { friends: [], pending: [], blocked: [] },

  presence: new Map(), // userId -> user (latest known camelCase user incl. status)

  notificationPrefs: new Map(), // "channel:1" | "dm:2" -> 'all'|'mentions'|'mute'

  notificationMuteUntil: new Map(), // same keys -> ISO time a timed mute ends (absent = no expiry)
  userAnnotations: new Map(), // targetUserId -> { note, nickname, ignored } (private to this user)
  dmPrefs: new Map(), // dmId -> { pinned, favorite, hidden }
  bookmarkIds: new Set(), // message ids this user saved
  serverPrefs: new Map(), // serverId -> { notifLevel, mutedUntil, hideMutedChannels, showAllChannels, allowDms }
  readState: new Map(), // "channel:1" | "dm:2" -> last message id this user has read there
  uiPrefs: {}, // /api/users/me/ui-prefs — layout + unread-line preferences (see unreadLine.mjs for defaults)

  view: { type: 'home' }, // {type:'home'} | {type:'dm', dmId} | {type:'server', serverId, channelId} | {type:'friends', tab}
  lastServerId: null, // most recently viewed server id — survives navigating to Home/Friends/DMs, used to scope the activity-panel search

  membersCollapsed: false,

  wsConnected: true, // flips false while the WebSocket is down (see ws.js reconnect logic)

  // Mute/deafen live here (not inside voice.js's own closure) so the persistent user-bar
  // controls work regardless of whether a voice panel happens to be mounted, and so the setting
  // carries over into the next channel joined instead of resetting to unmuted every time.
  voice: { serverId: null, channelId: null, channelName: null, dmId: null, dmName: null, muted: false, deafened: false },

  // Server rail grouping (folders), synced with the server so it's the same on every device —
  // see setServerLayout/serverLayout below.
  serverLayout: [], // [{type:'server', id} | {type:'folder', id, name, color, servers:[serverId,...]}]

  // Right-side "Activity" panel shown on the Home/Friends view (Discord's "Active Now"):
  // recent mentions/DMs/etc (from the same events that already drive notifications) plus which
  // friends are currently in a voice channel.
  activityFeed: [], // [{id, kind:'mention'|'dm'|'channel', title, body, scopeType, scopeId, createdAt}], newest first, capped
  friendVoice: new Map(), // userId -> {id, name, serverId, serverName} | absent if not in voice

  // Who, among the currently-open server's members, is in a (visible-to-me) voice channel right
  // now — drives the small "in a call" indicator in the member list. userId -> channelId.
  serverVoice: new Map(),
};

export function setWsConnected(connected) {
  if (state.wsConnected === connected) return;
  state.wsConnected = connected;
  bus.emit('state:connection', connected);
}

export function setMe(user) {
  state.me = user;
  bus.emit('state:me');
}

export function upsertPresence(user) {
  if (!user) return;
  state.presence.set(user.id, user);
  bus.emit('state:presence', user);
}

export function presenceFor(user) {
  if (!user) return user;
  const live = state.presence.get(user.id);
  // Merge, don't replace: the presence map only ever holds volatile fields from `presence` WS
  // events (status/customStatus*), built with areFriends:false — overwriting the whole object
  // would clobber fields like `bio` that a direct fetch correctly returned for a friend.
  return live ? { ...user, ...live } : user;
}

// Best-effort username/avatar lookup for a userId we don't necessarily have live presence for
// yet (e.g. a typing indicator from someone who hasn't sent a presence event this session).
// Falls back through whatever member lists we currently have loaded.
export function getKnownUser(userId) {
  if (state.presence.has(userId)) return state.presence.get(userId);
  for (const detail of state.serverDetail.values()) {
    const found = detail.members?.find((m) => m.user.id === userId);
    if (found) return found.user;
  }
  for (const dm of state.dms) {
    const found = dm.members?.find((u) => u.id === userId);
    if (found) return found;
  }
  return null;
}

export function setServers(servers) {
  state.servers = servers;
  bus.emit('state:servers');
}

export function setRemoteServers(servers) {
  state.remoteServers = servers;
  bus.emit('state:remoteServers');
}

export function upsertServer(server) {
  const idx = state.servers.findIndex((s) => s.id === server.id);
  if (idx === -1) state.servers.push(server);
  else state.servers[idx] = server;
  const detail = state.serverDetail.get(server.id);
  if (detail) detail.server = server;
  bus.emit('state:servers');
}

export function removeServer(serverId) {
  state.servers = state.servers.filter((s) => s.id !== serverId);
  state.serverDetail.delete(serverId);
  bus.emit('state:servers');
}

export function setServerDetail(serverId, detail) {
  state.serverDetail.set(serverId, detail);
  bus.emit('state:serverDetail', serverId);
}

export function getServerDetail(serverId) {
  return state.serverDetail.get(serverId);
}

// Keeps a channel's last_message_id current in every loaded server's detail even while that
// server's own sidebar isn't mounted (sidebar.js does the same bump, but only while it's the
// visible one) — without this, the global unread badge (tray icon/favicon, see shell.js
// pushUnreadBadge) never notices messages arriving in a server the user isn't currently looking
// at, which defeats the point of a tray badge.
export function noteChannelMessage(channelId, messageId) {
  for (const detail of state.serverDetail.values()) {
    const ch = detail.channels.find((c) => c.id === channelId);
    if (ch) { ch.last_message_id = messageId; return; }
  }
}

export function setDms(dms) {
  state.dms = dms;
  bus.emit('state:dms');
}

export function upsertDmPreview(dmId, message) {
  const dm = state.dms.find((d) => d.id === dmId);
  if (dm) {
    dm.lastMessage = message;
    bus.emit('state:dms');
    return;
  }
  // Unknown DM — a dm_create event should normally arrive first, but don't silently drop the
  // message if it doesn't (e.g. lost the race, or an older server): ask the shell to resync.
  bus.emit('dms:unknownScope', dmId);
}

// Adds a DM conversation the server just told us we were added to (a fresh 1:1 or group DM).
// No-op if we already know about it (e.g. we were the one who created it).
export function upsertDm(dm) {
  if (!dm || state.dms.some((d) => d.id === dm.id)) return;
  state.dms.push(dm);
  bus.emit('state:dms');
}

export function removeDm(dmId) {
  state.dms = state.dms.filter((d) => d.id !== dmId);
  bus.emit('state:dms');
}

export function setFriends(friends) {
  state.friends = friends;
  bus.emit('state:friends');
}

export function setView(view) {
  state.view = view;
  if (view.type === 'server') state.lastServerId = view.serverId;
  bus.emit('state:view', view);
}

export function isSelf(userId) {
  return state.me && state.me.id === userId;
}

// Server-wide notification-sound defaults by presence (per the user's own request): online/idle
// chime, dnd/invisible stay visual-only. `notifySoundMode` ('auto'|'always'|'never') is the
// user's personal override of that default, set alongside their status/custom status.
export function shouldPlayNotifySound() {
  const mode = state.me?.notifySoundMode || 'auto';
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  return state.me?.status === 'online' || state.me?.status === 'idle';
}

export function setNotificationPrefs(prefs) {
  state.notificationPrefs = new Map(prefs.map((p) => [`${p.scopeType}:${p.scopeId}`, p.pref]));
  state.notificationMuteUntil = new Map(prefs.filter((p) => p.mutedUntil).map((p) => [`${p.scopeType}:${p.scopeId}`, p.mutedUntil]));
}

export function setNotificationPref(scopeType, scopeId, pref, mutedUntil = null) {
  const key = `${scopeType}:${scopeId}`;
  state.notificationPrefs.set(key, pref);
  if (mutedUntil) state.notificationMuteUntil.set(key, mutedUntil);
  else state.notificationMuteUntil.delete(key);
  bus.emit('state:notificationPrefs', key);
}

// A timed mute that has run out no longer counts.
export function isScopeMuted(scopeType, scopeId) {
  const key = `${scopeType}:${scopeId}`;
  if (state.notificationPrefs.get(key) !== 'mute') return false;
  const until = state.notificationMuteUntil.get(key);
  return !until || Date.parse(until) > Date.now();
}

export function setUserAnnotations(rows) {
  state.userAnnotations = new Map(rows.map((r) => [r.targetId, r]));
}

export function setUserAnnotation(a) {
  if (!a.note && !a.nickname && !a.ignored) state.userAnnotations.delete(a.targetId);
  else state.userAnnotations.set(a.targetId, a);
  bus.emit('state:annotations', a.targetId);
}

export function annotationFor(userId) {
  return state.userAnnotations.get(userId) || null;
}

// What this viewer calls someone: their private nickname if they set one, else the display name.
export function nameFor(user) {
  return annotationFor(user?.id)?.nickname || user?.displayName || '';
}

export function isIgnored(userId) {
  return !!annotationFor(userId)?.ignored;
}

export function setDmPrefs(rows) {
  state.dmPrefs = new Map(rows.map((r) => [r.dmId, r]));
}

export function setDmPref(pref) {
  state.dmPrefs.set(pref.dmId, pref);
  bus.emit('state:dms');
}

export function dmPrefFor(dmId) {
  return state.dmPrefs.get(dmId) || { dmId, pinned: false, favorite: false, hidden: false };
}

export function setBookmarkIds(ids) {
  state.bookmarkIds = new Set(ids);
}

// Mirrors the server-side default in lib/notifications.js: unmuted channels only alert on an
// @mention, DMs alert on everything, until the user overrides it.
export function notificationPrefFor(scopeType, scopeId) {
  const own = state.notificationPrefs.get(`${scopeType}:${scopeId}`);
  if (own === 'mute' && !isScopeMuted(scopeType, scopeId)) return scopeType === 'dm' ? 'all' : 'mentions';
  return own || (scopeType === 'dm' ? 'all' : 'mentions');
}

const DEFAULT_SERVER_PREF = { notifLevel: null, mutedUntil: null, hideMutedChannels: false, showAllChannels: true, allowDms: true };

export function setServerPrefs(rows) {
  state.serverPrefs = new Map(rows.map((r) => [r.serverId, r]));
}

export function serverPrefFor(serverId) {
  return state.serverPrefs.get(serverId) || { ...DEFAULT_SERVER_PREF, serverId };
}

export function setServerPref(pref) {
  state.serverPrefs.set(pref.serverId, pref);
  bus.emit('state:serverPrefs', pref.serverId);
}

export function isServerMuted(serverId) {
  const until = serverPrefFor(serverId).mutedUntil;
  return !!until && Date.parse(until) > Date.now();
}

// Mirrors lib/serverPrefs.js resolveChannelPref so the sidebar can tell which channels are muted.
export function isChannelMuted(serverId, channelId) {
  if (isServerMuted(serverId)) return true;
  const own = state.notificationPrefs.get(`channel:${channelId}`);
  return (own || serverPrefFor(serverId).notifLevel) === 'mute';
}

// Unlike setReadState this may move the pointer backwards ("mark as unread from here").
export function forceReadState(scopeType, scopeId, messageId) {
  const key = `${scopeType}:${scopeId}`;
  state.readState.set(key, messageId);
  bus.emit('state:readState', key);
}

export function setReadStateBulk(rows) {
  state.readState = new Map(rows.map((r) => [`${r.scopeType}:${r.scopeId}`, r.lastReadMessageId]));
}

// Only advances forward — a stale response landing after a newer local mark-as-read must never
// roll the pointer back and make something unread again.
export function setReadState(scopeType, scopeId, messageId) {
  const key = `${scopeType}:${scopeId}`;
  if ((state.readState.get(key) || 0) >= messageId) return;
  state.readState.set(key, messageId);
  bus.emit('state:readState', key);
}

export function isUnread(scopeType, scopeId, lastMessageId) {
  if (!lastMessageId) return false;
  return (state.readState.get(`${scopeType}:${scopeId}`) || 0) < lastMessageId;
}

// Feeds the tray/favicon badge (see shell.js pushUnreadBadge). Approximate in the same way the
// server-rail unread dot already is (serverRail.js): a channel only counts once its server's
// detail has been fetched this session (no upfront fetch-every-joined-server just for a badge).
export function getGlobalUnreadCount() {
  let count = 0;
  for (const dm of state.dms) {
    if (isUnread('dm', dm.id, dm.lastMessage?.id)) count++;
  }
  for (const detail of state.serverDetail.values()) {
    for (const ch of detail.channels) {
      if (isUnread('channel', ch.id, ch.last_message_id)) count++;
    }
  }
  count += state.friends.pending.filter((f) => f.direction === 'incoming').length;
  return count;
}

export function setVoiceState(patch) {
  Object.assign(state.voice, patch);
  bus.emit('state:voice');
}

export function setServerLayout(layout) {
  state.serverLayout = layout || [];
  bus.emit('state:serverLayout');
}

const ACTIVITY_FEED_CAP = 30;
export function pushActivity(item) {
  state.activityFeed.unshift({ id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, createdAt: new Date().toISOString(), ...item });
  if (state.activityFeed.length > ACTIVITY_FEED_CAP) state.activityFeed.length = ACTIVITY_FEED_CAP;
  bus.emit('state:activity');
}

export function setFriendVoice(userId, channel) {
  if (channel) state.friendVoice.set(userId, channel);
  else state.friendVoice.delete(userId);
  bus.emit('state:friendVoice');
}

export function setFriendVoiceBulk(entries) {
  state.friendVoice = new Map(entries.map((e) => [e.userId, e.channel]));
  bus.emit('state:friendVoice');
}

export function setServerVoiceBulk(entries) {
  state.serverVoice = new Map(entries.map((e) => [e.userId, e.channelId]));
  bus.emit('state:serverVoice');
}

// Reconciles one channel's participant roster into the flat serverVoice map: anyone previously
// mapped to this channel who isn't in the new list left it; everyone in the new list is in it.
export function applyServerVoiceState(channelId, participantIds) {
  for (const [userId, chId] of state.serverVoice) {
    if (chId === channelId && !participantIds.includes(userId)) state.serverVoice.delete(userId);
  }
  for (const userId of participantIds) state.serverVoice.set(userId, channelId);
  bus.emit('state:serverVoice');
}
