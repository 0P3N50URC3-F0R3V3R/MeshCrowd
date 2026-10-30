import { bus } from '../bus.js';
import { api } from '../api.js';
import { ws } from '../ws.js';
import { clearCachedIdentity } from '../e2ee/identity.js';
import { icons } from '../icons.js';
import {
  state, setServers, setDms, setFriends, setView, upsertPresence,
  setServerDetail, getServerDetail, upsertServer, removeServer, upsertDmPreview, upsertDm, removeDm,
  setWsConnected, setNotificationPrefs, setServerPrefs, setUserAnnotations, setDmPrefs, setDmPref, dmPrefFor, setBookmarkIds, nameFor, notificationPrefFor, setNotificationPref, setReadStateBulk, setReadState, isSelf,
  setFriendVoice, pushActivity, setServerLayout, shouldPlayNotifySound,
  setServerVoiceBulk, applyServerVoiceState, getGlobalUnreadCount, noteChannelMessage,
} from '../state.js';
import { openContextMenu, openModal, confirmModal, confirmTypedModal } from './modal.js';
import { notifySound } from '../notifySound.js';
import { updateBadge as updateFaviconBadge } from '../favicon.js';
import { applyTheme } from '../theme.js';
import { has, PERMISSIONS, memberPermissionBits, channelPermissionBits } from '../permissions.js';
import { escapeHtml, toast, avatarHtml, apiErrorMessage, debounce, formatBytes } from '../utils.js';
import { mountServerRail, joinWithCode } from './serverRail.js';
import { mountChannelSidebar, mountHomeSidebar, openNewDmModal } from './sidebar.js';
import { mountMemberList } from './memberList.js';
import { mountUserBar } from './userBar.js';
import { mountCallBar } from './callBar.js';
import { mountChat } from './chat.js';
import { mountRemoteServer, refreshRemoteServers, getRemoteInfo } from './remoteServer.js';
import { mountForum } from './forum.js';
import { mountNotes } from './notes.js';
import { mountSite, mountSiteSidebar } from './site.js';
import { mountVoiceChannel } from './voice.js';
import { mountFriends } from './friends.js';
import { openProfileModal } from './profile.js';
import { openFullProfile } from './fullProfile.js';
import { openBookmarksModal } from './bookmarks.js';
import { mountSearchPanel } from './search.js';
import { mountActivityPanel } from './activityPanel.js';
import { mountPinnedPanel } from './pinnedPanel.js';
import { mountThreadsPanel } from './threadsPanel.js';
import { openServerSettings } from './serverSettings.js';
import { t } from '../i18n.js';
import { parseInviteHash } from '../inviteHash.mjs';
import { peekInvite } from '../inviteLink.js';
import { ensureOwnKeyPublished, peekPlaintext, trustView } from '../e2ee/dmCrypto.js';
import { openVerifyModal } from './dmVerify.js';
import { openScreeningModal } from './onboarding.js';

