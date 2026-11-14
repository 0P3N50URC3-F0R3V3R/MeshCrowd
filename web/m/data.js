import { api } from '../js/api.js';
import { serverEventText } from '../js/eventText.js';
import { bus } from '../js/bus.js';
import { ws } from '../js/ws.js';
import { applyTheme } from '../js/theme.js';
import { wireUserSync } from '../js/userSync.js';
import { t } from '../js/i18n.js';
import { toast } from '../js/utils.js';
import { readDetail, writeDetail } from './lib/stateCache.js';
import { notifySound } from '../js/notifySound.js';
import { eventNotice } from '../js/notifyEvent.mjs';
import { refreshRemoteServers } from '../js/views/remoteServer.js';
import {
  state, setServers, setDms, setFriends, setNotificationPrefs, setServerPrefs, setUserAnnotations, setDmPrefs, setBookmarkIds,
  setReadStateBulk, setServerLayout, setServerDetail, getServerDetail, upsertServer, removeServer, upsertDm, updateDm, removeDm,
  upsertDmPreview, noteChannelMessage, setDmPref, dmPrefFor, upsertPresence, setWsConnected, pushActivity,
  shouldPlayNotifySound, isSelf, applyDmRead, setReadState, setServerVoiceBulk, applyServerVoiceState,
} from '../js/state.js';

// The lists the app needs before it can draw anything. Fetched together, and also kept as a snapshot
// (lib/stateCache.js) so the next launch can draw them before the network answers.
export function fetchAll() {
  return Promise.all([
    api.listServers(), api.listDms(), api.friends(), api.getNotificationPrefs(), api.config(), api.getReadState(), api.getServerLayout(), api.getTheme(),
    api.getServerPrefs(), api.getUserAnnotations(), api.getDmPrefs(), api.getBookmarkIds(), api.getUiPrefs(),
  ]);
}

export function applyAll(data) {
  const [serversRes, dmsRes, friendsRes, prefsRes, config, readStateRes, layoutRes, themeRes, serverPrefsRes, annotationsRes, dmPrefsRes, bookmarkIdsRes, uiPrefsRes] = data;
  state.uiPrefs = uiPrefsRes.uiPrefs;
  setServers(serversRes.servers);
  setDms(dmsRes.dms);
  setFriends(friendsRes);
  setNotificationPrefs(prefsRes.prefs);
  setServerPrefs(serverPrefsRes.prefs);
  setUserAnnotations(annotationsRes.annotations);
  setDmPrefs(dmPrefsRes.prefs);
  setBookmarkIds(bookmarkIdsRes.ids);
  Object.assign(state.config, config);
  setReadStateBulk(readStateRes.state, readStateRes.pinsUnseen, readStateRes.threadsUnread);
  setServerLayout(layoutRes.layout);
  applyTheme(themeRes.theme);
  if (config.federationEnabled) refreshRemoteServers();
}

// `prefetched` is a fetchAll() already in flight (started alongside api.me()); otherwise fetch now.
// Resolves to the raw data, or null when it could not be loaded.
export async function loadAll(prefetched) {
  try {
    const data = await (prefetched || fetchAll());
    applyAll(data);
    return data;
  } catch (err) {
    if (err && err.status === 401) { bus.emit('m:unauthorized'); return null; }
    toast(t('m.loadFailed'), { type: 'error' });
    return null;
  }
}

export async function ensureServerDetail(serverId) {
  let detail = getServerDetail(serverId);
  if (!detail) {
    const key = `${state.me.id}:${serverId}`;
    try {
      detail = await api.getServer(serverId);
      writeDetail(key, detail);
    } catch (err) {
      // No network (a fetch TypeError, not an HTTP answer): fall back to the copy from the last visit.
      if (err && err.status) throw err;
      detail = await readDetail(key);
      if (!detail) throw err;
    }
    setServerDetail(serverId, detail);
    api.serverVoiceActivity(serverId).then((res) => setServerVoiceBulk(res.activity)).catch(() => {});
  }
  return detail;
}

