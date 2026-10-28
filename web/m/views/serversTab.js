import { api } from '../../js/api.js';
import { bus } from '../../js/bus.js';
import { icons } from '../../js/icons.js';
import { t } from '../../js/i18n.js';
import { avatarHtml, escapeHtml, serverIconHtml, toast } from '../../js/utils.js';
import {
  state, getKnownUser, isUnread, isChannelMuted, setServerPrefs, setServers, removeServer, setReadState, setNotificationPref as setPrefState,
} from '../../js/state.js';
import { nav } from '../router.js';
import { ensureServerDetail, refreshServerDetailSilently } from '../data.js';
import { openScreeningSheet } from '../components/screeningSheet.js';
import { handleError } from '../lib/errors.js';
import { onLongPress } from '../lib/longPress.js';
import { actionSheet, confirmSheet, promptSheet, openSheet } from '../components/bottomSheet.js';
import { PERMISSIONS, has, memberPermissionBits } from '../../js/permissions.js';
import { openServerSettings } from '../../js/views/serverSettings.js';
import { openEventsModal } from '../../js/views/events.js';
import { confirmLeaveRemote } from '../../js/views/remoteServer.js';

const TYPE_ICON = { public: 'hash', private: 'lock', announcement: 'megaphone', readonly: 'eye', voice: 'headphones', forum: 'messageSquare', stage: 'stage', notes: 'book' };
const CHAT_TYPES = new Set(['public', 'private', 'announcement', 'readonly']);

const serverUnread = (id) => {
  const d = state.serverDetail.get(id);
  return !!d && d.channels.some((c) => isUnread('channel', c.id, c.last_message_id) && !isChannelMuted(id, c.id));
};

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return; } catch { /* insecure context or denied: fall back */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
}

const screeningShown = new Set(); // servers whose rules prompt was already offered this session

