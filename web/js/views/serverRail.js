import { bus } from '../bus.js';
import { api } from '../api.js';
import { state, getServerDetail, isUnread, upsertServer, setReadState, setServerLayout, serverPrefFor, setServerPref, isServerMuted } from '../state.js';
import { icons, FOLDER_BUILTIN_ICONS } from '../icons.js';
import { serverIconHtml, escapeHtml, apiErrorMessage, toast } from '../utils.js';
import { openModal, openContextMenu } from './modal.js';
import { openInviteModal, leaveServer, deleteServer } from './sidebar.js';
import { has, PERMISSIONS, memberPermissionBits } from '../permissions.js';
import { t } from '../i18n.js';
import { redeemInviteCode } from '../inviteLink.js';
import { refreshRemoteServers, confirmLeaveRemote } from './remoteServer.js';
import { canEditSite, deleteSite } from './site.js';

// A function (not a module-level constant) so the names re-evaluate against the current
// language — see userBar.js's statusOptions() for why a plain top-level array would freeze.
function folderColors() {
  return [
    { hex: '#0d9488', name: t('serverRail.folderColorBlurple') }, { hex: '#57f287', name: t('serverRail.folderColorGreen') }, { hex: '#fee75c', name: t('serverRail.folderColorYellow') },
    { hex: '#eb459e', name: t('serverRail.folderColorPink') }, { hex: '#ed4245', name: t('serverRail.folderColorRed') }, { hex: '#f0b232', name: t('serverRail.folderColorOrange') },
    { hex: '#00a8fc', name: t('serverRail.folderColorBlue') }, { hex: '#f97316', name: t('serverRail.folderColorPurple') }, { hex: '#99aab5', name: t('serverRail.folderColorGrey') },
  ];
}

// Redeems an invite code and navigates to what it opened. Throws when the code is invalid.
export async function joinWithCode(code) {
  const { kind, res } = await redeemInviteCode(code);
  if (kind === 'channel') {
    upsertServer(res.server);
    bus.emit('ui:navigate', { type: 'server', serverId: res.server.id, channelId: res.channelId });
  } else if (kind === 'federated') {
    await refreshRemoteServers();
    bus.emit('ui:navigate', { type: 'remote', peerId: res.peerId, serverId: res.server.id, channelId: res.channels[0]?.id });
  } else {
    bus.emit('ui:serverCreated', res.server);
  }
}