export async function refreshServerDetailSilently(serverId) {
  try { setServerDetail(serverId, await api.getServer(serverId)); } catch { /* likely lost access */ }
}

async function resync() {
  try {
    const [s, d, f, r] = await Promise.all([api.listServers(), api.listDms(), api.friends(), api.getReadState()]);
    setServers(s.servers); setDms(d.dms); setFriends(f); setReadStateBulk(r.state, r.pinsUnseen, r.threadsUnread);
    api.config().then((c) => Object.assign(state.config, c)).catch(() => {});
    for (const id of [...state.serverDetail.keys()]) refreshServerDetailSilently(id);
  } catch (err) { if (err && err.status === 401) bus.emit('m:unauthorized'); }
}

function notifyBody(payload) {
  const m = payload.message;
  return (m.eventType && serverEventText(m)) || m.content || (m.sticker ? t('m.dmPreviewSticker') : '') || (m.attachments?.length ? t('m.dmPreviewAttachment') : '');
}

export function wireRealtime() {
  wireUserSync({ refreshServerDetail: refreshServerDetailSilently });
  let connectedOnce = false;
  // If the websocket cannot come back because the session is gone, no API call would notice until
  // the user did something; probe while disconnected so the app returns to sign-in on its own.
  let authProbe = null;
  bus.on('ws:open', () => { clearInterval(authProbe); setWsConnected(true); if (connectedOnce) resync(); connectedOnce = true; });
  bus.on('ws:close', () => {
    setWsConnected(false);
    clearInterval(authProbe);
    authProbe = setInterval(async () => {
      try { await api.me(); } catch (err) { if (err && err.status === 401) bus.emit('m:unauthorized'); }
    }, 10000);
  });
  // The red banner waits a moment: coming back from the background the socket is usually mid-reconnect,
  // and flashing "offline" for those seconds only hides that the data is being refreshed.
  let bannerTimer = null;
  bus.on('state:connection', (ok) => {
    clearTimeout(bannerTimer);
    const el = document.getElementById('m-conn');
    if (ok) { el?.classList.add('hidden'); return; }
    bannerTimer = setTimeout(() => document.getElementById('m-conn')?.classList.remove('hidden'), 6000);
  });

  bus.on('ws:message_create', ({ message }) => {
    if (isSelf(message.author?.id) && (message.scopeType === 'dm' || message.scopeType === 'channel')) {
      setReadState(message.scopeType, message.scopeId, message.id);
      api.markRead(message.scopeType, message.scopeId, message.id).catch(() => {});
    }
    if (message.scopeType === 'dm') {
      if (dmPrefFor(message.scopeId).hidden) setDmPref({ ...dmPrefFor(message.scopeId), hidden: false });
      upsertDmPreview(message.scopeId, message);
    } else if (message.scopeType === 'channel') {
      noteChannelMessage(message.scopeId, message.id);
    }
  });
  bus.on('ws:notify', (payload) => {
    if (shouldPlayNotifySound(payload.gridEvent) && (document.hidden || !state.mOpenScope || state.mOpenScope !== `${payload.scopeType}:${payload.scopeId}`)) notifySound.play();
    const author = payload.message.author;
    const notice = eventNotice(payload, t);
    const title = notice ? notice.title : payload.scopeType === 'dm'
      ? author.displayName
      : `${author.displayName} #${payload.channelName}${payload.serverName ? ` (${payload.serverName})` : ''}`;
    if (!document.hidden && state.mOpenScope === `${payload.scopeType}:${payload.scopeId}`) return;
    pushActivity({
      kind: notice ? payload.kind : payload.scopeType === 'dm' ? 'dm' : (payload.mentioned ? 'mention' : 'channel'),
      title, body: notice ? notice.body : notifyBody(payload),
      scopeType: payload.scopeType, scopeId: payload.scopeId, serverId: payload.serverId,
      threadId: payload.message.scopeType === 'thread' ? payload.message.scopeId : null, messageId: payload.message.id,
    });
  });
  bus.on('ws:presence', ({ user }) => {
    upsertPresence(user);
    if (state.me && user.id === state.me.id) { Object.assign(state.me, user); bus.emit('state:me'); }
  });
  bus.on('ws:voice_state', ({ channelId, participants }) => { if (channelId != null) applyServerVoiceState(channelId, participants.map((u) => u.id)); });
  bus.on('ws:server_update', ({ server }) => upsertServer(server));
  bus.on('ws:server_delete', ({ serverId }) => removeServer(serverId));
  for (const ev of ['channel_create', 'channel_update']) bus.on(`ws:${ev}`, ({ channel }) => refreshServerDetailSilently(channel.server_id));
  bus.on('ws:server_refresh', ({ serverId }) => refreshServerDetailSilently(serverId));
  for (const ev of ['channel_delete', 'category_delete', 'role_delete', 'member_join', 'member_leave', 'member_role_update', 'emoji_remove', 'sticker_remove']) {
    bus.on(`ws:${ev}`, ({ serverId }) => serverId && refreshServerDetailSilently(serverId));
  }
  for (const [ev, key] of [['category_create', 'category'], ['category_update', 'category'], ['role_create', 'role'], ['role_update', 'role'], ['emoji_add', 'emoji'], ['sticker_add', 'sticker']]) {
    bus.on(`ws:${ev}`, (p) => p[key] && refreshServerDetailSilently(p[key].server_id));
  }
  for (const ev of ['member_kick', 'member_ban']) {
    bus.on(`ws:${ev}`, ({ serverId, userId }) => {
      refreshServerDetailSilently(serverId);
      if (isSelf(userId)) removeServer(serverId);
    });
  }
  bus.on('ws:friend_request', async () => { try { setFriends(await api.friends()); } catch { /* ignore */ } });
  bus.on('ws:friend_accept', async () => { try { setFriends(await api.friends()); } catch { /* ignore */ } });
  bus.on('ws:dm_create', ({ dm }) => upsertDm(dm));
  bus.on('ws:dm_update', ({ dm }) => updateDm(dm));
  bus.on('ws:dm_closed', async ({ dmId, closedBy }) => {
    const dm = state.dms.find((d) => d.id === dmId);
    if (!dm) return;
    dm.closedBy = closedBy;
    dm.members = dm.members.filter((u) => u.id !== closedBy.id);
    bus.emit('state:dms');
    const { confirmSheet } = await import('./components/bottomSheet.js');
    if (await confirmSheet(t('dmMenu.closedPrompt', { name: closedBy.displayName }).replace(/<[^>]+>/g, ''), { okLabel: t('common.deleteForever') })) {
      try { await api.leaveDm(dmId); removeDm(dmId); } catch { /* stays in the list */ }
    }
  });
  bus.on('ws:dm_update', ({ dm: patch }) => {
    const dm = state.dms.find((d) => d.id === patch.id);
    if (!dm) return;
    Object.assign(dm, patch);
    bus.emit('state:dms');
  });
  bus.on('ws:dm_delete', ({ dmId }) => removeDm(dmId));
  bus.on('ws:dm_read', ({ dmId, userId, messageId }) => applyDmRead(dmId, userId, messageId));
  bus.on('ws:message_delete', ({ messageId, scopeType, scopeId }) => {
    if (scopeType === 'dm' && state.dms.find((d) => d.id === scopeId)?.lastMessage?.id === messageId) bus.emit('dms:unknownScope', scopeId);
  });
  bus.on('dms:unknownScope', async () => { try { setDms((await api.listDms()).dms); } catch { /* ignore */ } });
  bus.on('ws:channel_invite_received', async () => { try { setServers((await api.listServers()).servers); } catch { /* ignore */ } });

  // A backgrounded WebView throttles timers, so reconnect immediately on resume.
  // Fetch over HTTP right away instead of waiting for the socket, so new messages show up at once.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    ws.reconnectNow();
    resync();
    bus.emit('m:resume');
  });
  ws.connect();
}