export async function mountShell(root) {
  root.innerHTML = `
    <div id="conn-banner" class="conn-banner hidden">${t('shell.lostConnection')}</div>
    <div class="app-frame">
      <div class="app-topbar" id="s-topbar">
        <span class="topbar-icon" id="topbar-icon"></span>
        <span class="topbar-title" id="topbar-title"></span>
        <div class="spacer"></div>
        <button class="btn-icon" id="topbar-saved" title="${t('bookmarks.title')}">${icons.bookmark(18)}</button>
        <button class="btn-icon" id="topbar-inbox" title="${t('shell.recentActivityTitle')}">${icons.bell(18)}</button>
        <button class="btn-icon" id="topbar-help" title="${t('shell.aboutMeshcordTitle')}">${icons.info(18)}</button>
        <button class="btn-icon" id="topbar-newdm" title="${t('shell.newDirectMessageTitle')}">${icons.userPlus(18)}</button>
      </div>
      <div class="shell">
        <div class="rail" id="s-rail"></div>
        <div class="sidebar" id="s-sidebar" style="display:flex;flex-direction:column">
          <div style="flex:1;min-height:0;display:flex;flex-direction:column" id="s-sidebar-content"></div>
          <div class="call-bar" id="s-callbar" hidden></div>
          <div class="user-bar" id="s-userbar"></div>
          <div class="resize-handle resize-handle-right" id="sidebar-resize-handle"></div>
        </div>
        <div class="main-col" id="s-main"></div>
        <div class="member-list collapsed" id="s-members"></div>
      </div>
    </div>`;

  const mainColEl = document.getElementById('s-main');
  new ResizeObserver(([e]) => {
    const w = e.contentRect.width;
    mainColEl.classList.toggle('narrow', w < 560);
    mainColEl.classList.toggle('narrow-xs', w < 400);
  }).observe(mainColEl);

  mountServerRail(document.getElementById('s-rail'));
  mountUserBar(document.getElementById('s-userbar'));
  mountCallBar(document.getElementById('s-callbar'));
  mountTopBar();

  bus.on('state:connection', (connected) => {
    document.getElementById('conn-banner')?.classList.toggle('hidden', connected);
    document.body.classList.toggle('ws-disconnected', !connected);
  });

  let currentChat = null;
  let currentSidebar = null;
  let currentMembers = null;
  let currentVoice = null;
  let offDmHeader = null;
  let hasConnectedOnce = false;
  // Which scope currently has its pinned-messages or search panel docked open in the #s-members
  // slot — survives the full renderMain() a pin-jump triggers (jumping navigates within the same
  // scope, so on remount wirePanelToggles sees this still matches and reopens the panel instead
  // of losing it).
  let dockedPanel = null; // {mode: 'pinned' | 'search', scopeType, scopeId} | null

  bus.on('ws:message_create', ({ message }) => {
    // Own messages (this or another device/window) must never count as unread for the sender.
    if (isSelf(message.author?.id) && (message.scopeType === 'dm' || message.scopeType === 'channel')) {
      setReadState(message.scopeType, message.scopeId, message.id);
      api.markRead(message.scopeType, message.scopeId, message.id).catch(() => {});
    }
    if (message.scopeType === 'dm') {
      // The server re-opens a closed conversation on any new message; mirror that locally.
      if (dmPrefFor(message.scopeId).hidden) setDmPref({ ...dmPrefFor(message.scopeId), hidden: false });
      upsertDmPreview(message.scopeId, message);
    } else if (message.scopeType === 'channel') {
      // Keeps servers the user isn't currently viewing up to date too — see noteChannelMessage.
      noteChannelMessage(message.scopeId, message.id);
    }
  });
  // Tray icon (Electron) + favicon/title (browser tab) unread badge, colored by the user's own
  // presence. Deferred a tick so it runs after whichever other ws:message_create/state listener
  // actually mutates the read/unread bookkeeping this tick (e.g. sidebar.js bumping a channel's
  // last_message_id) — bus.emit is synchronous in registration order, and this listener's own
  // position in that order isn't something to rely on.
  const scheduleUnreadBadge = () => queueMicrotask(pushUnreadBadge);
  bus.on('state:readState', scheduleUnreadBadge);
  bus.on('state:dms', scheduleUnreadBadge);
  bus.on('state:friends', scheduleUnreadBadge);
  bus.on('state:serverDetail', scheduleUnreadBadge);
  bus.on('state:me', scheduleUnreadBadge);
  bus.on('ws:message_create', scheduleUnreadBadge);
  bus.on('ws:notify', onNotify);
  bus.on('ws:reminder', onReminder);
  bus.on('ws:presence', ({ user }) => {
    upsertPresence(user);
    // Presence broadcasts never target ourselves (see socket/index.js) except this one dedicated
    // self-sync event — merge it into state.me too, or our own status dot never leaves whatever
    // it was computed as at login/register time (always "offline").
    if (state.me && user.id === state.me.id) { Object.assign(state.me, user); bus.emit('state:me'); }
  });
  // A deleted message that was a channel's/DM's newest one leaves last_message_id pointing at an
  // id nobody can ever read, so the unread badge sticks until the server recomputes it.
  bus.on('ws:message_delete', async ({ messageId, scopeType, scopeId }) => {
    if (scopeType === 'dm') {
      if (state.dms.find((d) => d.id === scopeId)?.lastMessage?.id === messageId) refreshDmsSilently();
      return;
    }
    for (const [serverId, detail] of state.serverDetail) {
      if (!detail.channels.some((c) => c.id === scopeId && c.last_message_id === messageId)) continue;
      try { setServerDetail(serverId, await api.getServer(serverId)); } catch { /* likely lost access */ }
      return;
    }
  });
  bus.on('ws:server_update', ({ server }) => upsertServer(server));
  bus.on('ws:server_delete', ({ serverId }) => {
    removeServer(serverId);
    if (state.view.type === 'server' && state.view.serverId === serverId) bus.emit('ui:navigate', { type: 'home' });
  });
  // Always-on (not scoped to whichever voice channel is currently open, unlike voice.js's own
  // listener) so the member-list "in a call" indicator stays live no matter which channel of the
  // server you're browsing.
  bus.on('ws:voice_state', ({ channelId, participants }) => applyServerVoiceState(channelId, participants.map((u) => u.id)));
  bus.on('ws:thread_delete', ({ channelId, threadId }) => {
    const v = state.view;
    if (v.type === 'server' && v.channelId === channelId && v.threadId === threadId) {
      bus.emit('ui:navigate', { type: 'server', serverId: v.serverId, channelId });
    }
  });
  bus.on('ws:channel_create', ({ channel }) => refreshServerDetailSilently(channel.server_id));
  bus.on('ws:channel_update', ({ channel }) => refreshServerDetailSilently(channel.server_id));
  bus.on('ws:channel_delete', ({ serverId, channelId }) => {
    refreshServerDetailSilently(serverId);
    if (state.view.type === 'server' && state.view.channelId === channelId) navigateToServerDefault(serverId);
  });
  bus.on('ws:category_create', ({ category }) => refreshServerDetailSilently(category.server_id));
  bus.on('ws:category_update', ({ category }) => refreshServerDetailSilently(category.server_id));
  bus.on('ws:category_delete', ({ serverId }) => refreshServerDetailSilently(serverId));
  bus.on('ws:welcome_channel_add', ({ welcomeChannel }) => refreshServerDetailSilently(welcomeChannel.server_id));
  bus.on('ws:welcome_channel_update', ({ welcomeChannel }) => refreshServerDetailSilently(welcomeChannel.server_id));
  bus.on('ws:welcome_channel_remove', ({ serverId }) => refreshServerDetailSilently(serverId));
  bus.on('ws:emoji_add', ({ emoji }) => refreshServerDetailSilently(emoji.server_id));
  bus.on('ws:emoji_remove', ({ serverId }) => refreshServerDetailSilently(serverId));
  bus.on('ws:sticker_add', ({ sticker }) => refreshServerDetailSilently(sticker.server_id));
  bus.on('ws:sticker_remove', ({ serverId }) => refreshServerDetailSilently(serverId));
  bus.on('ws:sound_add', ({ sound }) => refreshServerDetailSilently(sound.server_id));
  bus.on('ws:sound_remove', ({ serverId }) => refreshServerDetailSilently(serverId));
  bus.on('ws:role_create', ({ role }) => refreshServerDetailSilently(role.server_id));
  bus.on('ws:role_update', ({ role }) => refreshServerDetailSilently(role.server_id));
  bus.on('ws:role_delete', ({ serverId }) => refreshServerDetailSilently(serverId));
  bus.on('ws:member_role_update', ({ serverId }) => refreshServerDetailSilently(serverId));
  bus.on('ws:member_join', ({ serverId }) => refreshServerDetailSilently(serverId));
  bus.on('ws:member_kick', ({ serverId, userId }) => {
    refreshServerDetailSilently(serverId);
    if (userId === state.me.id) { toast(t('shell.removedFromServerToast')); removeServer(serverId); if (state.view.type === 'server' && state.view.serverId === serverId) bus.emit('ui:navigate', { type: 'home' }); }
  });
  bus.on('ws:member_ban', ({ serverId, userId }) => {
    refreshServerDetailSilently(serverId);
    if (userId === state.me.id) { toast(t('shell.bannedFromServerToast')); removeServer(serverId); if (state.view.type === 'server' && state.view.serverId === serverId) bus.emit('ui:navigate', { type: 'home' }); }
  });
  bus.on('ws:friend_request', (payload) => { refreshFriendsSilently(); onFriendEvent(t('shell.friendRequestReceivedToast', { name: payload.from.displayName }), 'pending'); });
  bus.on('ws:friend_accept', (payload) => { refreshFriendsSilently(); onFriendEvent(t('shell.friendRequestAcceptedToast', { name: payload.by.displayName }), 'all'); });
  bus.on('ws:voice_ring', ({ dmChannelId, fromUser }) => onVoiceRing(dmChannelId, fromUser));
  bus.on('ws:dm_create', ({ dm }) => upsertDm(dm));
  bus.on('ws:dm_update', ({ dm: patch }) => {
    const dm = state.dms.find((d) => d.id === patch.id);
    if (!dm) return;
    Object.assign(dm, patch);
    bus.emit('state:dms');
  });
  bus.on('ws:dm_delete', ({ dmId }) => {
    removeDm(dmId);
    if (state.view.type === 'dm' && state.view.dmId === dmId) { toast(t('shell.groupDeletedToast')); navigate({ type: 'home' }); }
  });
  bus.on('ws:channel_invite_received', async ({ server, channelName, invitedBy }) => {
    toast(t('shell.channelInviteToast', { name: invitedBy.displayName, channel: channelName, server: server.name }));
    try { setServers((await api.listServers()).servers); } catch { /* the rail just won't show the new server until next refresh */ }
  });
  bus.on('ws:friend_voice', ({ userId, channel }) => setFriendVoice(userId, channel));
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
  bus.on('dms:unknownScope', () => refreshDmsSilently());
  bus.on('ws:member_leave', ({ serverId }) => refreshServerDetailSilently(serverId));
  bus.on('ws:open', () => {
    setWsConnected(true);
    if (!hasConnectedOnce) { hasConnectedOnce = true; return; } // initial load already covered this
    resyncAfterReconnect();
  });
  bus.on('ws:close', () => setWsConnected(false));
  bus.on('ui:openProfile', ({ userId, serverId, anchor }) => openProfileModal(userId, { serverId, anchor }));
  document.getElementById('topbar-saved').addEventListener('click', () => openBookmarksModal());
  bus.on('ui:navigate', (view) => navigate(view));
  bus.on('ui:serverRemoved', async (serverId) => {
    removeServer(serverId);
    if (state.view.type === 'server' && state.view.serverId === serverId) navigate({ type: 'home' });
  });
  bus.on('ui:serverCreated', async (server) => {
    upsertServer(server);
    navigate({ type: 'server', serverId: server.id });
  });

  // A "notify" event fires for every recipient whose pref allows it, even ones currently looking
  // right at that channel/DM — skip the popup (but not the sound-free case) when the scope is
  // already open and the tab is focused, since a desktop notification for something already on
  // screen is just noise.
  function onNotify(payload) {
    const viewingIt = state.view.type === (payload.scopeType === 'dm' ? 'dm' : 'server')
      && (payload.scopeType === 'dm' ? state.view.dmId === payload.scopeId : state.view.channelId === payload.scopeId);
    const isFocused = viewingIt && !document.hidden;
    if ((!isFocused || notifySound.get().playWhenFocused) && shouldPlayNotifySound()) notifySound.play();
    if (isFocused) return;

    const author = payload.message.author;
    const title = payload.scopeType === 'dm'
      ? author.displayName
      : `${author.displayName} in #${payload.channelName}${payload.serverName ? ` (${payload.serverName})` : ''}`;
    // The server only ever sends a generic text for encrypted DMs; a message this device already
    // decrypted can show its real text, anything else stays generic and localized.
    const body = payload.message.isEncrypted
      ? (peekPlaintext(state.me.id, payload.message.id)?.text || t('dmEncryption.notifyBody'))
      : payload.message.content || (payload.message.attachments?.length ? t('sidebar.sentAnAttachment') : '');

    pushActivity({
      kind: payload.scopeType === 'dm' ? 'dm' : (payload.mentioned ? 'mention' : 'channel'),
      title, body,
      scopeType: payload.scopeType, scopeId: payload.scopeId, serverId: payload.serverId,
    });

    // The Electron shell keeps its own tray "Recent" list independent of in-page Notification
    // permission — it's the only way to surface activity while the window is hidden to the tray.
    window.dismeshClient?.pushNotification({ title, body, scopeType: payload.scopeType, scopeId: payload.scopeId, serverId: payload.serverId });

    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const n = new Notification(title, { body, tag: `${payload.scopeType}-${payload.scopeId}` });
    n.onclick = () => {
      window.focus();
      bus.emit('ui:navigate', payload.scopeType === 'dm'
        ? { type: 'dm', dmId: payload.scopeId }
        : { type: 'server', serverId: payload.serverId, channelId: payload.scopeId });
      n.close();
    };
  }

  // A message-reminder the user set from the message context menu. Always surfaces: they asked for it.
  function onReminder(payload) {
    if (shouldPlayNotifySound()) notifySound.play();
    const body = payload.encrypted ? t('msgMenu.reminderEncryptedBody') : payload.snippet || t('sidebar.sentAnAttachment');
    const title = t('msgMenu.reminderTitle', { name: payload.author?.displayName || '' });
    toast(`${title}: ${body}`.slice(0, 160));
    const target = payload.scopeType === 'dm'
      ? { type: 'dm', dmId: payload.scopeId, jumpToMessageId: payload.messageId }
      : payload.scopeType === 'thread'
        ? { type: 'server', serverId: payload.serverId, channelId: payload.channelId, threadId: payload.scopeId, jumpToMessageId: payload.messageId }
        : { type: 'server', serverId: payload.serverId, channelId: payload.scopeId, jumpToMessageId: payload.messageId };
    pushActivity({ kind: 'mention', title, body, scopeType: payload.scopeType === 'dm' ? 'dm' : 'channel', scopeId: payload.scopeType === 'dm' ? payload.scopeId : (payload.channelId || payload.scopeId), serverId: payload.serverId });
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const n = new Notification(title, { body, tag: `reminder-${payload.reminderId}` });
    n.onclick = () => { window.focus(); bus.emit('ui:navigate', target); n.close(); };
  }

  // Friend request/accept has no channel/DM scope to suppress against (unlike onNotify), so it
  // always surfaces — these are rare enough events that there's no "already looking at it" case.
  function onFriendEvent(body, friendsTab) {
    if (shouldPlayNotifySound()) notifySound.play();
    window.dismeshClient?.pushNotification({ title: 'MeshCrowd', body, scopeType: 'friends', scopeId: friendsTab });
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const n = new Notification('MeshCrowd', { body, tag: 'friend-event' });
    n.onclick = () => {
      window.focus();
      bus.emit('ui:navigate', { type: 'friends', tab: friendsTab });
      n.close();
    };
  }

  function pushTrayLabels() {
    window.dismeshClient?.setTrayLabels?.({
      open: t('trayMenu.open'), recent: t('trayMenu.recent'), none: t('trayMenu.none'),
      logout: t('trayMenu.logout'), quit: t('trayMenu.quit'), unread: t('trayMenu.unread', { count: '{count}' }),
    });
  }

  function pushUnreadBadge() {
    const count = getGlobalUnreadCount();
    const status = state.me?.status || 'online';
    updateFaviconBadge({ count, status });
    window.dismeshClient?.setTrayBadge({ count, status });
  }

  // A DM/group call just went from empty to non-empty (see server/socket/index.js voice_join) —
  // ring only the other DM members, never a public/friends-activity broadcast, matching the
  // invite-only design of DM calls.
  function onVoiceRing(dmChannelId, fromUser) {
    const dm = state.dms.find((d) => d.id === dmChannelId);
    const dmName = dm ? (dm.isGroup ? (dm.name || dm.members.map((m) => m.displayName).join(', ')) : dm.members[0]?.displayName) : null;
    const body = t('shell.startedCallToast', { name: fromUser.displayName, inClause: dmName ? t('shell.startedCallInClause', { dmName }) : '' });
    if (shouldPlayNotifySound()) notifySound.play();
    window.dismeshClient?.pushNotification({ title: t('shell.incomingCallTitle'), body, scopeType: 'dm', scopeId: dmChannelId });
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') { toast(body); return; }
    const n = new Notification(t('shell.incomingCallTitle'), { body, tag: `voice-ring-${dmChannelId}` });
    n.onclick = () => {
      window.focus();
      bus.emit('ui:navigate', { type: 'dm', dmId: dmChannelId, autoOpenCall: true });
      n.close();
    };
  }

  async function refreshServerDetailSilently(serverId) {
    try {
      const detail = await api.getServer(serverId);
      setServerDetail(serverId, detail);
      // mountChannelSidebar takes a one-time detail snapshot, not a live subscription — it must
      // be re-mounted (via renderSidebar, which re-reads state fresh) for the channel list to
      // pick up create/edit/delete/role changes without the user navigating away and back.
      if (state.view.type === 'server' && state.view.serverId === serverId) {
        renderSidebar();
        renderMain();
      }
    } catch { /* likely lost access — ignore */ }
  }

  async function refreshFriendsSilently() {
    try { setFriends(await api.friends()); } catch { /* ignore */ }
  }

  async function refreshDmsSilently() {
    try { setDms((await api.listDms()).dms); } catch { /* ignore */ }
  }

  // A WS gap (dropped connection, missed reconnect window) means every event during that gap is
  // lost — servers/channels/roles/members/friends could all be stale. Re-pull the summary lists;
  // the active server's detail and the open chat's history get refreshed too since both are
  // cheap to refetch and a WS reconnect is rare enough that this isn't a hot path.
  async function resyncAfterReconnect() {
    try {
      const [serversRes, dmsRes, friendsRes] = await Promise.all([api.listServers(), api.listDms(), api.friends()]);
      setServers(serversRes.servers);
      setDms(dmsRes.dms);
      setFriends(friendsRes);
      refreshRemoteServers();
      if (state.view.type === 'server') await refreshServerDetailSilently(state.view.serverId);
      renderMain();
    } catch { /* best-effort */ }
  }

  // "Resume where I left off" (userSettings.js Appearance tab) reads this back on next login.
  // Always written regardless of the setting, so turning it on later has something to restore
  // immediately instead of a dead first run.
  function saveLastLocation(view) {
    if (view.type !== 'home' && view.type !== 'friends' && view.type !== 'server' && view.type !== 'dm') return;
    try { localStorage.setItem('dismesh:lastLocation', JSON.stringify({ type: view.type, serverId: view.serverId, channelId: view.channelId, threadId: view.threadId, dmId: view.dmId, tab: view.tab, welcome: view.welcome })); } catch { /* ignore */ }
  }

  const screeningShown = new Set(); // servers whose rules prompt was already offered this session

  async function navigate(view) {
    setView(view);
    saveLastLocation(view);
    if (view.type === 'server') {
      let detail = getServerDetail(view.serverId);
      if (!detail) {
        try { detail = await api.getServer(view.serverId); setServerDetail(view.serverId, detail); }
        catch { toast(t('shell.couldNotOpenServer'), { type: 'error' }); return navigate({ type: 'home' }); }
        // One-time bootstrap of "who's already in voice" for this server — live join/leave
        // updates arrive after this over the always-on ws:voice_state listener below.
        if (detail.server.kind !== 'site') api.serverVoiceActivity(view.serverId).then((res) => setServerVoiceBulk(res.activity)).catch(() => {});
      }
      if (detail.onboarding && !screeningShown.has(view.serverId)) {
        screeningShown.add(view.serverId);
        const serverId = view.serverId;
        openScreeningModal({
          serverId, serverName: detail.server.name, onboarding: detail.onboarding,
          onDone: async () => { try { setServerDetail(serverId, await api.getServer(serverId)); renderSidebar(); renderMain(); } catch { /* the next refresh will catch up */ } },
        });
      }
      if (!view.channelId && !view.welcome) {
        const first = detail.channels[0];
        if (first) return navigate({ type: 'server', serverId: view.serverId, channelId: first.id });
      }
    }
    renderSidebar();
    renderMain();
  }

  function navigateToServerDefault(serverId) {
    const detail = getServerDetail(serverId);
    const first = detail?.channels[0];
    navigate(first ? { type: 'server', serverId, channelId: first.id } : { type: 'home' });
  }

  // Group creator only (enforced server-side too) — always immediate, no grace-period option,
  // this is a small self-service cleanup action, not the heavier instance-wide admin tooling.
  function openDmPruneModal(dm) {
    let cutoff = '';
    let purgeAttachments = false;
    let preview = null;
    openModal({
      title: t('shell.pruneGroupHistoryTitle'),
      render(body, close) { draw(body, close); },
    });
    function draw(body, close) {
      body.innerHTML = `
        <p class="hint" style="margin-top:0">${t('shell.pruneGroupHint')}</p>
        <div class="field">
          <label>${t('shell.deleteMessagesBeforeLabel')}</label>
          <input class="input" type="date" id="dp-cutoff" value="${escapeHtml(cutoff)}" style="max-width:200px">
        </div>
        <label class="checkbox-row">
          <input type="checkbox" id="dp-attachments" ${purgeAttachments ? 'checked' : ''}>
          ${t('shell.alsoDeleteAttachmentsCheckbox')}
        </label>
        ${preview ? `
          <div class="empty-state" style="height:auto;padding:12px;border:1px solid var(--border);border-radius:var(--radius-sm);margin-bottom:12px;text-align:left">
            <p>${t('shell.pruneSummary', { count: preview.messageCount, attachmentClause: purgeAttachments ? t('shell.pruneAttachmentClause', { count: preview.attachmentCount, size: formatBytes(preview.attachmentBytes) }) : '' })}</p>
          </div>` : ''}
        <div class="error-text" id="dp-err"></div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-secondary" id="dp-preview">${t('shell.previewButton')}</button>
          <button class="btn btn-danger" id="dp-execute" ${preview ? '' : 'disabled'}>${t('shell.pruneNowButton')}</button>
        </div>`;
      body.querySelector('#dp-cutoff').addEventListener('change', (e) => { cutoff = e.target.value; preview = null; });
      body.querySelector('#dp-attachments').addEventListener('change', (e) => { purgeAttachments = e.target.checked; preview = null; draw(body, close); });
      body.querySelector('#dp-preview').addEventListener('click', async () => {
        const errEl = body.querySelector('#dp-err');
        errEl.textContent = '';
        if (!cutoff) { errEl.textContent = t('shell.pickCutoffDateError'); return; }
        try { preview = await api.dmPrunePreview(dm.id, { cutoff, purgeAttachments }); draw(body, close); }
        catch (err) { errEl.textContent = apiErrorMessage(err, t('shell.couldNotPreview')); }
      });
      body.querySelector('#dp-execute').addEventListener('click', () => {
        const label = dm.name || dm.members.map((u) => u.displayName).join(', ');
        confirmTypedModal({
          title: t('shell.pruneGroupHistoryTitle'),
          message: t('shell.pruneConfirmMessage', { count: preview.messageCount, attachmentClause: purgeAttachments ? t('shell.pruneConfirmAttachmentClause', { count: preview.attachmentCount }) : '' }),
          expectedText: label,
          confirmLabel: t('shell.pruneForeverButton'),
          onConfirm: async () => {
            try {
              const res = await api.dmPruneExecute(dm.id, { cutoff, purgeAttachments });
              toast(t('shell.prunedMessagesToast', { count: res.messageCount }));
              close();
            } catch (err) { toast(apiErrorMessage(err, t('shell.couldNotPrune')), { type: 'error' }); }
          },
        });
      });
    }
  }

  // Toggles docked panels (pinned messages, search, threads) into the right rail (same slot the
  // member list lives in), in place of floating popovers — only one panel (or the member
  // list/nothing) occupies that slot at a time. `panels` is [{btn, mode, mount(onClose) => {destroy}}].
  // `restoreDefault` puts the slot back the way it was (member list for channels/threads,
  // collapsed for DMs) when every panel is closed.
  function wirePanelToggles(membersEl, scopeType, scopeId, panels, restoreDefault) {
    const isOpen = (mode) => dockedPanel?.mode === mode && dockedPanel.scopeType === scopeType && dockedPanel.scopeId === scopeId;
    const closeAll = () => {
      dockedPanel = null;
      panels.forEach((p) => p.btn.classList.remove('active'));
      restoreDefault();
    };
    const open = (mode) => {
      dockedPanel = { mode, scopeType, scopeId };
      panels.forEach((p) => p.btn.classList.toggle('active', p.mode === mode));
      membersEl.classList.remove('collapsed');
      currentMembers?.destroy?.();
      currentMembers = panels.find((p) => p.mode === mode).mount(closeAll);
    };
    panels.forEach((p) => p.btn.addEventListener('click', () => (isOpen(p.mode) ? closeAll() : open(p.mode))));
    // Every call site remounts this whole header+panel on each render (a full renderMain(), even
    // for a same-scope jump-navigate) - so this is also what decides what the slot shows this
    // time: the still-open docked panel if one matches this scope, member list/collapsed
    // otherwise. A caller must never *also* call restoreDefault() itself right after this, or it
    // clobbers whichever of the two this just picked (this was the actual bug behind "pinned
    // panel button stays active but the panel silently reverts to the member list").
    if (dockedPanel?.scopeType === scopeType && dockedPanel?.scopeId === scopeId) open(dockedPanel.mode);
    else restoreDefault();
  }

  // Drag-resize for the channel sidebar and member-list/right-panel slot. Both handles are
  // static, boot-once elements (unlike their panels' own content, which gets torn down and
  // remounted on every navigate) - #s-sidebar itself is never overwritten (only its
  // #s-sidebar-content child is), and #s-members's handle is a CSS ::before pseudo-element
  // specifically so replacing #s-members's innerHTML on every panel switch can never wipe it out.
  const UI_PREF_BOUNDS = { sidebarWidth: [180, 400], membersWidth: [180, 400] };
  function wireResizeHandle(handleEl, cssVar, prefKey, invert) {
    const [min, max] = UI_PREF_BOUNDS[prefKey];
    let dragging = false;
    let startX = 0;
    let startWidth = 0;
    const onMove = (e) => {
      if (!dragging) return;
      const delta = invert ? startX - e.clientX : e.clientX - startX;
      const next = Math.max(min, Math.min(max, startWidth + delta));
      document.documentElement.style.setProperty(cssVar, `${next}px`);
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      handleEl.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      const finalWidth = Math.round(parseFloat(getComputedStyle(document.documentElement).getPropertyValue(cssVar)));
      api.setUiPrefs({ [prefKey]: finalWidth }).catch(() => {});
    };
    handleEl.addEventListener('mousedown', (e) => {
      dragging = true;
      startX = e.clientX;
      startWidth = Math.round(parseFloat(getComputedStyle(document.documentElement).getPropertyValue(cssVar))) || min;
      handleEl.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  // Vertical drag divider between a voice panel and the chat under it. Height lives in the
  // --voice-panel-h custom property on <html> and is remembered per browser; the panel keeps at
  // least 140px of chat below it.
  const VOICE_PANEL_MIN = 180;
  const VOICE_PANEL_CHAT_MIN = 140;
  function wireVoiceSplitter(handleEl, panelEl) {
    if (!handleEl || !panelEl) return;
    const clamp = (h) => {
      const room = panelEl.parentElement.clientHeight - VOICE_PANEL_CHAT_MIN - handleEl.offsetHeight;
      return Math.max(VOICE_PANEL_MIN, Math.min(Math.max(VOICE_PANEL_MIN, room), h));
    };
    try {
      const saved = Number(localStorage.getItem('dismesh:voicePanelH'));
      if (saved) document.documentElement.style.setProperty('--voice-panel-h', `${saved}px`);
    } catch { /* ignore */ }
    let startY = 0;
    let startH = 0;
    const onMove = (e) => {
      document.documentElement.style.setProperty('--voice-panel-h', `${clamp(startH + e.clientY - startY)}px`);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      handleEl.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try { localStorage.setItem('dismesh:voicePanelH', String(Math.round(panelEl.offsetHeight))); } catch { /* ignore */ }
    };
    handleEl.addEventListener('mousedown', (e) => {
      startY = e.clientY;
      startH = panelEl.offsetHeight;
      handleEl.classList.add('dragging');
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
  }

  function wireSidebarResize() {
    wireResizeHandle(document.getElementById('sidebar-resize-handle'), '--sidebar-width', 'sidebarWidth', false);
    // #s-members has no real DOM child that would survive its own re-renders - the drag zone is
    // its ::before pseudo-element (see shell.css), so the mousedown listener lives on the element
    // itself, gated to only the pseudo's own strip of its left edge.
    const membersEl = document.getElementById('s-members');
    const membersHandle = {
      // e.offsetX is relative to e.target, which is whatever child happens to be under the
      // cursor (a pinned item, a member row, ...) - not membersEl itself - so this measures
      // against membersEl's own bounding box instead, which is unaffected by its content.
      addEventListener: (type, fn) => membersEl.addEventListener(type, (e) => {
        if (e.clientX - membersEl.getBoundingClientRect().left <= 6) fn(e);
      }),
      classList: membersEl.classList,
    };
    wireResizeHandle(membersHandle, '--members-width', 'membersWidth', true);
  }
  wireSidebarResize();

  function renderSidebar() {
    currentSidebar?.destroy?.();
    const host = document.getElementById('s-sidebar-content');
    const view = state.view;
    if (view.type === 'server') {
      const detail = getServerDetail(view.serverId);
      if (detail && detail.server.kind === 'site') currentSidebar = mountSiteSidebar(host, detail.server);
      else currentSidebar = detail ? mountChannelSidebar(host, detail) : null;
    } else if (view.type === 'remote') {
      currentSidebar = mountRemoteServer({ sidebarEl: host, mainEl: document.getElementById('s-main') }, view);
    } else {
      currentSidebar = mountHomeSidebar(host);
    }
  }

  function openEnableEncryptionModal(dm) {
    const other = dm.members[0];
    confirmModal({
      title: t('dmEncryption.panelTitle'),
      message: ['panelIntro', 'panelPermanent', 'panelNoEditForward', 'panelSearch', 'panelKeyLoss', 'panelSafetyNumbers']
        .map((k) => escapeHtml(t(`dmEncryption.${k}`))).join('<br><br>'),
      confirmLabel: t('dmEncryption.panelConfirm'),
      danger: false,
      async onConfirm() {
        try {
          if (!(await ensureOwnKeyPublished(state.me))) { toast(t('dmEncryption.needPassport'), { type: 'error' }); return; }
          await api.enableDmEncryption(dm.id);
          dm.e2eeEnabled = true;
          bus.emit('state:dms');
        } catch (err) {
          const code = err.body?.code;
          const text = code === 'e2ee_peer_key_missing' ? t('dmEncryption.peerNotReady', { name: other?.displayName || '' })
            : code === 'e2ee_federated' ? t('dmEncryption.federatedUnsupported')
              : apiErrorMessage(err, t('dmEncryption.enableFailed'));
          toast(text, { type: 'error', ttl: 8000 });
        }
      },
    });
  }

  function renderMain() {
    offDmHeader?.();
    offDmHeader = null;
    currentChat?.destroy?.();
    currentChat = null;
    currentMembers?.destroy?.();
    currentMembers = null;
    currentVoice?.destroy?.();
    currentVoice = null;
    const mainEl = document.getElementById('s-main');
    const membersEl = document.getElementById('s-members');
    const view = state.view;

    if (view.type === 'remote') {
      // The remote view renders its own main column (mounted with the sidebar); only the members slot is ours.
      membersEl.classList.add('collapsed');
      membersEl.innerHTML = '';
      return;
    }

    if (view.type === 'home') {
      membersEl.classList.remove('collapsed');
      membersEl.innerHTML = '';
      currentMembers = mountActivityPanel(membersEl);
      mainEl.innerHTML = `
        <div class="empty-state" style="height:100%">
          <div class="intro-icon" style="width:96px;height:96px">${icons.dismesh(48)}</div>
          <h3>${t('shell.noConversationSelected')}</h3>
          <p>${t('shell.pickFriendOrChannelHint')}</p>
        </div>`;
      return;
    }

    if (view.type === 'friends') {
      membersEl.classList.remove('collapsed');
      membersEl.innerHTML = '';
      currentMembers = mountActivityPanel(membersEl);
      mainEl.innerHTML = '';
      currentChat = mountFriends(mainEl, view.tab || 'online');
      return;
    }

    if (view.type === 'dm') {
      membersEl.classList.add('collapsed');
      const dm = state.dms.find((d) => d.id === view.dmId);
      const name = dm ? (dm.isGroup ? (dm.name || dm.members.map((m) => m.displayName).join(', ')) : (dm.members[0] ? nameFor(dm.members[0]) : '')) : t('shell.directMessageFallback');
      mainEl.innerHTML = `
        <div class="chat-header">
          <span class="ch-icon">${icons.users(20)}</span>
          <span class="ch-title">${escapeHtml(name || t('shell.directMessageFallback'))}</span>
          <span id="dm-e2ee-slot"></span>
          <div class="spacer"></div>
          <div class="header-actions">
            <button class="btn-icon" id="dm-call-btn" title="${t('shell.startCallTitle')}">${icons.phone(18)}</button>
            <button class="btn-icon" id="pins-btn" title="${t('shell.pinnedMessagesTitle')}">${icons.pin(18)}</button>
            <button class="btn-icon" id="search-btn" title="${t('shell.searchTitle')}">${icons.search(18)}</button>
            <button class="btn-icon" id="notif-bell" title="${t('shell.notificationSettingsTitle')}">${icons.bell(18)}</button>
            ${dm?.isGroup && dm.createdBy === state.me.id ? `<button class="btn-icon" id="dm-prune-btn" title="${t('shell.pruneGroupHistoryTitle')}">${icons.trash(18)}</button>` : ''}
          </div>
        </div>
        <div id="dm-voice-panel" class="voice-panel-combo" hidden></div>
        <div id="dm-voice-splitter" class="voice-splitter" hidden></div>
        <div id="chat-body" style="flex:1;display:flex;flex-direction:column;min-height:0"></div>`;
      mainEl.querySelector('#notif-bell').addEventListener('click', (e) => openNotifyMenu(e.currentTarget, 'dm', view.dmId));
      if (dm && !dm.isGroup && dm.members[0]) {
        const titleEl = mainEl.querySelector('.ch-title');
        titleEl.classList.add('clickable');
        titleEl.title = t('fullProfile.modalTitle');
        titleEl.addEventListener('click', () => openFullProfile(dm.members[0].id));
      }
      const e2eeSlot = mainEl.querySelector('#dm-e2ee-slot');
      const paintE2ee = () => {
        const cur = state.dms.find((d) => d.id === view.dmId);
        if (cur?.e2eeEnabled) {
          const view = trustView(cur.id);
          const shield = view?.status === 'changed' ? 'changed' : view?.verified ? 'verified' : 'unverified';
          e2eeSlot.innerHTML = `<span class="dm-e2ee-badge" title="${escapeHtml(t('dmEncryption.enabledTitle'))}">${icons.lock(14)} ${t('dmEncryption.enabledLabel')}</span>`
            + (view?.verified ? `<span class="dm-e2ee-badge dm-e2ee-verified" title="${escapeHtml(t('dmVerify.verifiedBadgeTitle'))}">${icons.check(14)} ${escapeHtml(t('dmVerify.verifiedBadge'))}</span>` : '')
            + `<button class="btn-icon dm-verify-btn ${shield}" id="dm-verify-btn" title="${escapeHtml(t(`dmVerify.shieldTitle_${shield}`))}">${icons.shield(18)}</button>`;
          e2eeSlot.querySelector('#dm-verify-btn').addEventListener('click', () => openVerifyModal(cur));
        } else if (cur?.e2eeEligible) {
          e2eeSlot.innerHTML = `<button class="btn-icon" id="dm-e2ee-btn" title="${escapeHtml(t('dmEncryption.enableButtonTitle'))}">${icons.lock(18)}</button>`;
          e2eeSlot.querySelector('#dm-e2ee-btn').addEventListener('click', () => openEnableEncryptionModal(cur));
        } else {
          e2eeSlot.innerHTML = '';
        }
      };
      paintE2ee();
      const offHeaderEvents = [bus.on('state:dms', paintE2ee), bus.on('e2ee:trust', ({ dmId }) => { if (dmId === view.dmId) paintE2ee(); })];
      offDmHeader = () => offHeaderEvents.forEach((off) => off());
      mainEl.querySelector('#dm-prune-btn')?.addEventListener('click', () => openDmPruneModal(dm));
      wirePanelToggles(membersEl, 'dm', view.dmId, [
        {
          btn: mainEl.querySelector('#pins-btn'), mode: 'pinned',
          mount: (onClose) => mountPinnedPanel(membersEl, 'dm', view.dmId, {
            canManage: true,
            onJump: (messageId) => bus.emit('ui:navigate', { type: 'dm', dmId: view.dmId, jumpToMessageId: messageId }),
            onClose,
          }),
        },
        {
          btn: mainEl.querySelector('#search-btn'), mode: 'search',
          mount: (onClose) => mountSearchPanel(membersEl, { kind: 'dm', dmId: view.dmId }, {
            onJump: (m) => bus.emit('ui:navigate', { type: 'dm', dmId: view.dmId, jumpToMessageId: m.id }),
            onClose,
          }),
        },
      ], () => { membersEl.classList.add('collapsed'); membersEl.innerHTML = ''; currentMembers?.destroy?.(); currentMembers = null; });

      // Invite-only DM/group call: joining requires DM membership server-side, and it never
      // touches the friends-activity/member-list presence broadcasts a server voice channel does.
      const voicePanelEl = mainEl.querySelector('#dm-voice-panel');
      const callBtn = mainEl.querySelector('#dm-call-btn');
      const dmSplitterEl = mainEl.querySelector('#dm-voice-splitter');
      wireVoiceSplitter(dmSplitterEl, voicePanelEl);
      const setCallPanelOpen = (open) => {
        dmSplitterEl.hidden = !open;
        if (open) {
          voicePanelEl.hidden = false;
          currentVoice = mountVoiceChannel(voicePanelEl, { dmId: view.dmId, dmName: name });
          callBtn.classList.add('active-danger');
          callBtn.title = t('shell.closeCallPanelTitle');
        } else {
          currentVoice?.destroy?.();
          currentVoice = null;
          voicePanelEl.hidden = true;
          voicePanelEl.innerHTML = '';
          callBtn.classList.remove('active-danger');
          callBtn.title = t('shell.startCallTitle');
        }
      };
      callBtn.addEventListener('click', () => setCallPanelOpen(voicePanelEl.hidden));
      if (view.autoOpenCall) setCallPanelOpen(true);

      currentChat = mountChat(document.getElementById('chat-body'), { kind: 'dm', dmId: view.dmId, canSend: true, canManage: false, jumpToMessageId: view.jumpToMessageId }, {
        emptyTitle: name ? t('shell.dmHistoryBeginning', { name }) : t('shell.sayHello'),
        emptyBody: t('shell.noMessagesYet'),
      });
      return;
    }

    if (view.type === 'server') {
      const detail = getServerDetail(view.serverId);
      if (!detail) { mainEl.innerHTML = `<div class="panel-loading"><div class="spinner"></div></div>`; return; }

      if (detail.server.kind === 'site') {
        membersEl.classList.add('collapsed');
        membersEl.innerHTML = '';
        currentChat = mountSite(mainEl, { server: detail.server });
        return;
      }

      const isOwner = detail.server.owner_id === state.me.id;
      const myMember = detail.members.find((m) => m.user.id === state.me.id);
      const memberBits = memberPermissionBits(detail.server, detail.roles, myMember, state.me.id);

      if (view.welcome) {
        membersEl.classList.add('collapsed');
        renderWelcomeScreen(detail, isOwner || has(memberBits, PERMISSIONS.MANAGE_SERVER));
        return;
      }

      const channel = detail.channels.find((c) => c.id === view.channelId);
      if (!channel) { mainEl.innerHTML = `<div class="empty-state"><p>${t('shell.channelNotFound')}</p></div>`; return; }

      const chBits = channelPermissionBits(channel, detail.roles, myMember, memberBits, isOwner);
      const canSend = has(chBits, PERMISSIONS.SEND_MESSAGES);
      const canManage = has(chBits, PERMISSIONS.MANAGE_MESSAGES);
      const canManageChannel = has(chBits, PERMISSIONS.MANAGE_CHANNELS);
      const canModerateVoice = has(chBits, PERMISSIONS.MODERATE_MEMBERS);
      const showInviteBtn = channel.type === 'private' && canManageChannel;

      if (view.threadId) {
        renderThreadInline(detail, channel, view, { canSend, canManage, canManageChannel });
        return;
      }

      mainEl.innerHTML = `
        <div class="chat-header">
          <span class="ch-icon">${channel.icon_path ? `<img src="${escapeHtml(channel.icon_path)}" style="width:20px;height:20px;border-radius:5px;object-fit:cover">` : iconForType(channel.type)}</span>
          <span class="ch-title">${escapeHtml(channel.name)}</span>
          ${channel.topic ? `<span class="ch-topic">${escapeHtml(channel.topic)}</span>` : '<div class="spacer"></div>'}
          <div class="header-actions">
            ${showInviteBtn ? `<button class="btn-icon" id="invite-member-btn" title="${t('shell.inviteMemberTitle')}">${icons.userPlus(18)}</button>` : ''}
            <button class="btn-icon" id="threads-btn" title="${t('shell.threadsTitle')}">${icons.messageSquare(18)}</button>
            <button class="btn-icon" id="pins-btn" title="${t('shell.pinnedMessagesTitle')}">${icons.pin(18)}</button>
            <button class="btn-icon" id="search-btn" title="${t('shell.searchTitle')}">${icons.search(18)}</button>
            <button class="btn-icon" id="notif-bell" title="${t('shell.notificationSettingsTitle')}">${icons.bell(18)}</button>
            <button class="btn-icon" id="toggle-members" title="${t('shell.memberListTitle')}">${icons.users(20)}</button>
          </div>
        </div>
        <div id="chat-body" style="flex:1;display:flex;flex-direction:column;min-height:0"></div>`;

      document.getElementById('notif-bell').addEventListener('click', (e) => openNotifyMenu(e.currentTarget, 'channel', view.channelId));
      document.getElementById('invite-member-btn')?.addEventListener('click', () => openInviteMemberModal(view.serverId, channel));
      const restoreMemberList = () => {
        membersEl.classList.remove('collapsed');
        membersEl.innerHTML = '';
        currentMembers?.destroy?.();
        currentMembers = mountMemberList(membersEl, { server: detail.server, roles: detail.roles, members: detail.members }, {
          onClose: () => membersEl.classList.add('collapsed'),
        });
      };
      wirePanelToggles(membersEl, 'channel', view.channelId, [
        {
          btn: document.getElementById('threads-btn'), mode: 'threads',
          mount: (onClose) => mountThreadsPanel(membersEl, view.serverId, view.channelId, {
            onOpen: (threadId) => bus.emit('ui:navigate', { type: 'server', serverId: view.serverId, channelId: view.channelId, threadId }),
            onClose,
          }),
        },
        {
          btn: document.getElementById('pins-btn'), mode: 'pinned',
          mount: (onClose) => mountPinnedPanel(membersEl, 'channel', view.channelId, {
            canManage,
            onJump: (messageId) => bus.emit('ui:navigate', { type: 'server', serverId: view.serverId, channelId: view.channelId, jumpToMessageId: messageId }),
            onClose,
          }),
        },
        {
          btn: document.getElementById('search-btn'), mode: 'search',
          mount: (onClose) => mountSearchPanel(membersEl, { kind: 'channel', serverId: view.serverId, channelId: view.channelId, channels: detail.channels }, {
            onJump: (m) => (m.scopeType === 'thread'
              ? bus.emit('ui:navigate', { type: 'server', serverId: view.serverId, channelId: m.channelId, threadId: m.scopeId, jumpToMessageId: m.id })
              : bus.emit('ui:navigate', { type: 'server', serverId: view.serverId, channelId: m.scopeId, jumpToMessageId: m.id })),
            onClose,
          }),
        },
      ], restoreMemberList);
      document.getElementById('toggle-members').addEventListener('click', () => {
        membersEl.classList.toggle('collapsed');
      });

      if (channel.type === 'forum') {
        currentChat = mountForum(document.getElementById('chat-body'), {
          serverId: view.serverId, channelId: view.channelId, channelName: channel.name, canSend, canManage,
          channels: detail.channels, customEmoji: detail.customEmoji, stickers: detail.stickers, rawHtmlEnabled: !!detail.server.raw_html_enabled,
          roles: detail.roles, members: detail.members,
        });
      } else if (channel.type === 'notes') {
        mainEl.querySelectorAll('#threads-btn, #pins-btn, #search-btn, #notif-bell').forEach((b) => { b.style.display = 'none'; });
        currentChat = mountNotes(document.getElementById('chat-body'), {
          serverId: view.serverId, channelId: view.channelId, channelName: channel.name,
          canTrim: canManageChannel || has(chBits, PERMISSIONS.PRUNE_CONTENT),
        });
      } else if (channel.type === 'voice') {
        // Voice channels get the participant grid/controls up top plus the full text chat below
        // it — same as Discord, not one-or-the-other.
        const chatBody = document.getElementById('chat-body');
        chatBody.innerHTML = `
          <div id="voice-panel" class="voice-panel-combo"></div>
          <div id="voice-splitter" class="voice-splitter" title="${escapeHtml(t('voice.resizePanelTitle'))}"></div>
          <div id="voice-chat-body" style="flex:1;display:flex;flex-direction:column;min-height:0"></div>`;
        wireVoiceSplitter(document.getElementById('voice-splitter'), document.getElementById('voice-panel'));
        currentVoice = mountVoiceChannel(document.getElementById('voice-panel'), {
          serverId: view.serverId, channelId: view.channelId, channelName: channel.name, sounds: detail.sounds, canModerateVoice, voiceQuality: channel.voice_quality,
        });
        currentChat = mountChat(document.getElementById('voice-chat-body'), {
          kind: 'channel', serverId: view.serverId, channelId: view.channelId, canSend, canManage, channelType: channel.type, channelName: channel.name, channels: detail.channels, customEmoji: detail.customEmoji, stickers: detail.stickers, rawHtmlEnabled: !!detail.server.raw_html_enabled,
        }, {
          emptyTitle: t('shell.welcomeToChannel', { channel: channel.name }),
          emptyBody: channel.topic || t('shell.startOfChannel'),
        });
      } else if (channel.type === 'stage') {
        // No text chat at all here (server backstops this too, see channelAccess.js) — a stage is
        // just the speaker/audience voice panel, full height.
        document.getElementById('chat-body').innerHTML = `<div id="voice-panel" class="voice-panel-full"></div>`;
        currentVoice = mountVoiceChannel(document.getElementById('voice-panel'), {
          serverId: view.serverId, channelId: view.channelId, channelName: channel.name, channelType: 'stage', canManageChannel, canModerateVoice, voiceQuality: channel.voice_quality,
        });
      } else {
        currentChat = mountChat(document.getElementById('chat-body'), {
          kind: 'channel', serverId: view.serverId, channelId: view.channelId, canSend, canManage, channelType: channel.type, channelName: channel.name, channels: detail.channels, customEmoji: detail.customEmoji, stickers: detail.stickers, jumpToMessageId: view.jumpToMessageId, rawHtmlEnabled: !!detail.server.raw_html_enabled,
        }, {
          emptyTitle: t('shell.welcomeToChannelHash', { channel: channel.name }),
          emptyBody: channel.topic || t('shell.startOfChannel'),
        });
      }
    }
  }

  // A server's welcome screen (servers.welcome_enabled) — an intro message plus a curated,
  // admin-picked list of channels to jump into. It's not a one-time join step; it lives as a
  // permanent "Welcome" row above the channel list (see sidebar.js) that any member can revisit.
  function renderWelcomeScreen(detail, canManage) {
    const mainEl = document.getElementById('s-main');
    const server = detail.server;
    const welcomeChannels = detail.welcomeChannels || [];
    mainEl.innerHTML = `
      <div class="chat-header">
        <span class="ch-icon">${icons.flag(20)}</span>
        <span class="ch-title">${t('shell.welcomeLabel')}</span>
        <div class="spacer"></div>
        ${canManage ? `<div class="header-actions"><button class="btn-icon" id="wl-edit" title="${t('shell.editWelcomeScreenTitle')}">${icons.gear(18)}</button></div>` : ''}
      </div>
      <div style="flex:1;overflow-y:auto;padding:40px 24px">
        <div style="max-width:480px;margin:0 auto;text-align:center">
          <div class="intro-icon" style="width:72px;height:72px;margin:0 auto 16px">${icons.flag(36)}</div>
          <h2 style="margin:0 0 8px">${t('shell.welcomeToServer', { server: escapeHtml(server.name) })}</h2>
          ${server.welcome_message ? `<p style="color:var(--text-muted);white-space:pre-wrap">${escapeHtml(server.welcome_message)}</p>` : ''}
        </div>
        <div style="max-width:480px;margin:24px auto 0;display:flex;flex-direction:column;gap:8px">
          ${welcomeChannels.length ? welcomeChannels.map((wc) => {
            const ch = detail.channels.find((c) => c.id === wc.channel_id);
            if (!ch) return '';
            return `
              <div class="list-row" data-wl-channel="${ch.id}" style="cursor:pointer">
                <div style="width:32px;height:32px;border-radius:50%;background:var(--bg-active);display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0">${escapeHtml(wc.emoji) || iconForType(ch.type)}</div>
                <div class="lr-main">
                  <div class="lr-title">#${escapeHtml(ch.name)}</div>
                  ${wc.description ? `<div class="lr-sub">${escapeHtml(wc.description)}</div>` : ''}
                </div>
                ${icons.chevronRight(16)}
              </div>`;
          }).join('') : `<div class="empty-state" style="height:auto;padding:24px 0"><p>${canManage ? t('shell.addChannelsHint') : t('shell.nothingHighlightedYet')}</p></div>`}
        </div>
      </div>`;

    mainEl.querySelectorAll('[data-wl-channel]').forEach((node) => {
      node.addEventListener('click', () => {
        bus.emit('ui:navigate', { type: 'server', serverId: server.id, channelId: Number(node.dataset.wlChannel) });
      });
    });
    mainEl.querySelector('#wl-edit')?.addEventListener('click', () => openServerSettings(server.id, { tab: 'welcome' }));
  }

  // Viewing one thread (a forum post, or a thread spun off a channel message) inline — same
  // chat-header/chat-body layout as any other channel, not a floating panel. A back arrow
  // returns to the parent channel (the forum's post list, or the regular channel it branched
  // from); the thread's own opening message renders highlighted at the top of the message list
  // (see chat.js's `thread-op` class) so it reads like a pinned "main post", not just message #1.
  function renderThreadInline(detail, channel, view, { canSend, canManage, canManageChannel }) {
    const mainEl = document.getElementById('s-main');
    const membersEl = document.getElementById('s-members');
    mainEl.innerHTML = `
      <div class="chat-header">
        <button class="btn-icon" id="thread-back-btn" title="${t('shell.backToChannel', { channel: escapeHtml(channel.name) })}">${icons.chevronsLeft(18)}</button>
        <span class="ch-icon" id="thread-icon-el">${icons.messageSquare(18)}</span>
        <span class="ch-title" id="thread-title-el">…</span>
        <button class="btn-icon" id="thread-icon-edit-btn" title="${t('shell.threadIconTitle')}" style="display:none">${icons.image(14)}</button>
        <button class="btn-icon" id="thread-delete-btn" title="${t('shell.deleteThreadTitle')}" style="display:none;color:var(--danger)">${icons.trash(14)}</button>
        <input type="file" id="thread-icon-input" accept="image/png,image/jpeg,image/gif,image/webp" style="display:none">
        <span class="ch-topic" id="thread-parent-el">${t('shell.inChannel', { channel: escapeHtml(channel.name) })}</span>
        <div class="spacer"></div>
        <div class="header-actions">
          <button class="btn-icon" id="threads-btn" title="${t('shell.threadsTitle')}">${icons.messageSquare(18)}</button>
          <button class="btn-icon" id="pins-btn" title="${t('shell.pinnedMessagesTitle')}">${icons.pin(18)}</button>
          <button class="btn-icon" id="search-btn" title="${t('shell.searchTitle')}">${icons.search(18)}</button>
          <button class="btn-icon" id="toggle-members" title="${t('shell.memberListTitle')}">${icons.users(20)}</button>
        </div>
      </div>
      <div id="chat-body" style="flex:1;display:flex;flex-direction:column;min-height:0"></div>`;

    document.getElementById('thread-back-btn').addEventListener('click', () => {
      bus.emit('ui:navigate', { type: 'server', serverId: view.serverId, channelId: view.channelId });
    });
    const restoreMemberList = () => {
      membersEl.classList.remove('collapsed');
      membersEl.innerHTML = '';
      currentMembers?.destroy?.();
      currentMembers = mountMemberList(membersEl, { server: detail.server, roles: detail.roles, members: detail.members }, {
        onClose: () => membersEl.classList.add('collapsed'),
      });
    };
    wirePanelToggles(membersEl, 'thread', view.threadId, [
      {
        btn: document.getElementById('threads-btn'), mode: 'threads',
        mount: (onClose) => mountThreadsPanel(membersEl, view.serverId, view.channelId, {
          onOpen: (threadId) => bus.emit('ui:navigate', { type: 'server', serverId: view.serverId, channelId: view.channelId, threadId }),
          onClose,
        }),
      },
      {
        btn: document.getElementById('pins-btn'), mode: 'pinned',
        mount: (onClose) => mountPinnedPanel(membersEl, 'thread', view.threadId, {
          canManage,
          onJump: (messageId) => bus.emit('ui:navigate', { type: 'server', serverId: view.serverId, channelId: view.channelId, threadId: view.threadId, jumpToMessageId: messageId }),
          onClose,
        }),
      },
      {
        btn: document.getElementById('search-btn'), mode: 'search',
        mount: (onClose) => mountSearchPanel(membersEl, { kind: 'channel', serverId: view.serverId, channelId: view.channelId, channels: detail.channels }, {
          onJump: (m) => (m.scopeType === 'thread'
            ? bus.emit('ui:navigate', { type: 'server', serverId: view.serverId, channelId: m.channelId, threadId: m.scopeId, jumpToMessageId: m.id })
            : bus.emit('ui:navigate', { type: 'server', serverId: view.serverId, channelId: m.scopeId, jumpToMessageId: m.id })),
          onClose,
        }),
      },
    ], restoreMemberList);
    document.getElementById('toggle-members').addEventListener('click', () => membersEl.classList.toggle('collapsed'));

    let archived = false;
    const renderThreadIcon = (thread) => {
      const iconEl = document.getElementById('thread-icon-el');
      if (!iconEl) return;
      iconEl.innerHTML = thread.iconPath
        ? `<img src="${escapeHtml(thread.iconPath)}" style="width:18px;height:18px;border-radius:50%;object-fit:cover">`
        : avatarHtml(thread.createdBy, 18);
    };
    api.getThread(view.serverId, view.channelId, view.threadId).then((res) => {
      // The view may have already moved on (navigated elsewhere) by the time this resolves.
      if (state.view.type !== 'server' || state.view.threadId !== view.threadId) return;
      document.getElementById('thread-title-el').textContent = res.thread.title;
      renderThreadIcon(res.thread);
      archived = res.thread.archived;
      if (archived) {
        const parentEl = document.getElementById('thread-parent-el');
        if (parentEl) parentEl.textContent += t('shell.archivedSuffix');
      }
      const canEditIcon = res.thread.createdBy.id === state.me.id || canManageChannel;
      const deleteBtn = document.getElementById('thread-delete-btn');
      if (canEditIcon && deleteBtn) {
        deleteBtn.style.display = '';
        deleteBtn.addEventListener('click', () => confirmModal({
          title: t('shell.deleteThreadTitle'),
          message: t('shell.deleteThreadMessage', { title: escapeHtml(res.thread.title) }),
          confirmLabel: t('common.delete'),
          onConfirm: async () => {
            try { await api.deleteThread(view.serverId, view.channelId, view.threadId); }
            catch (err) { toast(apiErrorMessage(err), { type: 'error' }); }
          },
        }));
      }
      const editBtn = document.getElementById('thread-icon-edit-btn');
      const fileInput = document.getElementById('thread-icon-input');
      if (canEditIcon && editBtn && fileInput) {
        editBtn.style.display = '';
        editBtn.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', async () => {
          const file = fileInput.files?.[0];
          fileInput.value = '';
          if (!file) return;
          try {
            const uploaded = await api.uploadThreadIcon(view.serverId, view.channelId, view.threadId, file);
            renderThreadIcon(uploaded.thread);
          } catch (err) {
            toast(apiErrorMessage(err), { type: 'error' });
          }
        });
      }
    }).catch(() => {});

    currentChat = mountChat(document.getElementById('chat-body'), {
      kind: 'thread', serverId: view.serverId, channelId: view.channelId, threadId: view.threadId,
      canSend, canManage, channels: detail.channels, customEmoji: detail.customEmoji, stickers: detail.stickers, jumpToMessageId: view.jumpToMessageId, rawHtmlEnabled: !!detail.server.raw_html_enabled,
    }, {
      emptyTitle: t('shell.startOfThread'),
      emptyBody: '',
    });
  }

  function mountTopBar() {
    const iconEl = document.getElementById('topbar-icon');
    const titleEl = document.getElementById('topbar-title');

    function renderTitle() {
      const view = state.view;
      let icon = icons.dismesh(18);
      let title = 'MeshCrowd';
      if (view.type === 'home') { icon = icons.home(18); title = t('shell.directMessagesLabel'); }
      else if (view.type === 'friends') { icon = icons.users(18); title = t('shell.friendsLabel'); }
      else if (view.type === 'dm') {
        const dm = state.dms.find((d) => d.id === view.dmId);
        icon = icons.users(18);
        title = dm ? (dm.isGroup ? (dm.name || dm.members.map((m) => m.displayName).join(', ')) : dm.members[0]?.displayName) : t('shell.directMessageFallback');
      } else if (view.type === 'remote') {
        const info = getRemoteInfo(view.peerId, view.serverId);
        icon = icons.globe(18);
        title = info?.channels.find((c) => c.id === view.channelId)?.name || info?.server.name || t('remote.serverFallback');
      } else if (view.type === 'server') {
        const detail = getServerDetail(view.serverId);
        if (view.welcome) {
          icon = icons.flag(18);
          title = t('shell.welcomeLabel');
        } else if (detail?.server.kind === 'site') {
          icon = icons.globe(18);
          title = detail.server.name;
        } else {
          const channel = detail?.channels.find((c) => c.id === view.channelId);
          icon = channel ? iconForType(channel.type) : icons.hash(18);
          title = channel ? channel.name : (detail?.server.name || t('shell.serverFallback'));
        }
      }
      iconEl.innerHTML = icon;
      titleEl.textContent = title;
    }
    renderTitle();
    bus.on('state:view', renderTitle);
    bus.on('state:serverDetail', renderTitle);
    bus.on('remote:info', renderTitle);
    bus.on('state:dms', renderTitle);

    document.getElementById('topbar-newdm').addEventListener('click', openNewDmModal);
    document.getElementById('topbar-help').addEventListener('click', openAboutModal);

    // State shared across every click (not re-created per click) — an early-return second click
    // ("close it") must reach the SAME closeInboxPopover from the first click's open, not a fresh
    // one whose own `activity`/`inboxPopover` were never assigned on this invocation's path.
    let inboxPopover = null;
    let inboxActivity = null;
    function onInboxOutsideClick(ev) {
      // Ignore the inbox button itself — its own click handler already toggles the popover, and
      // since mousedown fires before click, this listener would otherwise close it a beat before
      // the button's handler re-opens it, making the toggle-to-close gesture never actually stick.
      if (ev.target.closest('#topbar-inbox')) return;
      if (inboxPopover && !inboxPopover.contains(ev.target)) closeInboxPopover();
    }
    function closeInboxPopover() {
      inboxActivity?.destroy();
      inboxPopover?.remove();
      inboxPopover = null;
      inboxActivity = null;
      document.removeEventListener('mousedown', onInboxOutsideClick);
    }
    document.getElementById('topbar-inbox').addEventListener('click', (e) => {
      if (inboxPopover) { closeInboxPopover(); return; }
      const rect = e.currentTarget.getBoundingClientRect();
      inboxPopover = document.createElement('div');
      inboxPopover.className = 'topbar-popover member-list';
      inboxPopover.style.top = `${rect.bottom + 8}px`;
      inboxPopover.style.right = `${window.innerWidth - rect.right}px`;
      document.body.appendChild(inboxPopover);
      inboxActivity = mountActivityPanel(inboxPopover);
      setTimeout(() => document.addEventListener('mousedown', onInboxOutsideClick), 0);
    });
  }

  // Friends are always listed (regardless of their own discoverable setting — you already know
  // each other); anyone else only turns up via search, and only if they haven't hidden
  // themselves from search (users.discoverable), same rule the friend-request finder already
  // uses. Picking someone grants immediate access — no invite code to copy/paste.
  function openInviteMemberModal(serverId, channel) {
    let results = null;
    let inviting = new Set();

    openModal({
      title: t('shell.inviteToChannel', { channel: channel.name }),
      render(body) {
        draw();
        function draw() {
          const friends = state.friends.friends.map((f) => f.user);
          body.innerHTML = `
            <div class="field">
              <input class="input" id="im-search" placeholder="${t('shell.searchByUsernamePlaceholder')}">
            </div>
            <div id="im-list"></div>`;
          renderList(friends);

          const searchInput = body.querySelector('#im-search');
          const doSearch = debounce(async () => {
            const q = searchInput.value.trim();
            if (!q) { renderList(friends); return; }
            try { results = (await api.searchUsers(q)).users; } catch { results = []; }
            renderList(results);
          }, 250);
          searchInput.addEventListener('input', doSearch);
        }

        function renderList(users) {
          const listEl = body.querySelector('#im-list');
          if (!listEl) return;
          if (users.length === 0) {
            listEl.innerHTML = `<div class="empty-state" style="padding:20px 0"><p>${t('shell.noOneFound')}</p></div>`;
            return;
          }
          listEl.innerHTML = users.map((u) => `
            <div class="list-row">
              ${avatarHtml(u, 36)}
              <div class="lr-main"><div class="lr-title">${escapeHtml(u.displayName)}</div><div class="lr-sub">@${escapeHtml(u.username)}</div></div>
              <button class="btn btn-secondary" data-invite-user="${u.id}" ${inviting.has(u.id) ? 'disabled' : ''}>${inviting.has(u.id) ? t('shell.invitedButton') : t('shell.inviteButton')}</button>
            </div>`).join('');
          listEl.querySelectorAll('[data-invite-user]').forEach((btn) => {
            btn.addEventListener('click', async () => {
              const userId = Number(btn.dataset.inviteUser);
              btn.disabled = true;
              btn.textContent = t('shell.invitingButton');
              try {
                await api.directInviteToChannel(serverId, channel.id, userId);
                inviting.add(userId);
                btn.textContent = t('shell.invitedButton');
                toast(t('shell.inviteSentToast'));
              } catch (err) {
                btn.disabled = false;
                btn.textContent = t('shell.inviteButton');
                toast(apiErrorMessage(err, t('shell.couldNotInviteUser')), { type: 'error' });
              }
            });
          });
        }
      },
    });
  }

  function openAboutModal() {
    openModal({
      title: t('shell.aboutMeshcordTitle'),
      render(body) {
        body.innerHTML = `
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
            <div style="width:48px;height:48px;color:var(--brand)">${icons.dismesh(48)}</div>
            <div><div style="font-weight:700;font-size:18px">MeshCrowd <span style="font-weight:400;font-size:13px;color:var(--text-muted)">v${escapeHtml(state.config.version || '0.0.0')}</span></div><div style="color:var(--text-muted);font-size:13px">${t('shell.aboutTagline')}</div></div>
          </div>
          <p style="color:var(--text-secondary);font-size:14px;line-height:1.6">
            ${t('shell.aboutDescription')}
          </p>
          <div class="activity-section-label" style="margin-top:16px">${t('shell.keyboardShortcutsLabel')}</div>
          <p style="color:var(--text-secondary);font-size:13px;line-height:1.8">
            <strong>Enter</strong> ${t('shell.shortcutSend')} &nbsp;·&nbsp; <strong>Shift+Enter</strong> ${t('shell.shortcutNewLine')}<br>
            <strong>↑</strong> ${t('shell.shortcutEditLast')}<br>
            <strong>Esc</strong> ${t('shell.shortcutCloseModal')}
          </p>`;
      },
    });
  }

  function notifOptions() {
    return [
      { value: 'all', label: t('shell.allMessagesOption') },
      { value: 'mentions', label: t('shell.onlyMentionsOption') },
      { value: 'mute', label: t('shell.nothingOption') },
    ];
  }
  function openNotifyMenu(anchor, scopeType, scopeId) {
    const rect = anchor.getBoundingClientRect();
    const current = notificationPrefFor(scopeType, scopeId);
    openContextMenu(rect.right - 180, rect.bottom + 4, notifOptions().map((opt) => ({
      label: `${opt.value === current ? '✓ ' : ''}${opt.label}`,
      onClick: async () => {
        try {
          await api.setNotificationPref(scopeType, scopeId, opt.value);
          setNotificationPref(scopeType, scopeId, opt.value);
        } catch { toast(t('shell.couldNotUpdateNotifPref'), { type: 'error' }); }
      },
    })));
  }

  function iconForType(type) {
    return { public: icons.hash, private: icons.lock, announcement: icons.megaphone, readonly: icons.eye, voice: icons.headphones, forum: icons.messageSquare, stage: icons.stage, notes: icons.book }[type]?.(20) || icons.hash(20);
  }

  // ---------------- initial data load ----------------
  let landingView = 'home';
  try {
    const [serversRes, dmsRes, friendsRes, prefsRes, config, readStateRes, layoutRes, themeRes, uiPrefsRes, serverPrefsRes, annotationsRes, dmPrefsRes, bookmarkIdsRes] = await Promise.all([
      api.listServers(), api.listDms(), api.friends(), api.getNotificationPrefs(), api.config(), api.getReadState(), api.getServerLayout(), api.getTheme(), api.getUiPrefs(), api.getServerPrefs(),
      api.getUserAnnotations(), api.getDmPrefs(), api.getBookmarkIds(),
    ]);
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
    if (uiPrefsRes.uiPrefs.sidebarWidth) document.documentElement.style.setProperty('--sidebar-width', `${uiPrefsRes.uiPrefs.sidebarWidth}px`);
    if (uiPrefsRes.uiPrefs.membersWidth) document.documentElement.style.setProperty('--members-width', `${uiPrefsRes.uiPrefs.membersWidth}px`);
    landingView = uiPrefsRes.uiPrefs.landingView || 'home';
    state.uiPrefs = uiPrefsRes.uiPrefs;
    pushTrayLabels();
    pushUnreadBadge();
  } catch {
    toast(t('shell.couldNotLoadServers'), { type: 'error' });
  }

  refreshRemoteServers();
  setInterval(refreshRemoteServers, 60_000);

  if (window.dismeshClient) {
    window.dismeshClient.onNavigateTo((n) => {
      bus.emit('ui:navigate', n.scopeType === 'dm'
        ? { type: 'dm', dmId: n.scopeId }
        : n.scopeType === 'friends'
          ? { type: 'friends', tab: n.scopeId }
          : { type: 'server', serverId: n.serverId, channelId: n.scopeId });
    });
    window.dismeshClient.onRequestLogout(async () => {
      try { await api.logout(); } catch { /* ignore */ }
      clearCachedIdentity();
      location.reload();
    });
  }

  ws.connect();
  let startView = { type: 'home' };
  if (landingView === 'lastLocation') {
    try {
      const saved = JSON.parse(localStorage.getItem('dismesh:lastLocation') || 'null');
      if (saved && ((saved.type === 'server' && saved.channelId) || (saved.type === 'dm' && saved.dmId))) {
        startView = { type: saved.type, serverId: saved.serverId, channelId: saved.channelId, threadId: saved.threadId, dmId: saved.dmId };
      }
    } catch { /* ignore, fall back to home */ }
  }
  navigate(startView);

  // Links produced by "Copy message link" (#msg=channel:server:channel:message, #msg=thread:server:channel:thread:message,
  // #msg=dm:dm:message) and "Share profile" (#user=id). The hash is consumed so a refresh does not replay it.
  function handleDeepLink() {
    const hash = location.hash;
    if (!hash) return;
    const inviteCode = parseInviteHash(hash);
    if (inviteCode) {
      history.replaceState(null, '', location.pathname + location.search);
      return openInviteLink(inviteCode);
    }
    const msg = hash.match(/^#msg=(channel|thread|dm):(\d+(?::\d+)*)$/);
    const user = hash.match(/^#user=(\d+)$/);
    if (!msg && !user) return;
    history.replaceState(null, '', location.pathname + location.search);
    if (user) return openProfileModal(Number(user[1]));
    const [kind, rest] = [msg[1], msg[2].split(':').map(Number)];
    if (kind === 'dm' && rest.length === 2) bus.emit('ui:navigate', { type: 'dm', dmId: rest[0], jumpToMessageId: rest[1] });
    else if (kind === 'channel' && rest.length === 3) bus.emit('ui:navigate', { type: 'server', serverId: rest[0], channelId: rest[1], jumpToMessageId: rest[2] });
    else if (kind === 'thread' && rest.length === 4) bus.emit('ui:navigate', { type: 'server', serverId: rest[0], channelId: rest[1], threadId: rest[2], jumpToMessageId: rest[3] });
  }
  async function openInviteLink(code) {
    let info = null;
    try { info = await peekInvite(code); } catch (err) { return toast(apiErrorMessage(err, t('serverRail.invalidInviteCode')), { type: 'error' }); }
    confirmModal({
      title: info ? t('invites.joinConfirmTitle', { name: info.name }) : t('invites.joinConfirmTitleGeneric'),
      message: info
        ? [t('invites.joinConfirmBody', { name: escapeHtml(info.name) }),
          info.channelName ? t('invites.joinConfirmChannel', { channel: escapeHtml(info.channelName) }) : '',
          info.memberCount !== null ? t('invites.joinConfirmMembers', { count: info.memberCount }) : ''].filter(Boolean).join(' ')
        : t('invites.joinConfirmGeneric', { code: escapeHtml(code) }),
      confirmLabel: t('serverRail.joinButton'),
      danger: false,
      async onConfirm() {
        try { await joinWithCode(code); } catch (err) { toast(apiErrorMessage(err, t('serverRail.invalidInviteCode')), { type: 'error' }); }
      },
    });
  }
  handleDeepLink();
  window.addEventListener('hashchange', handleDeepLink);
}