export function mountServersTab(host) {
  let sid = state.servers.some((s) => s.id === state.lastServerId) ? state.lastServerId : (state.servers[0]?.id ?? null);
  let destroyed = false;
  host.innerHTML = '<div class="m-servers"><div class="m-rail" id="m-rail"></div><div class="m-chanpane" id="m-chanpane"></div></div>';
  const rail = host.querySelector('#m-rail');
  const pane = host.querySelector('#m-chanpane');

  function paintRail() {
    rail.innerHTML = state.servers.map((s) => `
      <button class="m-rail-item${s.id === sid ? ' active' : ''}" data-sid="${s.id}" aria-label="${escapeHtml(s.name)}">
        ${serverIconHtml(s, 44)}${serverUnread(s.id) && s.id !== sid ? '<i class="m-rail-dot"></i>' : ''}
      </button>`).join('')
      + state.remoteServers.map((r) => `
      <button class="m-rail-item m-rail-remote${r.reachable === false ? ' offline' : ''}" data-remote="${r.peerId}:${r.serverId}" aria-label="${escapeHtml(r.name)}">
        <span class="m-remote-badge">${escapeHtml((r.name || '?').slice(0, 1).toUpperCase())}${icons.globe(12)}</span></button>`).join('')
      + `<button class="m-rail-item m-rail-add" id="m-add" aria-label="${t('m.addServer')}">${icons.plus(22)}</button>`;
  }

  async function paintPane() {
    const server = state.servers.find((s) => s.id === sid);
    if (!server) { pane.innerHTML = `<div class="m-empty">${t('m.noServers')}</div>`; return; }
    state.lastServerId = sid;
    pane.innerHTML = `<div class="m-header"><h1>${escapeHtml(server.name)}</h1>
      <button class="m-icon-btn" id="m-srv-search" aria-label="${t('m.searchAction')}">${icons.search(20)}</button>
      <button class="m-icon-btn" id="m-srv-menu" aria-label="${t('m.notifLevel')}">${icons.chevronDown(20)}</button></div>
      <div class="m-scroll" id="m-chans"><div class="m-empty">${t('m.loading')}</div></div>`;
    pane.querySelector('#m-srv-menu').addEventListener('click', () => openServerMenu(server));
    pane.querySelector('#m-srv-search').addEventListener('click', () => nav.push('search', { serverId: sid, entire: true }));
    let detail;
    try { detail = await ensureServerDetail(sid); } catch (err) { handleError(err, 'm.loadFailed'); return; }
    if (destroyed || sid !== server.id) return;
    paintChannels(detail);
    if (detail.onboarding && !screeningShown.has(sid)) {
      screeningShown.add(sid);
      openScreeningSheet({
        serverId: sid, serverName: server.name, onboarding: detail.onboarding,
        onDone: async () => { await refreshServerDetailSilently(sid); if (!destroyed) paintPane(); },
      });
    }
  }

  function chanRow(c) {
    const unread = isUnread('channel', c.id, c.last_message_id);
    const muted = isChannelMuted(sid, c.id);
    const on = unread && !muted;
    return `<button class="m-row m-chan${on ? ' unread' : ''}${muted ? ' muted' : ''}" data-cid="${c.id}">
      <span class="m-chan-icon">${c.icon_path ? `<img class="m-chan-img" src="${escapeHtml(c.icon_path)}" alt="">` : icons[TYPE_ICON[c.type] || 'hash'](20)}</span>
      <span class="m-grow"><b>${escapeHtml(c.name)}</b>${c.nsfw ? '<span class="nsfw-badge">18+</span>' : ''}</span>${on ? '<i class="m-dot"></i>' : ''}</button>${voiceRoster(c)}`;
  }

  // Who is currently in a voice or stage room, listed under the channel like the desktop sidebar.
  function voiceRoster(c) {
    if (c.type !== 'voice' && c.type !== 'stage') return '';
    const d = state.serverDetail.get(sid);
    const users = [...state.serverVoice].filter(([, chId]) => chId === c.id)
      .map(([userId]) => d?.members.find((m) => m.user.id === userId)?.user || getKnownUser(userId)).filter(Boolean);
    return users.length ? `<div class="m-voice-roster">${users.map((u) => `<span class="m-voice-user">${avatarHtml(u, 22)}<span>${escapeHtml(u.displayName)}</span></span>`).join('')}</div>` : '';
  }

  function openWelcome(detail) {
    const server = detail.server;
    const rows = (detail.welcomeChannels || []).map((wc) => {
      const ch = detail.channels.find((c) => c.id === wc.channel_id);
      return ch ? `<button class="m-row" data-wl="${ch.id}"><span class="m-sheet-icon">${escapeHtml(wc.emoji || '#')}</span>
        <span class="m-grow"><b>#${escapeHtml(ch.name)}</b>${wc.description ? `<small>${escapeHtml(wc.description)}</small>` : ''}</span>${icons.chevronRight(18)}</button>` : '';
    }).join('');
    openSheet({
      title: t('shell.welcomeToServer', { server: server.name }),
      html: `${server.welcome_message ? `<p class="m-welcome-text">${escapeHtml(server.welcome_message)}</p>` : ''}${rows || `<div class="m-empty">${t('shell.nothingHighlightedYet')}</div>`}`,
      onMount: (body, close) => body.addEventListener('click', (e) => {
        const r = e.target.closest('[data-wl]');
        if (!r) return;
        const c = detail.channels.find((x) => x.id === Number(r.dataset.wl));
        close();
        if (c) openChannel(c);
      }),
    });
  }

  function paintChannels(detail) {
    const box = pane.querySelector('#m-chans');
    if (!box) return;
    if (detail.server.kind === 'site') {
      box.innerHTML = `<div class="m-empty m-placeholder"><h2>${escapeHtml(detail.server.name)}</h2>
        <button class="btn btn-primary" id="m-open-site">${t('m.openSite')}</button></div>`;
      box.querySelector('#m-open-site').addEventListener('click', () => nav.push('site', { serverId: sid }));
      return;
    }
    const cats = detail.categories || [];
    const groups = [
      { name: t('m.channels'), channels: detail.channels.filter((c) => !c.category_id) },
      ...cats.map((cat) => ({ name: cat.name, channels: detail.channels.filter((c) => c.category_id === cat.id) })),
    ].filter((g) => g.channels.length);
    const welcome = detail.server.welcome_enabled
      ? `<button class="m-row m-chan" id="m-welcome"><span class="m-chan-icon">${icons.flag(20)}</span><span class="m-grow"><b>${t('shell.welcomeLabel')}</b></span></button>` : '';
    box.innerHTML = welcome + groups.map((g) => `<div class="m-section">${escapeHtml(g.name)}</div>${g.channels.map(chanRow).join('')}`).join('')
      || `<div class="m-empty">${t('m.noResults')}</div>`;
    box.querySelector('#m-welcome')?.addEventListener('click', () => openWelcome(detail));
  }

  const currentChannel = (cid) => state.serverDetail.get(sid)?.channels.find((c) => c.id === cid);

  function openChannel(c) {
    if (c.type === 'voice' || c.type === 'stage') return nav.push('voice', { kind: 'channel', serverId: sid, channelId: c.id });
    if (c.type === 'forum') return nav.push('forum', { serverId: sid, channelId: c.id });
    if (c.type === 'notes') return nav.push('notes', { serverId: sid, channelId: c.id });
    if (!CHAT_TYPES.has(c.type)) return nav.push('placeholder', { name: c.name });
    return nav.push('chat', { kind: 'channel', serverId: sid, channelId: c.id });
  }

  function markServerRead(serverId) {
    const d = state.serverDetail.get(serverId);
    for (const c of d?.channels || []) {
      if (!c.last_message_id) continue;
      setReadState('channel', c.id, c.last_message_id);
      api.markRead('channel', c.id, c.last_message_id).catch(() => {});
    }
  }

  async function openServerMenu(server) {
    const d = state.serverDetail.get(server.id);
    const isOwner = d?.server?.owner_id === state.me.id;
    const bits = d ? memberPermissionBits(d.server, d.roles, d.members.find((m) => m.user.id === state.me.id), state.me.id) : 0;
    const canManageChannels = isOwner || has(bits, PERMISSIONS.MANAGE_CHANNELS);
    const canManageServer = isOwner || has(bits, PERMISSIONS.MANAGE_SERVER) || has(bits, PERMISSIONS.MANAGE_ROLES)
      || has(bits, PERMISSIONS.KICK_MEMBERS) || has(bits, PERMISSIONS.BAN_MEMBERS) || canManageChannels;
    const items = [
      { id: 'read', icon: icons.check(20), label: t('m.markRead') },
      { id: 'notif', icon: icons.bell(20), label: t('m.notifLevel') },
      d?.server?.invite_code && { id: 'invite', icon: icons.copy(20), label: t('m.copyInvite') },
      d && { id: 'events', icon: icons.calendar(20), label: t('sidebar.eventsMenuItem') },
      d && canManageServer && { id: 'settings', icon: icons.gear(20), label: t('sidebar.serverSettingsMenuItem') },
      d && canManageChannels && { id: 'channel', icon: icons.plus(20), label: t('sidebar.createChannelMenuItem') },
      d && canManageChannels && { id: 'category', icon: icons.plus(20), label: t('sidebar.createCategoryMenuItem') },
      isOwner
        ? { id: 'delete', icon: icons.trash(20), label: t('sidebar.deleteServerMenuItem'), danger: true }
        : { id: 'leave', icon: icons.x(20), label: t('m.leaveServer'), danger: true },
    ].filter(Boolean);
    const id = await actionSheet({ title: server.name, items });
    if (id === 'read') markServerRead(server.id);
    else if (id === 'invite') { await copyText(d.server.invite_code); toast(t('m.copied')); }
    else if (id === 'events') openEventsModal(d.server, { canManage: canManageServer, channels: d.channels });
    else if (id === 'settings') openServerSettings(server.id);
    else if (id === 'channel') openServerSettings(server.id, { tab: 'channels', createNew: true });
    else if (id === 'category') {
      const name = await promptSheet({ title: t('sidebar.createCategoryMenuItem'), okLabel: t('m.createBtn') });
      if (name) { try { await api.createCategory(server.id, { name }); await refreshServerDetailSilently(server.id); } catch (err) { handleError(err); } }
    } else if (id === 'delete') {
      if (!(await confirmSheet(t('sidebar.deleteServerConfirmMessage', { name: server.name }).replace(/<[^>]+>/g, ''), { okLabel: t('sidebar.deleteServerMenuItem') }))) return;
      try { await api.deleteServer(server.id); removeServer(server.id); } catch (err) { handleError(err); }
    }
    else if (id === 'notif') {
      const level = await actionSheet({ title: t('m.notifLevel'), items: [
        { id: 'all', label: t('m.levelAll') }, { id: 'mentions', label: t('m.levelMentions') }, { id: 'mute', label: t('m.levelMute') },
      ] });
      if (!level) return;
      try { await api.setServerPrefs(server.id, { notifLevel: level }); setServerPrefs((await api.getServerPrefs()).prefs); bus.emit('state:serverPrefs', server.id); }
      catch (err) { handleError(err); }
    } else if (id === 'leave') {
      if (!(await confirmSheet(t('m.leaveConfirm'), { okLabel: t('m.leaveServer') }))) return;
      try { await api.leaveServer(server.id); removeServer(server.id); } catch (err) { handleError(err); }
    }
  }

  async function openChannelMenu(c) {
    const muted = isChannelMuted(sid, c.id);
    const id = await actionSheet({ title: `#${c.name}`, items: [
      { id: 'read', icon: icons.check(20), label: t('m.markRead') },
      { id: 'mute', icon: icons.bell(20), label: muted ? t('m.unmuteChannel') : t('m.muteChannel') },
    ] });
    if (id === 'read' && c.last_message_id) { setReadState('channel', c.id, c.last_message_id); api.markRead('channel', c.id, c.last_message_id).catch(() => {}); }
    if (id === 'mute') {
      const pref = muted ? 'mentions' : 'mute';
      try { await api.setNotificationPref('channel', c.id, pref); setPrefState('channel', c.id, pref); } catch (err) { handleError(err); }
    }
  }

  async function openAddServer() {
    const id = await actionSheet({ title: t('m.addServer'), items: [
      { id: 'create', icon: icons.plus(20), label: t('m.createServer') },
      { id: 'join', icon: icons.users(20), label: t('m.joinServer') },
      { id: 'discover', icon: icons.search(20), label: t('m.discoverServers') },
    ] });
    try {
      if (id === 'create') {
        const name = await promptSheet({ title: t('m.createServer'), placeholder: t('m.serverNamePh'), okLabel: t('m.createBtn') });
        if (name) { const res = await api.createServer({ name }); setServers((await api.listServers()).servers); sid = res.server.id; refreshAll(); }
      } else if (id === 'join') {
        const code = await promptSheet({ title: t('m.joinServer'), placeholder: t('m.inviteCodePh'), okLabel: t('m.joinBtn') });
        if (code) { const res = await api.joinServer(code); setServers((await api.listServers()).servers); sid = res.server?.id ?? sid; refreshAll(); }
      } else if (id === 'discover') {
        const res = await api.discoverServers('');
        const pick = await actionSheet({ title: t('m.discoverServers'), items: res.servers.map((s) => ({ id: String(s.id), label: s.name, sub: s.description || '' })) });
        if (pick) { await api.joinPublicServer(Number(pick)); setServers((await api.listServers()).servers); sid = Number(pick); refreshAll(); }
      }
    } catch (err) { handleError(err); }
  }

  function refreshAll() { paintRail(); paintPane(); }

  rail.addEventListener('click', (e) => {
    if (e.target.closest('#m-add')) return openAddServer();
    const rem = e.target.closest('[data-remote]');
    if (rem) { const [peerId, serverId] = rem.dataset.remote.split(':').map(Number); return nav.push('remote', { peerId, serverId }); }
    const b = e.target.closest('[data-sid]');
    if (b && Number(b.dataset.sid) !== sid) { sid = Number(b.dataset.sid); refreshAll(); }
  });
  pane.addEventListener('click', (e) => {
    const row = e.target.closest('[data-cid]');
    const c = row && currentChannel(Number(row.dataset.cid));
    if (c) openChannel(c);
  });
  onLongPress(rail, '[data-remote]', (btn) => {
    const [peerId, serverId] = btn.dataset.remote.split(':').map(Number);
    const entry = state.remoteServers.find((r) => r.peerId === peerId && r.serverId === serverId);
    if (entry) confirmLeaveRemote(entry);
  });
  onLongPress(pane, '[data-cid]', (row) => { const c = currentChannel(Number(row.dataset.cid)); if (c) openChannelMenu(c); });

  const offs = [
    bus.on('state:remoteServers', paintRail),
    bus.on('state:servers', () => { if (!state.servers.some((s) => s.id === sid)) sid = state.servers[0]?.id ?? null; refreshAll(); }),
    bus.on('state:serverVoice', () => { const d = state.serverDetail.get(sid); if (d) paintChannels(d); }),
    bus.on('state:readState', () => { paintRail(); const d = state.serverDetail.get(sid); if (d) paintChannels(d); }),
    bus.on('state:serverDetail', (id) => { paintRail(); if (id === sid) { const d = state.serverDetail.get(sid); if (d) paintChannels(d); } }),
    bus.on('state:notificationPrefs', () => { const d = state.serverDetail.get(sid); if (d) paintChannels(d); }),
    bus.on('state:serverPrefs', () => { const d = state.serverDetail.get(sid); if (d) paintChannels(d); }),
  ];
  refreshAll();
  return { destroy: () => { destroyed = true; offs.forEach((off) => off()); } };
}
