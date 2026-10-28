import { api } from '../js/api.js';
import { bus } from '../js/bus.js';
import { ws } from '../js/ws.js';
import { applyTheme } from '../js/theme.js';
import { t } from '../js/i18n.js';
import { toast } from '../js/utils.js';
import { notifySound } from '../js/notifySound.js';
import { peekPlaintext } from '../js/e2ee/dmCrypto.js';
import { refreshRemoteServers } from '../js/views/remoteServer.js';
import {
  state, setServers, setDms, setFriends, setNotificationPrefs, setServerPrefs, setUserAnnotations, setDmPrefs, setBookmarkIds,
  setReadStateBulk, setServerLayout, setServerDetail, getServerDetail, upsertServer, removeServer, upsertDm, removeDm,
  upsertDmPreview, noteChannelMessage, setDmPref, dmPrefFor, upsertPresence, setWsConnected, pushActivity,
  shouldPlayNotifySound, isSelf, setServerVoiceBulk, applyServerVoiceState,
} from '../js/state.js';

export async function loadAll() {
  try {
    const [serversRes, dmsRes, friendsRes, prefsRes, config, readStateRes, layoutRes, themeRes, serverPrefsRes, annotationsRes, dmPrefsRes, bookmarkIdsRes, uiPrefsRes] = await Promise.all([
      api.listServers(), api.listDms(), api.friends(), api.getNotificationPrefs(), api.config(), api.getReadState(), api.getServerLayout(), api.getTheme(),
      api.getServerPrefs(), api.getUserAnnotations(), api.getDmPrefs(), api.getBookmarkIds(), api.getUiPrefs(),
    ]);
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
    setReadStateBulk(readStateRes.state);
    setServerLayout(layoutRes.layout);
    applyTheme(themeRes.theme);
    if (config.federationEnabled) refreshRemoteServers();
  } catch (err) {
    if (err && err.status === 401) { bus.emit('m:unauthorized'); return; }
    toast(t('m.loadFailed'), { type: 'error' });
  }
}

export async function ensureServerDetail(serverId) {
  let detail = getServerDetail(serverId);
  if (!detail) {
    detail = await api.getServer(serverId);
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
    const [s, d, f] = await Promise.all([api.listServers(), api.listDms(), api.friends()]);
    setServers(s.servers); setDms(d.dms); setFriends(f);
    for (const id of [...state.serverDetail.keys()]) refreshServerDetailSilently(id);
  } catch (err) { if (err && err.status === 401) bus.emit('m:unauthorized'); }
}

function notifyBody(payload) {
  const m = payload.message;
  if (m.isEncrypted) return peekPlaintext(state.me.id, m.id)?.text || t('m.dmPreviewEncrypted');
  return m.content || (m.attachments?.length ? t('m.dmPreviewAttachment') : '');
}

export function wireRealtime() {
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
  bus.on('state:connection', (ok) => document.getElementById('m-conn')?.classList.toggle('hidden', ok));

  bus.on('ws:message_create', ({ message }) => {
    if (message.scopeType === 'dm') {
      if (dmPrefFor(message.scopeId).hidden) setDmPref({ ...dmPrefFor(message.scopeId), hidden: false });
      upsertDmPreview(message.scopeId, message);
    } else if (message.scopeType === 'channel') {
      noteChannelMessage(message.scopeId, message.id);
    }
  });
  bus.on('ws:notify', (payload) => {
    if (shouldPlayNotifySound() && (document.hidden || !state.mOpenScope || state.mOpenScope !== `${payload.scopeType}:${payload.scopeId}`)) notifySound.play();
    const author = payload.message.author;
    const title = payload.scopeType === 'dm'
      ? author.displayName
      : `${author.displayName} #${payload.channelName}${payload.serverName ? ` (${payload.serverName})` : ''}`;
    pushActivity({
      kind: payload.scopeType === 'dm' ? 'dm' : (payload.mentioned ? 'mention' : 'channel'),
      title, body: notifyBody(payload),
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
  bus.on('ws:dm_update', ({ dm: patch }) => {
    const dm = state.dms.find((d) => d.id === patch.id);
    if (!dm) return;
    Object.assign(dm, patch);
    bus.emit('state:dms');
  });
  bus.on('ws:dm_delete', ({ dmId }) => removeDm(dmId));
  bus.on('ws:dm_read', ({ dmId, userId, messageId }) => {
    if (isSelf(userId)) return;
    const dm = state.dms.find((d) => d.id === dmId);
    if (!dm) return;
    dm.readStates = dm.readStates || [];
    const existing = dm.readStates.find((r) => r.userId === userId);
    if (existing) { if (messageId > existing.lastReadMessageId) existing.lastReadMessageId = messageId; }
    else dm.readStates.push({ userId, lastReadMessageId: messageId });
    bus.emit('state:dms');
  });
  bus.on('dms:unknownScope', async () => { try { setDms((await api.listDms()).dms); } catch { /* ignore */ } });
  bus.on('ws:channel_invite_received', async () => { try { setServers((await api.listServers()).servers); } catch { /* ignore */ } });

  // A backgrounded WebView throttles timers, so reconnect immediately on resume.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) ws.reconnectNow(); });
  ws.connect();
}