// The narrow left-most rail: Home (DMs), joined servers (optionally grouped into drag-and-drop
// folders), create/join button.
export function mountServerRail(container) {
  // Which folders are currently expanded — deliberately local/session-only UI state, not part
  // of the persisted layout (matches Discord: folder open/closed state doesn't sync).
  const expandedFolders = new Set();
  let dragging = null; // {type:'server'|'folder', id} while a drag is in progress

  render();
  const offServers = bus.on('state:servers', render);
  const offView = bus.on('state:view', render);
  const offRead = bus.on('state:readState', render);
  const offDetail = bus.on('state:serverDetail', render);
  const offLayout = bus.on('state:serverLayout', render);
  const offRemote = bus.on('state:remoteServers', render);
  // Only servers whose channel list has been loaded this session (i.e. visited at least once)
  // can be checked for unread — there's no cheap way to know about the rest without fetching
  // every joined server's channels up front just for a rail dot.
  const offMsg = bus.on('ws:message_create', ({ message }) => { if (message.scopeType === 'channel') render(); });

  // Reconciles the persisted layout against the live server list: drops folder/server entries
  // for servers we're no longer in, and appends any server the layout doesn't mention yet
  // (freshly joined, or layout never customized) as a plain top-level item.
  function resolveLayout() {
    const knownIds = new Set(state.servers.map((s) => s.id));
    const placed = new Set();
    const items = [];
    for (const entry of state.serverLayout) {
      if (entry.type === 'server') {
        if (knownIds.has(entry.id) && !placed.has(entry.id)) { items.push(entry); placed.add(entry.id); }
      } else if (entry.type === 'folder') {
        const servers = entry.servers.filter((id) => knownIds.has(id) && !placed.has(id));
        if (servers.length === 0) continue;
        servers.forEach((id) => placed.add(id));
        items.push({ ...entry, servers });
      }
    }
    for (const s of state.servers) if (!placed.has(s.id)) items.push({ type: 'server', id: s.id });
    return items;
  }

  function serverUnread(id) {
    return (getServerDetail(id)?.channels || []).some((ch) => isUnread('channel', ch.id, ch.last_message_id));
  }

  function renderServerItem(s, { insideFolder = false } = {}) {
    const activeType = state.view.type;
    const active = activeType === 'server' && state.view.serverId === s.id;
    const unread = !active && serverUnread(s.id);
    return `
      <div class="rail-item ${active ? 'active' : ''} ${unread ? 'unread' : ''} ${insideFolder ? 'in-folder' : ''}"
           data-server="${s.id}" data-name="${escapeHtml(s.name)}" draggable="true">
        <div class="rail-pill"></div>
        <div class="rail-icon">${serverIconHtml(s, 48)}</div>
      </div>`;
  }

  // A server owned by a paired instance: initials only (never an icon fetched from that host), a
  // small globe badge, and greyed while its home instance looks unreachable.
  function renderRemoteItem(r) {
    const v = state.view;
    const active = v.type === 'remote' && v.peerId === r.peerId && v.serverId === r.serverId;
    const label = `${r.name} (${r.domain})${r.reachable ? '' : ` - ${t('remote.unreachableShort')}`}`;
    return `
      <div class="rail-item remote ${active ? 'active' : ''} ${r.reachable ? '' : 'unreachable'}"
           data-remote-peer="${r.peerId}" data-remote-server="${r.serverId}" data-name="${escapeHtml(label)}">
        <div class="rail-pill"></div>
        <div class="rail-icon">${serverIconHtml({ name: r.name }, 48)}</div>
        <div class="rail-badge">${icons.globe(11)}</div>
      </div>`;
  }

  // The collapsed folder icon: a custom uploaded image if set, else a chosen built-in glyph
  // tinted onto the folder's color, else (the original/default) a 2x2 preview grid of the
  // folder's own member server icons.
  function renderFolderGlyph(folder, memberServers) {
    const icon = folder.icon || { kind: 'auto' };
    if (icon.kind === 'image' && icon.value) {
      return `<img src="${escapeHtml(icon.value)}" alt="" draggable="false" style="width:100%;height:100%;object-fit:cover">`;
    }
    if (icon.kind === 'builtin' && icons[icon.value]) {
      return icons[icon.value](24);
    }
    return `<div class="folder-grid">${memberServers.slice(0, 4).map((s) => `<div class="folder-grid-cell">${serverIconHtml(s, 20)}</div>`).join('')}</div>`;
  }

  function renderFolderItem(folder) {
    const expanded = expandedFolders.has(folder.id);
    const memberServers = folder.servers.map((id) => state.servers.find((s) => s.id === id)).filter(Boolean);
    const anyActive = !expanded && state.view.type === 'server' && folder.servers.includes(state.view.serverId);
    const anyUnread = !anyActive && memberServers.some((s) => serverUnread(s.id));
    const hasCustomIcon = folder.icon?.kind === 'image' || folder.icon?.kind === 'builtin';
    return `
      <div class="rail-folder ${expanded ? 'expanded' : ''}">
        <div class="rail-item folder-header ${anyActive ? 'active' : ''} ${anyUnread ? 'unread' : ''}"
             data-folder="${folder.id}" data-name="${escapeHtml(folder.name)}" draggable="true">
          <div class="rail-pill"></div>
          <div class="rail-icon folder-icon ${hasCustomIcon && !expanded ? 'has-custom-icon' : ''}" style="background:${expanded ? 'transparent' : folder.color}; color:${expanded ? '' : '#fff'}">
            ${expanded ? icons.chevronDown(20) : renderFolderGlyph(folder, memberServers)}
          </div>
        </div>
        ${expanded ? `
          <div class="rail-folder-contents" style="background:${folder.color}22">
            ${memberServers.map((s) => renderServerItem(s, { insideFolder: true })).join('')}
          </div>` : ''}
      </div>`;
  }

  function render() {
    const activeType = state.view.type;
    const layout = resolveLayout();
    container.innerHTML = `
      <div class="rail-item home ${activeType === 'home' || activeType === 'friends' ? 'active' : ''}" data-action="home">
        <div class="rail-pill"></div>
        <div class="rail-icon">${icons.dismesh(26)}</div>
      </div>
      <div class="rail-sep"></div>
      ${layout.map((entry) => (entry.type === 'folder' ? renderFolderItem(entry) : renderServerItem(state.servers.find((s) => s.id === entry.id))))
        .filter(Boolean).join('')}
      ${state.remoteServers.map(renderRemoteItem).join('')}
      <div class="rail-item create" data-action="create">
        <div class="rail-icon">${icons.plus(24)}</div>
      </div>
      <div class="rail-item discover" data-action="discover">
        <div class="rail-icon">${icons.compass(24)}</div>
      </div>
      <div class="rail-sep"></div>
      <div class="rail-item download" data-action="download">
        <div class="rail-icon">${icons.download(22)}</div>
      </div>
    `;

    container.querySelector('[data-action="home"]').addEventListener('click', () => {
      bus.emit('ui:navigate', { type: 'home' });
    });
    container.querySelector('[data-action="create"]').addEventListener('click', () => openCreateJoinModal('create'));
    container.querySelector('[data-action="discover"]').addEventListener('click', () => openCreateJoinModal('discover'));
    container.querySelector('[data-action="download"]').addEventListener('click', openDownloadModal);

    container.querySelectorAll('[data-server]').forEach((node) => {
      const serverId = Number(node.dataset.server);
      node.addEventListener('click', () => bus.emit('ui:navigate', { type: 'server', serverId }));
      node.addEventListener('mouseenter', () => showTooltip(node, node.dataset.name));
      node.addEventListener('mouseleave', hideTooltip);
      node.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        hideTooltip();
        openServerContextMenu(e.clientX, e.clientY, serverId);
      });
      wireDrag(node, 'server', serverId);
    });

    container.querySelectorAll('[data-remote-peer]').forEach((node) => {
      const peerId = Number(node.dataset.remotePeer);
      const serverId = Number(node.dataset.remoteServer);
      node.addEventListener('click', () => bus.emit('ui:navigate', { type: 'remote', peerId, serverId }));
      node.addEventListener('mouseenter', () => showTooltip(node, node.dataset.name));
      node.addEventListener('mouseleave', hideTooltip);
      node.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        hideTooltip();
        const entry = state.remoteServers.find((r) => r.peerId === peerId && r.serverId === serverId);
        if (entry) openContextMenu(e.clientX, e.clientY, [{ label: t('remote.leaveMenuItem'), icon: icons.logout, danger: true, onClick: () => confirmLeaveRemote(entry) }]);
      });
    });

    container.querySelectorAll('[data-folder]').forEach((node) => {
      const folderId = node.dataset.folder;
      node.addEventListener('click', () => {
        if (expandedFolders.has(folderId)) expandedFolders.delete(folderId);
        else expandedFolders.add(folderId);
        render();
      });
      node.addEventListener('mouseenter', () => { if (!expandedFolders.has(folderId)) showTooltip(node, node.dataset.name); });
      node.addEventListener('mouseleave', hideTooltip);
      node.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        hideTooltip();
        openFolderContextMenu(e.clientX, e.clientY, folderId);
      });
      wireDrag(node, 'folder', folderId);
    });

    container.querySelector('[data-action="home"]').addEventListener('mouseenter', (e) => showTooltip(e.currentTarget, t('serverRail.homeTooltip')));
    container.querySelector('[data-action="home"]').addEventListener('mouseleave', hideTooltip);
    container.querySelector('[data-action="create"]').addEventListener('mouseenter', (e) => showTooltip(e.currentTarget, t('serverRail.addServerTooltip')));
    container.querySelector('[data-action="create"]').addEventListener('mouseleave', hideTooltip);
    container.querySelector('[data-action="discover"]').addEventListener('mouseenter', (e) => showTooltip(e.currentTarget, t('serverRail.discoverServersTooltip')));
    container.querySelector('[data-action="discover"]').addEventListener('mouseleave', hideTooltip);
    container.querySelector('[data-action="download"]').addEventListener('mouseenter', (e) => showTooltip(e.currentTarget, t('serverRail.downloadClientTooltip')));
    container.querySelector('[data-action="download"]').addEventListener('mouseleave', hideTooltip);
  }

  // --- drag and drop: drop a server on another server to fold them together, on a folder to
  // join it, or drop a folder elsewhere to reposition it. ---
  function wireDrag(node, type, id) {
    node.addEventListener('dragstart', (e) => {
      dragging = { type, id };
      e.dataTransfer.effectAllowed = 'move';
      hideTooltip();
    });
    node.addEventListener('dragover', (e) => {
      if (!dragging) return;
      e.preventDefault();
      node.classList.add('drag-over');
    });
    node.addEventListener('dragleave', () => node.classList.remove('drag-over'));
    node.addEventListener('drop', (e) => {
      e.preventDefault();
      node.classList.remove('drag-over');
      handleDrop(type, id);
    });
    node.addEventListener('dragend', () => { dragging = null; container.querySelectorAll('.drag-over').forEach((n) => n.classList.remove('drag-over')); });
  }

  function handleDrop(targetType, targetId) {
    if (!dragging) return;
    const { type: dType, id: dId } = dragging;
    dragging = null;
    if (dType === targetType && dId === targetId) return;

    if (dType === 'server' && targetType === 'server') {
      const layout = resolveLayout();
      const containingFolder = layout.find((e) => e.type === 'folder' && e.servers.includes(targetId));
      if (containingFolder) moveServerIntoFolder(dId, containingFolder.id);
      else createFolderWithServers(dId, targetId);
    } else if (dType === 'server' && targetType === 'folder') {
      moveServerIntoFolder(dId, targetId);
      expandedFolders.add(targetId);
    } else if (dType === 'folder') {
      reorderEntry('folder', dId, targetType, targetId);
    }
  }

  // A one-server "folder" isn't meaningful — dissolve it back to a plain top-level item in the
  // same spot rather than leaving a folder pouch around a single icon.
  function dissolveSingletonFolders(layout) {
    const out = [];
    for (const e of layout) {
      if (e.type === 'folder' && e.servers.length === 1) {
        expandedFolders.delete(e.id);
        out.push({ type: 'server', id: e.servers[0] });
      } else {
        out.push(e);
      }
    }
    return out;
  }

  function saveLayout(layout) {
    const cleaned = dissolveSingletonFolders(layout);
    setServerLayout(cleaned); // optimistic — re-renders immediately off local state
    api.setServerLayout(cleaned).catch(() => toast(t('serverRail.couldNotSaveLayout'), { type: 'error' }));
  }

  function removeServerFromLayout(layout, serverId) {
    return layout
      .map((e) => (e.type === 'folder' ? { ...e, servers: e.servers.filter((id) => id !== serverId) } : e))
      .filter((e) => e.type !== 'folder' || e.servers.length > 0)
      .filter((e) => !(e.type === 'server' && e.id === serverId));
  }

  function moveServerIntoFolder(serverId, folderId) {
    const layout = removeServerFromLayout(resolveLayout(), serverId);
    const idx = layout.findIndex((e) => e.type === 'folder' && e.id === folderId);
    if (idx === -1) return;
    layout[idx] = { ...layout[idx], servers: [...layout[idx].servers, serverId] };
    saveLayout(layout);
  }

  function createFolderWithServers(serverIdA, serverIdB) {
    const layout = resolveLayout();
    const originalIdx = layout.findIndex((e) => e.type === 'server' && e.id === serverIdA);
    const withoutBoth = removeServerFromLayout(removeServerFromLayout(layout, serverIdA), serverIdB);
    const folder = { type: 'folder', id: `f${Date.now()}`, name: t('serverRail.defaultFolderName'), color: folderColors()[0].hex, icon: { kind: 'auto' }, servers: [serverIdA, serverIdB] };
    withoutBoth.splice(Math.min(originalIdx === -1 ? withoutBoth.length : originalIdx, withoutBoth.length), 0, folder);
    saveLayout(withoutBoth);
    expandedFolders.add(folder.id); // show the merge happening, rather than a silent icon swap
  }

  function removeServerFromFolder(serverId) {
    const layout = removeServerFromLayout(resolveLayout(), serverId);
    layout.push({ type: 'server', id: serverId });
    saveLayout(layout);
  }

  function reorderEntry(dType, dId, targetType, targetId) {
    const layout = resolveLayout();
    const matches = (e, type, id) => (type === 'server' ? e.type === 'server' && e.id === id : e.type === 'folder' && e.id === id);
    const dIdx = layout.findIndex((e) => matches(e, dType, dId));
    if (dIdx === -1) return;
    const [dragged] = layout.splice(dIdx, 1);
    const tIdx = layout.findIndex((e) => matches(e, targetType, targetId));
    layout.splice(tIdx === -1 ? layout.length : tIdx, 0, dragged);
    saveLayout(layout);
  }

  function updateFolder(folderId, patch) {
    const layout = resolveLayout().map((e) => (e.type === 'folder' && e.id === folderId ? { ...e, ...patch } : e));
    saveLayout(layout);
  }

  function deleteFolder(folderId) {
    const layout = resolveLayout();
    const folder = layout.find((e) => e.type === 'folder' && e.id === folderId);
    if (!folder) return;
    const withoutFolder = layout.filter((e) => !(e.type === 'folder' && e.id === folderId));
    const idx = layout.indexOf(folder);
    withoutFolder.splice(Math.min(idx, withoutFolder.length), 0, ...folder.servers.map((id) => ({ type: 'server', id })));
    expandedFolders.delete(folderId);
    saveLayout(withoutFolder);
  }

  // Marks every channel in a server read in one shot — the rail's own unread pill has no
  // per-channel granularity to click, so this is the only way to clear it without opening each
  // channel individually.
  async function markServerRead(serverId) {
    const channels = getServerDetail(serverId)?.channels || [];
    for (const ch of channels) {
      if (!ch.last_message_id || !isUnread('channel', ch.id, ch.last_message_id)) continue;
      try { await api.markRead('channel', ch.id, ch.last_message_id); setReadState('channel', ch.id, ch.last_message_id); } catch { /* best-effort */ }
    }
  }

  function moveServerToFolderAt(serverId, folderId, where) {
    const layout = removeServerFromLayout(resolveLayout(), serverId);
    const idx = layout.findIndex((e) => e.type === 'folder' && e.id === folderId);
    if (idx === -1) return;
    const servers = where === 'first' ? [serverId, ...layout[idx].servers] : [...layout[idx].servers, serverId];
    layout[idx] = { ...layout[idx], servers };
    saveLayout(layout);
    expandedFolders.add(folderId);
  }

  async function updateServerPref(serverId, patch) {
    try {
      const res = await api.setServerPrefs(serverId, patch);
      setServerPref(res.pref);
    } catch { toast(t('serverRail.couldNotSaveServerPrefs'), { type: 'error' }); }
  }

  function muteMenuItem(serverId) {
    const pref = serverPrefFor(serverId);
    if (isServerMuted(serverId)) {
      const forever = Date.parse(pref.mutedUntil) > Date.now() + 365 * 24 * 3600 * 1000;
      return {
        label: t('serverRail.unmuteServerMenuItem'),
        sub: forever ? t('serverRail.mutedForeverSub') : t('serverRail.mutedUntilSub', { time: new Date(pref.mutedUntil).toLocaleString() }),
        onClick: () => updateServerPref(serverId, { mute: null }),
      };
    }
    const durations = [['mute15m', 15], ['mute1h', 60], ['mute3h', 180], ['mute8h', 480], ['mute24h', 1440]];
    return {
      label: t('serverRail.muteServerMenuItem'),
      submenu: [
        ...durations.map(([key, minutes]) => ({ label: t(`serverRail.${key}`), onClick: () => updateServerPref(serverId, { mute: { minutes } }) })),
        { label: t('serverRail.muteForever'), onClick: () => updateServerPref(serverId, { mute: { forever: true } }) },
      ],
    };
  }

  function notificationMenuItem(serverId) {
    const level = serverPrefFor(serverId).notifLevel;
    const options = [['all', 'shell.allMessagesOption'], ['mentions', 'shell.onlyMentionsOption'], ['mute', 'shell.nothingOption']];
    const current = options.find(([v]) => v === level);
    return {
      label: t('serverRail.notificationSettingsMenuItem'),
      sub: current ? t(current[1]) : t('serverRail.notifDefaultSub'),
      submenu: options.map(([value, key]) => ({ label: t(key), checked: level === value, onClick: () => updateServerPref(serverId, { notifLevel: value }) })),
    };
  }

  function moveToMenuItem(serverId) {
    const folders = resolveLayout().filter((e) => e.type === 'folder');
    if (!folders.length) return null;
    const inFolder = folders.some((f) => f.servers.includes(serverId));
    return {
      label: t('serverRail.moveToMenuItem'),
      submenu: [
        ...(inFolder ? [{ label: t('serverRail.noFolderMenuItem'), onClick: () => removeServerFromFolder(serverId) }] : []),
        ...folders.map((f) => ({
          label: f.name,
          submenu: [
            { label: t('serverRail.firstInFolderMenuItem'), onClick: () => moveServerToFolderAt(serverId, f.id, 'first') },
            { label: t('serverRail.lastInFolderMenuItem'), onClick: () => moveServerToFolderAt(serverId, f.id, 'last') },
          ],
        })),
      ],
    };
  }

  function openPrivacyModal(server) {
    const m = openModal({
      title: t('serverRail.privacyModalTitle', { server: server.name }),
      render(body) {
        body.innerHTML = `
          <label class="checkbox-row"><input type="checkbox" id="pv-allow" ${serverPrefFor(server.id).allowDms ? 'checked' : ''}> <span>${t('serverRail.allowDmsLabel')}</span></label>
          <p style="color:var(--text-secondary);font-size:13px;margin:8px 0 16px">${t('serverRail.allowDmsHint')}</p>
          <div style="display:flex;justify-content:flex-end"><button class="btn btn-primary" id="pv-save">${t('serverRail.saveButton')}</button></div>`;
        body.querySelector('#pv-save').addEventListener('click', async () => {
          await updateServerPref(server.id, { allowDms: body.querySelector('#pv-allow').checked });
          m.close();
        });
      },
    });
  }

  function openServerProfileModal(server) {
    const mine = getServerDetail(server.id)?.members.find((mem) => mem.user.id === state.me.id);
    const m = openModal({
      title: t('serverRail.serverProfileModalTitle', { server: server.name }),
      render(body) {
        body.innerHTML = `
          <div class="field">
            <label for="sp-nick">${t('serverRail.serverNicknameLabel')}</label>
            <input class="input" id="sp-nick" maxlength="32" value="${escapeHtml(mine?.nickname || '')}" placeholder="${escapeHtml(state.me.displayName)}">
            <p style="color:var(--text-secondary);font-size:13px;margin:6px 0 0">${t('serverRail.serverNicknameHint')}</p>
          </div>
          <div style="display:flex;justify-content:flex-end"><button class="btn btn-primary" id="sp-save">${t('serverRail.saveButton')}</button></div>`;
        body.querySelector('#sp-save').addEventListener('click', async () => {
          const nickname = body.querySelector('#sp-nick').value.trim();
          try {
            await api.setNickname(server.id, state.me.id, nickname || null);
            m.close();
          } catch (err) { toast(apiErrorMessage(err, t('serverRail.couldNotSaveNickname')), { type: 'error' }); }
        });
      },
    });
  }

  function openSiteContextMenu(x, y, server) {
    const editable = canEditSite(server);
    const items = [];
    if (editable) {
      const act = (action) => () => {
        bus.emit('ui:navigate', { type: 'server', serverId: server.id });
        setTimeout(() => bus.emit('ui:siteAction', { serverId: server.id, action }), 50);
      };
      items.push(
        { label: t('sites.editButton'), icon: icons.edit, onClick: act('edit') },
        { label: t('sites.settingsButton'), icon: icons.gear, onClick: act('settings') },
        'sep',
        { label: t('sites.deleteButton'), icon: icons.trash, danger: true, onClick: () => deleteSite(server) },
      );
    }
    if (items.length) openContextMenu(x, y, items);
  }

  function openServerContextMenu(x, y, serverId) {
    const server = state.servers.find((s) => s.id === serverId);
    if (!server) return;
    if (server.kind === 'site') return openSiteContextMenu(x, y, server);
    const pref = serverPrefFor(serverId);
    const detail = getServerDetail(serverId);
    const isOwner = server.owner_id === state.me.id;
    let canChangeNickname = true;
    if (detail) {
      const myMember = detail.members.find((mem) => mem.user.id === state.me.id);
      canChangeNickname = isOwner || has(memberPermissionBits(detail.server, detail.roles, myMember, state.me.id), PERMISSIONS.CHANGE_NICKNAME);
    }
    const moveTo = moveToMenuItem(serverId);
    openContextMenu(x, y, [
      { label: t('serverRail.markAsReadMenuItem'), onClick: () => markServerRead(serverId) },
      'sep',
      { label: t('sidebar.inviteMenuItem'), onClick: () => openInviteModal(server) },
      'sep',
      muteMenuItem(serverId),
      notificationMenuItem(serverId),
      { label: t('serverRail.hideMutedChannelsMenuItem'), checked: pref.hideMutedChannels, onClick: () => updateServerPref(serverId, { hideMutedChannels: !pref.hideMutedChannels }) },
      { label: t('serverRail.showAllChannelsMenuItem'), checked: pref.showAllChannels, onClick: () => updateServerPref(serverId, { showAllChannels: !pref.showAllChannels }) },
      'sep',
      { label: t('serverRail.privacySettingsMenuItem'), onClick: () => openPrivacyModal(server) },
      ...(canChangeNickname ? [{ label: t('serverRail.editServerProfileMenuItem'), onClick: () => openServerProfileModal(server) }] : []),
      ...(moveTo ? ['sep', moveTo] : []),
      'sep',
      isOwner
        ? { label: t('sidebar.deleteServerMenuItem'), danger: true, onClick: () => deleteServer(server) }
        : { label: t('sidebar.leaveServerMenuItem'), danger: true, onClick: () => leaveServer(server) },
    ]);
  }

  function openFolderContextMenu(x, y, folderId) {
    const folder = resolveLayout().find((e) => e.type === 'folder' && e.id === folderId);
    if (!folder) return;
    openContextMenu(x, y, [
      { label: t('serverRail.customizeFolderMenuItem'), icon: icons.edit, onClick: () => openFolderCustomizeModal(folderId) },
      'sep',
      { label: t('serverRail.deleteFolderMenuItem'), icon: icons.trash, danger: true, onClick: () => deleteFolder(folderId) },
    ]);
  }

  function openFolderCustomizeModal(folderId) {
    const original = resolveLayout().find((e) => e.type === 'folder' && e.id === folderId);
    if (!original) return;
    let name = original.name;
    let color = original.color;
    let icon = original.icon || { kind: 'auto' };
    let uploading = false;
    const memberServers = original.servers.map((id) => state.servers.find((s) => s.id === id)).filter(Boolean);

    const m = openModal({
      title: t('serverRail.customizeFolderMenuItem'),
      render(body) {
        draw();
        function draw() {
          body.innerHTML = `
            <div class="field">
              <label>${t('serverRail.folderNameLabel')}</label>
              <input class="input" id="fc-name" maxlength="48" value="${escapeHtml(name)}">
            </div>
            <div class="field">
              <label>${t('serverRail.colorLabel')}</label>
              <div class="folder-color-swatches">
                ${folderColors().map(({ hex, name: cName }) => `
                  <button type="button" class="folder-swatch ${hex === color ? 'selected' : ''}" data-color="${hex}" title="${escapeHtml(cName)}" style="background:${hex}">
                    ${hex === color ? icons.check(14) : ''}
                  </button>`).join('')}
              </div>
            </div>
            <div class="field">
              <label>${t('serverRail.iconLabel')}</label>
              <div class="tabs-row">
                <button type="button" class="tab-btn ${icon.kind === 'auto' ? 'active' : ''}" data-icon-tab="auto">${t('serverRail.serverIconsTab')}</button>
                <button type="button" class="tab-btn ${icon.kind === 'builtin' ? 'active' : ''}" data-icon-tab="builtin">${t('serverRail.chooseAnIconTab')}</button>
                <button type="button" class="tab-btn ${icon.kind === 'image' ? 'active' : ''}" data-icon-tab="image">${t('serverRail.uploadImageTab')}</button>
              </div>
              ${icon.kind === 'builtin' ? `
                <div class="folder-icon-grid">
                  ${FOLDER_BUILTIN_ICONS.map((name2) => `
                    <button type="button" class="folder-icon-choice ${icon.value === name2 ? 'selected' : ''}" data-builtin-icon="${name2}" style="background:${color}">
                      ${icons[name2](20)}
                    </button>`).join('')}
                </div>` : ''}
              ${icon.kind === 'image' ? `
                <div class="folder-image-upload">
                  <div class="folder-preview" style="background:${color}">
                    ${icon.value ? `<img src="${escapeHtml(icon.value)}" alt="">` : `<span class="hint">${t('serverRail.noImageYet')}</span>`}
                  </div>
                  <input type="file" id="fc-image-input" class="hidden" accept="image/png,image/jpeg,image/gif,image/webp">
                  <button type="button" class="btn btn-secondary" id="fc-image-btn" ${uploading ? 'disabled' : ''}>${uploading ? t('serverRail.uploadingButton') : t('serverRail.chooseImageButton')}</button>
                </div>` : ''}
              ${icon.kind === 'auto' ? `<p class="hint">${t('serverRail.autoIconHint')}</p>` : ''}
            </div>
            <div class="preview-row">
              <div class="rail-icon folder-icon" style="width:48px;height:48px;background:${color};color:#fff">${renderFolderGlyph({ icon, color }, memberServers)}</div>
              <span class="hint">${t('serverRail.livePreviewLabel')}</span>
            </div>
            <div class="error-text" id="fc-error"></div>
            <button class="btn btn-primary btn-block" id="fc-save">${t('common.save')}</button>`;

          body.querySelector('#fc-name').addEventListener('input', (e) => { name = e.target.value; });
          body.querySelectorAll('[data-color]').forEach((btn) => {
            btn.addEventListener('click', () => { color = btn.dataset.color; draw(); });
          });
          body.querySelectorAll('[data-icon-tab]').forEach((btn) => {
            btn.addEventListener('click', () => {
              const kind = btn.dataset.iconTab;
              icon = kind === 'builtin' ? { kind, value: FOLDER_BUILTIN_ICONS[0] }
                : kind === 'image' ? { kind, value: icon.kind === 'image' ? icon.value : null }
                  : { kind: 'auto' };
              draw();
            });
          });
          body.querySelectorAll('[data-builtin-icon]').forEach((btn) => {
            btn.addEventListener('click', () => { icon = { kind: 'builtin', value: btn.dataset.builtinIcon }; draw(); });
          });
          const imageInput = body.querySelector('#fc-image-input');
          body.querySelector('#fc-image-btn')?.addEventListener('click', () => imageInput.click());
          imageInput?.addEventListener('change', async () => {
            const file = imageInput.files[0];
            if (!file) return;
            uploading = true;
            draw();
            try {
              const res = await api.uploadFolderIcon(file);
              icon = { kind: 'image', value: res.iconPath };
            } catch (err) {
              body.querySelector('#fc-error').textContent = apiErrorMessage(err, t('serverRail.couldNotUploadImage'));
            } finally {
              uploading = false;
              draw();
            }
          });
          body.querySelector('#fc-save').addEventListener('click', () => {
            const trimmed = name.trim().slice(0, 48);
            if (!trimmed) { body.querySelector('#fc-error').textContent = t('serverRail.folderNameEmptyError'); return; }
            updateFolder(folderId, { name: trimmed, color, icon });
            m.close();
          });
        }
      },
    });
  }

  function openDownloadModal() {
    openModal({
      title: t('serverRail.downloadModalTitle'),
      render(body) {
        body.innerHTML = `
          <div class="field" style="display:flex;flex-direction:column;gap:6px">
            ${[['clientDesktop', 'downloadDesktopLink'], ['clientAndroid', 'downloadAndroidLink'], ['website', 'projectWebsiteLink']]
              .filter(([k]) => state.config.downloads?.[k])
              .map(([k, label]) => `<a href="${escapeHtml(state.config.downloads[k])}" target="_blank" rel="noopener noreferrer">${t(`serverRail.${label}`)}</a>`).join('')}
          </div>
          <p style="color:var(--text-secondary);font-size:14px;line-height:1.6">
            ${t('serverRail.downloadIntro')}
          </p>
          <div class="field">
            <label>${t('serverRail.devMachineLabel')}</label>
            <code style="display:block;background:var(--bg-input);padding:10px 12px;border-radius:var(--radius-sm);font-size:13px">npm run electron</code>
          </div>
          <div class="field">
            <label>${t('serverRail.portableBuildLabel')}</label>
            <code style="display:block;background:var(--bg-input);padding:10px 12px;border-radius:var(--radius-sm);font-size:13px">node scripts/build-portable.js</code>
            <p class="hint" style="margin-top:6px">${t('serverRail.portableBuildHint')}</p>
          </div>
          <p style="color:var(--text-muted);font-size:13px">${t('serverRail.askAdminHint')}</p>`;
      },
    });
  }

  let tooltipEl = null;
  function showTooltip(anchor, text) {
    hideTooltip();
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'rail-tooltip';
    tooltipEl.textContent = text;
    document.body.appendChild(tooltipEl);
    const rect = anchor.getBoundingClientRect();
    tooltipEl.style.left = `${rect.right + 14}px`;
    tooltipEl.style.top = `${rect.top + rect.height / 2}px`;
    requestAnimationFrame(() => tooltipEl?.classList.add('show'));
  }
  function hideTooltip() {
    tooltipEl?.remove();
    tooltipEl = null;
  }

  function openCreateJoinModal(initialTab = 'create') {
    let tab = initialTab;
    let visibility = 'private';
    let autoJoin = false;
    let discoverResults = null;
    let draftName = '';
    let draftDescription = '';
    let draftTemplate = '';
    const m = openModal({
      title: t('serverRail.addServerModalTitle'),
      wide: true,
      render(body) {
        draw();
        if (tab === 'discover') loadDiscover('');
        function draw() {
          body.innerHTML = `
            <div class="tabs-row">
              <button class="tab-btn ${tab === 'create' ? 'active' : ''}" data-tab="create">${t('serverRail.createServerTab')}</button>
              <button class="tab-btn ${tab === 'join' ? 'active' : ''}" data-tab="join">${t('serverRail.joinWithInviteTab')}</button>
              <button class="tab-btn ${tab === 'discover' ? 'active' : ''}" data-tab="discover">${t('serverRail.discoverTab')}</button>
              ${state.me?.canManageSites ? `<button class="tab-btn ${tab === 'site' ? 'active' : ''}" data-tab="site">${t('sites.tabLabel')}</button>` : ''}
            </div>
            ${tab === 'create' ? `
              <div class="field">
                <label>${t('serverRail.serverNameLabel')}</label>
                <input class="input" id="srv-name" placeholder="${t('serverRail.serverNamePlaceholder')}" value="${escapeHtml(draftName)}" autofocus>
              </div>
              <div class="field">
                <label>${t('serverRail.descriptionLabel')} <span class="hint">${t('serverRail.optional')}</span></label>
                <textarea class="input textarea" id="srv-desc" rows="2" placeholder="${t('serverRail.descriptionPlaceholder')}">${escapeHtml(draftDescription)}</textarea>
              </div>
              <div class="field">
                <label>${t('templates.codeLabel')}</label>
                <input class="input" id="srv-template" maxlength="32" placeholder="abcd1234" value="${escapeHtml(draftTemplate)}" style="max-width:200px">
                <div class="hint">${t('templates.codeHint')}</div>
              </div>
              <div class="field">
                <label>${t('serverRail.visibilityLabel')}</label>
                <div class="tabs-row">
                  <button type="button" class="tab-btn ${visibility === 'private' ? 'active' : ''}" data-vis="private">${t('serverRail.privateVisibility')}</button>
                  <button type="button" class="tab-btn ${visibility === 'public' ? 'active' : ''}" data-vis="public">${t('serverRail.publicVisibility')}</button>
                </div>
              </div>
              ${visibility === 'public' ? `
                <label class="checkbox-row">
                  <input type="checkbox" id="srv-autojoin" ${autoJoin ? 'checked' : ''}>
                  ${t('serverRail.autoJoinCheckbox')}
                </label>` : ''}
              <div class="error-text" id="srv-err"></div>
              <button class="btn btn-primary btn-block" id="srv-create">${t('serverRail.createButton')}</button>
            ` : tab === 'site' ? `
              <div class="field">
                <label>${t('sites.nameLabel')}</label>
                <input class="input" id="site-name" maxlength="100" placeholder="${t('sites.namePlaceholder')}" value="${escapeHtml(draftName)}">
              </div>
              <p class="hint">${t('sites.createHint')}</p>
              <div class="error-text" id="srv-err"></div>
              <button class="btn btn-primary btn-block" id="site-create">${t('sites.createButton')}</button>
            ` : tab === 'join' ? `
              <div class="field">
                <label>${t('serverRail.inviteCodeLabel')}</label>
                <input class="input" id="srv-invite" placeholder="${t('serverRail.inviteCodePlaceholder')}">
              </div>
              <div class="error-text" id="srv-err"></div>
              <button class="btn btn-primary btn-block" id="srv-join">${t('serverRail.joinServerButton')}</button>
            ` : `
              <div class="field">
                <input class="input" id="srv-search" placeholder="${t('serverRail.searchPublicServersPlaceholder')}">
              </div>
              <div id="srv-discover-list">${renderDiscoverList()}</div>
            `}
          `;
          body.querySelectorAll('[data-tab]').forEach((btn) => {
            btn.addEventListener('click', () => { tab = btn.dataset.tab; if (tab === 'discover' && !discoverResults) loadDiscover(''); draw(); });
          });
          if (tab === 'create') {
            const nameInput = body.querySelector('#srv-name');
            const descInput = body.querySelector('#srv-desc');
            const redrawFromCreate = () => {
              draftName = nameInput.value;
              draftDescription = descInput.value;
              draftTemplate = body.querySelector('#srv-template').value;
              draw();
            };
            body.querySelectorAll('[data-vis]').forEach((btn) => {
              btn.addEventListener('click', () => { visibility = btn.dataset.vis; redrawFromCreate(); });
            });
            nameInput.focus();
            nameInput.selectionStart = nameInput.selectionEnd = nameInput.value.length;
            const submit = async () => {
              const name = nameInput.value.trim();
              if (!name) return;
              const description = descInput.value.trim();
              const autoJoinChecked = visibility === 'public' && !!body.querySelector('#srv-autojoin')?.checked;
              try {
                const templateCode = body.querySelector('#srv-template').value.trim();
                const res = templateCode
                  ? await api.useTemplate(templateCode, { name, description })
                  : await api.createServer({ name, description, visibility, autoJoin: autoJoinChecked });
                bus.emit('state:servers'); // trigger refresh via shell listener below
                bus.emit('ui:serverCreated', res.server);
                m.close();
              } catch (err) {
                body.querySelector('#srv-err').textContent = apiErrorMessage(err, t('serverRail.couldNotCreateServer'));
              }
            };
            body.querySelector('#srv-create').addEventListener('click', submit);
            nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
          } else if (tab === 'site') {
            const nameInput = body.querySelector('#site-name');
            nameInput.focus();
            const submit = async () => {
              const name = nameInput.value.trim();
              if (!name) return;
              draftName = name;
              try {
                const res = await api.siteCreate({ name });
                bus.emit('ui:serverCreated', res.server);
                m.close();
              } catch (err) {
                body.querySelector('#srv-err').textContent = apiErrorMessage(err, t('sites.couldNotCreate'));
              }
            };
            body.querySelector('#site-create').addEventListener('click', submit);
            nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
          } else if (tab === 'join') {
            const codeInput = body.querySelector('#srv-invite');
            codeInput.focus();
            const submit = async () => {
              const code = codeInput.value.trim();
              if (!code) return;
              try {
                await joinWithCode(code);
                m.close();
              } catch (err) {
                body.querySelector('#srv-err').textContent = apiErrorMessage(err, t('serverRail.invalidInviteCode'));
              }
            };
            body.querySelector('#srv-join').addEventListener('click', submit);
            codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
          } else {
            const searchInput = body.querySelector('#srv-search');
            searchInput.focus();
            let debounceTimer = null;
            searchInput.addEventListener('input', () => {
              clearTimeout(debounceTimer);
              debounceTimer = setTimeout(() => loadDiscover(searchInput.value.trim()), 250);
            });
            body.querySelector('#srv-discover-list').addEventListener('click', async (e) => {
              const btn = e.target.closest('[data-join-id]');
              if (!btn) return;
              btn.disabled = true;
              try {
                const res = await api.joinPublicServer(Number(btn.dataset.joinId));
                bus.emit('ui:serverCreated', res.server);
                m.close();
              } catch (err) {
                btn.disabled = false;
                toast(apiErrorMessage(err, t('serverRail.couldNotJoinServer')), { type: 'error' });
              }
            });
          }
        }

        async function loadDiscover(q) {
          try {
            const res = await api.discoverServers(q);
            discoverResults = res.servers;
          } catch { discoverResults = []; }
          const listEl = body.querySelector('#srv-discover-list');
          if (listEl) listEl.innerHTML = renderDiscoverList();
        }

        function renderDiscoverList() {
          if (discoverResults === null) return `<div class="empty-state" style="padding:24px"><p>${t('serverRail.loading')}</p></div>`;
          if (discoverResults.length === 0) return `<div class="empty-state" style="padding:24px"><p>${t('serverRail.noPublicServersFound')}</p></div>`;
          return discoverResults.map((s) => `
            <div class="list-row">
              <div class="rail-icon" style="width:36px;height:36px;flex-shrink:0;overflow:hidden;cursor:default">${serverIconHtml(s, 36)}</div>
              <div class="lr-main">
                <div class="lr-title">${escapeHtml(s.name)}</div>
                <div class="lr-sub">${escapeHtml(s.description || '')} · ${s.memberCount} ${s.memberCount === 1 ? t('serverRail.memberSingular') : t('serverRail.memberPlural')}</div>
              </div>
              ${s.joined
                ? `<span class="pill-static">${t('serverRail.joinedPill')}</span>`
                : `<button class="btn btn-secondary" data-join-id="${s.id}">${t('serverRail.joinButton')}</button>`}
            </div>`).join('');
        }
      },
    });
  }

  function destroy() {
    offServers(); offView(); offRead(); offDetail(); offLayout(); offRemote(); offMsg(); hideTooltip();
  }

  return { destroy };
}
