import { bus } from '../bus.js';
import { api } from '../api.js';
import { state, presenceFor, isUnread, removeDm, serverPrefFor, isChannelMuted, dmPrefFor, setDmPref, nameFor, isScopeMuted, setReadState, getKnownUser } from '../state.js';
import { icons } from '../icons.js';
import { avatarHtml, escapeHtml, toast, apiErrorMessage } from '../utils.js';
import { has, PERMISSIONS, memberPermissionBits } from '../permissions.js';
import { openContextMenu, openModal, confirmModal, promptModal } from './modal.js';
import { openServerSettings } from './serverSettings.js';
import { openEventsModal } from './events.js';
import { t } from '../i18n.js';
import { inviteLinkFor } from '../inviteHash.mjs';
import { peekPlaintext } from '../e2ee/dmCrypto.js';
import { userActionItems, muteSubmenu, unmute } from './userMenu.js';
import { openFullProfile } from './fullProfile.js';

const CHANNEL_ICON = { public: icons.hash, private: icons.lock, announcement: icons.megaphone, readonly: icons.eye, voice: icons.headphones, forum: icons.messageSquare, stage: icons.stage, notes: icons.book };

// ---------------- server (channel) sidebar ----------------

export function mountChannelSidebar(container, detail) {
  const { server, channels, roles, members } = detail;
  const categories = detail.categories || [];
  const me = state.me;
  const myMember = members.find((m) => m.user.id === me.id);
  const isOwner = server.owner_id === me.id;
  const myBits = memberPermissionBits(server, roles, myMember, me.id);
  const canManageChannels = isOwner || has(myBits, PERMISSIONS.MANAGE_CHANNELS);
  const canManageServer = isOwner || has(myBits, PERMISSIONS.MANAGE_SERVER) || has(myBits, PERMISSIONS.MANAGE_ROLES)
    || has(myBits, PERMISSIONS.KICK_MEMBERS) || has(myBits, PERMISSIONS.BAN_MEMBERS) || canManageChannels;

  let draggingChannelId = null;
  let draggingCategoryId = null;
  // Which-categories-are-collapsed is purely a this-session UI convenience, not persisted —
  // resets to "everything open" on next reload, same as most Discord-like clients default to.
  const collapsedCategories = new Set();

  render();
  const offMsg = bus.on('ws:message_create', ({ message }) => {
    if (message.scopeType !== 'channel') return;
    const ch = channels.find((c) => c.id === message.scopeId);
    if (ch) { ch.last_message_id = message.id; render(); }
  });
  const offRead = bus.on('state:readState', render);
  const offPrefs = bus.on('state:serverPrefs', (id) => { if (id === server.id) render(); });
  const offVoice = bus.on('state:serverVoice', render);

  function render() {
    container.innerHTML = `
      <div class="sidebar-header" id="sh-header">
        <span class="title">${escapeHtml(server.name)}</span>
        ${icons.chevronDown(16)}
      </div>
      <div class="sidebar-scroll" id="sh-scroll">
        ${server.welcome_enabled ? `
          <div class="channel-item ${state.view.type === 'server' && state.view.serverId === server.id && state.view.welcome ? 'active' : ''}" data-welcome>
            <span class="ch-icon">${icons.flag(16)}</span>
            <span class="ch-name">${t('sidebar.welcomeLabel')}</span>
          </div>` : ''}
        <div class="sidebar-section-label" id="sh-channels-label">
          <span>${t('sidebar.channelsLabel')}</span>
          ${canManageChannels ? `<button class="btn-icon add-btn" id="sh-add-channel" style="width:18px;height:18px">${icons.plus(14)}</button>` : ''}
        </div>
        <div id="sh-channel-list"></div>
      </div>`;

    container.querySelector('[data-welcome]')?.addEventListener('click', () => {
      bus.emit('ui:navigate', { type: 'server', serverId: server.id, welcome: true });
    });

    const listEl = container.querySelector('#sh-channel-list');
    const groups = groupByCategory(visibleChannels(), categories);
    listEl.innerHTML = groups.map(renderGroup).join('') || `<div style="padding:8px 16px;color:var(--text-muted);font-size:13px">${t('sidebar.noChannelsVisible')}</div>`;

    listEl.querySelectorAll('[data-channel]').forEach((node) => {
      const channelId = Number(node.dataset.channel);
      node.addEventListener('click', (e) => {
        if (e.target.closest('[data-gear]')) return;
        bus.emit('ui:navigate', { type: 'server', serverId: server.id, channelId });
      });
      if (!canManageChannels) return;
      node.addEventListener('dragstart', (e) => {
        draggingChannelId = channelId;
        draggingCategoryId = null;
        e.dataTransfer.effectAllowed = 'move';
      });
      node.addEventListener('dragover', (e) => {
        if (draggingChannelId === null || draggingChannelId === channelId) return;
        e.preventDefault();
        node.classList.add('drag-over');
      });
      node.addEventListener('dragleave', () => node.classList.remove('drag-over'));
      node.addEventListener('drop', (e) => {
        e.preventDefault();
        node.classList.remove('drag-over');
        moveChannel(draggingChannelId, channels.find((c) => c.id === channelId)?.category_id ?? null, channelId);
        draggingChannelId = null;
      });
      node.addEventListener('dragend', () => {
        draggingChannelId = null;
        listEl.querySelectorAll('.drag-over').forEach((n) => n.classList.remove('drag-over'));
      });
    });
    listEl.querySelectorAll('[data-gear]').forEach((node) => {
      node.addEventListener('click', (e) => {
        e.stopPropagation();
        openServerSettings(server.id, { tab: 'channels', focusChannelId: Number(node.dataset.gear) });
      });
    });

    listEl.querySelectorAll('[data-cat-header]').forEach((node) => {
      const catId = Number(node.dataset.catHeader);
      node.addEventListener('click', (e) => {
        if (e.target.closest('[data-cat-gear]')) return;
        if (collapsedCategories.has(catId)) collapsedCategories.delete(catId);
        else collapsedCategories.add(catId);
        render();
      });
      if (!canManageChannels) return;
      node.addEventListener('dragstart', (e) => {
        draggingCategoryId = catId;
        draggingChannelId = null;
        e.dataTransfer.effectAllowed = 'move';
      });
      node.addEventListener('dragover', (e) => {
        if (draggingChannelId === null && (draggingCategoryId === null || draggingCategoryId === catId)) return;
        e.preventDefault();
        node.classList.add('drag-over');
      });
      node.addEventListener('dragleave', () => node.classList.remove('drag-over'));
      node.addEventListener('drop', (e) => {
        e.preventDefault();
        node.classList.remove('drag-over');
        if (draggingChannelId !== null) {
          moveChannel(draggingChannelId, catId, null);
          draggingChannelId = null;
        } else if (draggingCategoryId !== null) {
          moveCategory(draggingCategoryId, catId);
          draggingCategoryId = null;
        }
      });
      node.addEventListener('dragend', () => {
        draggingCategoryId = null;
        listEl.querySelectorAll('.drag-over').forEach((n) => n.classList.remove('drag-over'));
      });
    });
    listEl.querySelectorAll('[data-cat-gear]').forEach((node) => {
      node.addEventListener('click', (e) => {
        e.stopPropagation();
        const rect = node.getBoundingClientRect();
        const category = categories.find((c) => c.id === Number(node.dataset.catGear));
        openContextMenu(rect.left, rect.bottom + 4, [
          { label: t('sidebar.createChannelMenuItem'), icon: icons.plus, onClick: () => openServerSettings(server.id, { tab: 'channels', createNew: true }) },
          { label: t('sidebar.renameCategoryMenuItem'), icon: icons.edit, onClick: () => renameCategory(category) },
          { label: t('sidebar.deleteCategoryMenuItem'), icon: icons.trash, danger: true, onClick: () => deleteCategory(category) },
        ]);
      });
    });

    container.querySelector('#sh-header').addEventListener('click', (e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const items = [];
      items.push({ label: t('sidebar.inviteMenuItem'), icon: icons.plus, onClick: () => openInviteModal(server) });
      items.push({ label: t('sidebar.eventsMenuItem'), icon: icons.calendar, onClick: () => openEventsModal(server, { canManage: canManageServer, channels }) });
      if (canManageServer) items.push({ label: t('sidebar.serverSettingsMenuItem'), icon: icons.gear, onClick: () => openServerSettings(server.id) });
      if (canManageChannels) items.push({ label: t('sidebar.createChannelMenuItem'), icon: icons.plus, onClick: () => openServerSettings(server.id, { tab: 'channels', createNew: true }) });
      if (canManageChannels) items.push({ label: t('sidebar.createCategoryMenuItem'), icon: icons.plus, onClick: () => createCategory() });
      items.push('sep');
      if (isOwner) {
        items.push({ label: t('sidebar.deleteServerMenuItem'), icon: icons.trash, danger: true, onClick: () => deleteServer(server) });
      } else {
        items.push({ label: t('sidebar.leaveServerMenuItem'), icon: icons.logout, danger: true, onClick: () => leaveServer(server) });
      }
      openContextMenu(rect.left, rect.bottom + 4, items);
    });

    if (canManageChannels) {
      container.querySelector('#sh-add-channel').addEventListener('click', (e) => {
        e.stopPropagation();
        openServerSettings(server.id, { tab: 'channels', createNew: true });
      });

      // The uncategorized bucket has no header of its own to drop onto (it renders with no
      // label at all, Discord-style) - when it's empty there was previously nowhere at all to
      // drop a channel to pull it out of a category, short of reassigning it in Server Settings.
      // The "Channels" section label always exists regardless of channel count, so it doubles as
      // that drop target.
      const channelsLabel = container.querySelector('#sh-channels-label');
      channelsLabel.addEventListener('dragover', (e) => {
        if (draggingChannelId === null) return;
        e.preventDefault();
        channelsLabel.classList.add('drag-over');
      });
      channelsLabel.addEventListener('dragleave', () => channelsLabel.classList.remove('drag-over'));
      channelsLabel.addEventListener('drop', (e) => {
        e.preventDefault();
        channelsLabel.classList.remove('drag-over');
        moveChannel(draggingChannelId, null, null);
        draggingChannelId = null;
      });
    }
  }

  // Groups the flat channel list into category buckets for rendering: an implicit "uncategorized"
  // bucket (category_id null) always renders first with no header, matching Discord's own layout,
  // followed by real categories in position order.
  // The per-server menu's "hide muted channels" / "show all channels" switches. The channel you
  // are looking at always stays listed so it can't vanish from under you.
  function visibleChannels() {
    const pref = serverPrefFor(server.id);
    const activeId = state.view.type === 'server' ? state.view.channelId : null;
    return channels.filter((ch) => {
      if (ch.id === activeId) return true;
      if (pref.hideMutedChannels && isChannelMuted(server.id, ch.id)) return false;
      if (!pref.showAllChannels && !isUnread('channel', ch.id, ch.last_message_id)) return false;
      return true;
    });
  }

  function groupByCategory(chs, cats) {
    const byCat = new Map();
    for (const ch of chs) {
      const key = ch.category_id || null;
      if (!byCat.has(key)) byCat.set(key, []);
      byCat.get(key).push(ch);
    }
    for (const arr of byCat.values()) arr.sort((a, b) => a.position - b.position);
    const groups = [{ id: null, name: null, channels: byCat.get(null) || [] }];
    for (const cat of [...cats].sort((a, b) => a.position - b.position)) {
      groups.push({ id: cat.id, name: cat.name, channels: byCat.get(cat.id) || [] });
    }
    return groups;
  }

  function renderGroup(g) {
    if (g.id === null) return g.channels.map(renderChannelRow).join('');
    const collapsed = collapsedCategories.has(g.id);
    return `
      <div class="channel-category-header" data-cat-header="${g.id}" ${canManageChannels ? 'draggable="true"' : ''}>
        ${collapsed ? icons.chevronRight(12) : icons.chevronDown(12)}
        <span class="cat-name">${escapeHtml(g.name)}</span>
        ${canManageChannels ? `<span class="ch-gear" data-cat-gear="${g.id}">${icons.gear(14)}</span>` : ''}
      </div>
      ${collapsed ? '' : g.channels.map(renderChannelRow).join('')}`;
  }

  function renderChannelRow(ch) {
    const unread = state.view.type !== 'server' || state.view.channelId !== ch.id ? isUnread('channel', ch.id, ch.last_message_id) : false;
    return `
      <div class="channel-item ${state.view.type === 'server' && state.view.channelId === ch.id ? 'active' : ''} ${unread ? 'unread' : ''}"
           data-channel="${ch.id}" ${canManageChannels ? 'draggable="true"' : ''}>
        <span class="ch-icon">${ch.icon_path
          ? `<img src="${escapeHtml(ch.icon_path)}" style="width:16px;height:16px;border-radius:4px;object-fit:cover">`
          : (CHANNEL_ICON[ch.type] || icons.hash)(16)}</span>
        <span class="ch-name">${escapeHtml(ch.name)}</span>${ch.nsfw ? `<span class="nsfw-badge" title="${escapeHtml(t('ageGate.badgeTitle'))}">18+</span>` : ''}
        ${(ch.type === 'voice' || ch.type === 'stage') ? voiceCountBadge(ch) : ''}
        ${canManageChannels ? `<span class="ch-gear" data-gear="${ch.id}">${icons.gear(16)}</span>` : ''}
      </div>${(ch.type === 'voice' || ch.type === 'stage') ? voiceRoster(ch) : ''}`;
  }

  function voiceUserIds(ch) {
    const ids = [];
    for (const [userId, chId] of state.serverVoice) if (chId === ch.id) ids.push(userId);
    return ids;
  }

  function voiceCountBadge(ch) {
    const n = voiceUserIds(ch).length;
    return n ? `<span class="ch-voice-count" title="${escapeHtml(t('sidebar.voiceCountTitle', { count: n }))}">${n}</span>` : '';
  }

  function voiceRoster(ch) {
    const rows = voiceUserIds(ch).map((id) => {
      const u = id === state.me.id ? state.me : getKnownUser(id);
      return `<div class="ch-voice-user">${u ? avatarHtml(u, 18) : ''}<span class="name">${escapeHtml(u?.displayName || u?.username || '…')}</span></div>`;
    });
    return rows.length ? `<div class="ch-voice-users">${rows.join('')}</div>` : '';
  }

  // Reorders categories by dropping `draggedId` onto `targetId` - same recompute-every-position
  // approach as moveChannel, just over the categories array instead of channels.
  function moveCategory(draggedId, targetId) {
    const dragged = categories.find((c) => c.id === draggedId);
    if (!dragged) return;
    const fromIdx = categories.indexOf(dragged);
    categories.splice(fromIdx, 1);
    const toIdx = categories.findIndex((c) => c.id === targetId);
    categories.splice(toIdx === -1 ? categories.length : toIdx, 0, dragged);

    render();
    categories.forEach((cat, i) => {
      if (cat.position === i) return;
      cat.position = i;
      api.updateCategory(server.id, cat.id, { position: i }).catch(() => toast(t('sidebar.couldNotSaveCategoryOrder'), { type: 'error' }));
    });
  }

  // Moves the dragged channel into `targetCategoryId` (null = uncategorized) and repositions it
  // next to `targetChannelId` (or, when dropped on a category header/empty group, appends it —
  // still lands last within that category once grouped, since it gets the highest global position
  // of anyone). `channels` is the same array reference held in state.serverDetail, so the mutation
  // is visible everywhere else that reads it too; every channel whose position or category
  // actually changed is then persisted. Recomputing position as 0..n-1 across the whole server
  // (rather than a fractional slot between neighbors) keeps this simple and self-healing even if
  // positions had drifted before.
  function moveChannel(draggedId, targetCategoryId, targetChannelId) {
    const dragged = channels.find((c) => c.id === draggedId);
    if (!dragged) return;
    const categoryChanged = (dragged.category_id || null) !== (targetCategoryId || null);
    dragged.category_id = targetCategoryId || null;

    const fromIdx = channels.indexOf(dragged);
    channels.splice(fromIdx, 1);
    const toIdx = targetChannelId != null ? channels.findIndex((c) => c.id === targetChannelId) : -1;
    channels.splice(toIdx === -1 ? channels.length : toIdx, 0, dragged);

    render();
    channels.forEach((ch, i) => {
      const payload = {};
      if (ch.position !== i) payload.position = i;
      if (ch === dragged && categoryChanged) payload.categoryId = targetCategoryId || null;
      if (Object.keys(payload).length === 0) return;
      ch.position = i;
      api.updateChannel(server.id, ch.id, payload).catch(() => toast(t('sidebar.couldNotSaveChannelOrder'), { type: 'error' }));
    });
  }

  async function createCategory() {
    const name = await promptModal({ title: t('sidebar.createCategoryMenuItem'), label: t('sidebar.categoryNameLabel'), value: t('sidebar.newCategoryDefaultName'), confirmLabel: t('sidebar.createButton') });
    if (!name) return;
    api.createCategory(server.id, { name }).catch((err) => toast(apiErrorMessage(err, t('sidebar.couldNotCreateCategory')), { type: 'error' }));
  }

  async function renameCategory(category) {
    const name = await promptModal({ title: t('sidebar.renameCategoryMenuItem'), label: t('sidebar.categoryNameLabel'), value: category.name, confirmLabel: t('sidebar.renameButton') });
    if (!name || name === category.name) return;
    api.updateCategory(server.id, category.id, { name }).catch((err) => toast(apiErrorMessage(err, t('sidebar.couldNotRenameCategory')), { type: 'error' }));
  }

  function deleteCategory(category) {
    confirmModal({
      title: t('sidebar.deleteCategoryMenuItem'),
      message: t('sidebar.deleteCategoryConfirmMessage', { name: escapeHtml(category.name) }),
      confirmLabel: t('sidebar.deleteCategoryMenuItem'),
      async onConfirm() {
        try { await api.deleteCategory(server.id, category.id); }
        catch (err) { toast(apiErrorMessage(err, t('sidebar.couldNotDeleteCategory')), { type: 'error' }); }
      },
    });
  }

  function destroy() { offMsg(); offRead(); offPrefs(); offVoice(); }
  return { destroy };
}

export function openInviteModal(server) {
  const m = openModal({
    title: t('sidebar.inviteFriendsTitle', { server: server.name }),
    render(body) {
      body.innerHTML = `
        <p style="color:var(--text-secondary);font-size:14px;margin:0 0 12px">${t('sidebar.shareCodeHint')}</p>
        <div class="invite-box">
          <div class="invite-code">${escapeHtml(server.invite_code || '')}</div>
          <button class="btn btn-secondary" id="inv-copy">${t('sidebar.copyButton')}</button>
          <button class="btn btn-secondary" id="inv-copy-link">${t('invites.copyLink')}</button>
        </div>`;
      body.querySelector('#inv-copy-link').addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(inviteLinkFor(server.invite_code || ''));
          toast(t('invites.linkCopied'));
        } catch { toast(t('sidebar.couldNotCopyManual')); }
      });
      body.querySelector('#inv-copy').addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(server.invite_code || '');
          toast(t('sidebar.inviteCodeCopied'));
        } catch { toast(t('sidebar.couldNotCopyManual')); }
      });
    },
  });
}

export function deleteServer(server) {
  confirmModal({
    title: t('sidebar.deleteServerMenuItem'),
    message: t('sidebar.deleteServerConfirmMessage', { name: escapeHtml(server.name) }),
    confirmLabel: t('sidebar.deleteServerMenuItem'),
    async onConfirm() {
      try {
        await api.deleteServer(server.id);
        bus.emit('ui:serverRemoved', server.id);
      } catch (err) {
        toast(apiErrorMessage(err, t('sidebar.couldNotDeleteServer')), { type: 'error' });
      }
    },
  });
}

export function leaveServer(server) {
  confirmModal({
    title: t('sidebar.leaveServerMenuItem'),
    message: t('sidebar.leaveServerConfirmMessage', { name: escapeHtml(server.name) }),
    confirmLabel: t('sidebar.leaveServerMenuItem'),
    async onConfirm() {
      try {
        await api.leaveServer(server.id);
        bus.emit('ui:serverRemoved', server.id);
      } catch (err) {
        toast(apiErrorMessage(err, t('sidebar.couldNotLeaveServer')), { type: 'error' });
      }
    },
  });
}

// ---------------- home sidebar (friends + DMs) ----------------

export function mountHomeSidebar(container) {
  render();
  const offDms = bus.on('state:dms', render);
  const offPresence = bus.on('state:presence', render);
  const offView = bus.on('state:view', render);
  const offRead = bus.on('state:readState', render);
  const offAnn = bus.on('state:annotations', render);
  const offNotif = bus.on('state:notificationPrefs', render);

  function render() {
    const activeIsFriends = state.view.type === 'friends';
    container.innerHTML = `
      <div class="sidebar-header"><span class="title">MeshCrowd</span></div>
      <div class="sidebar-scroll" id="hs-scroll">
        <div style="padding:8px">
          <div class="nav-item ${activeIsFriends ? 'active' : ''}" id="nav-friends">
            <span class="nav-icon">${icons.users(20)}</span>
            <span class="label">${t('sidebar.friendsNavLabel')}</span>
          </div>
        </div>
        <div class="sidebar-section-label">
          <span>${t('sidebar.directMessagesLabel')}</span>
          <button class="btn-icon add-btn" id="hs-add-dm" style="width:18px;height:18px">${icons.plus(14)}</button>
        </div>
        <div id="hs-dm-list"></div>
      </div>`;

    container.querySelector('#nav-friends').addEventListener('click', () => {
      bus.emit('ui:navigate', { type: 'friends', tab: 'online' });
    });
    container.querySelector('#hs-add-dm').addEventListener('click', openNewDmModal);

    const listEl = container.querySelector('#hs-dm-list');
    listEl.innerHTML = visibleDms().map((dm) => renderDmRow(dm)).join('') || `<div style="padding:8px 16px;color:var(--text-muted);font-size:13px">${t('sidebar.noConversationsYet')}</div>`;
    listEl.querySelectorAll('[data-dm]').forEach((node) => {
      const dmId = Number(node.dataset.dm);
      node.addEventListener('click', () => bus.emit('ui:navigate', { type: 'dm', dmId }));
      node.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const dm = state.dms.find((d) => d.id === dmId);
        if (dm) openDmContextMenu(e.clientX, e.clientY, dm);
      });
    });
  }

  // Pinned conversations first, then favorites, then the rest in their usual order; a conversation
  // the user closed stays out of the list until a new message brings it back.
  function visibleDms() {
    const rank = (dm) => (dmPrefFor(dm.id).pinned ? 0 : dmPrefFor(dm.id).favorite ? 1 : 2);
    return state.dms.filter((dm) => !dmPrefFor(dm.id).hidden)
      .map((dm, i) => ({ dm, i }))
      .sort((x, y) => rank(x.dm) - rank(y.dm) || x.i - y.i)
      .map((x) => x.dm);
  }

  async function updateDmPref(dm, patch) {
    try { setDmPref((await api.setDmPref(dm.id, patch)).pref); } catch (err) { toast(apiErrorMessage(err), { type: 'error' }); }
  }

  async function markDmRead(dm) {
    if (!dm.lastMessage) return;
    try { await api.markRead('dm', dm.id, dm.lastMessage.id); setReadState('dm', dm.id, dm.lastMessage.id); } catch { /* best-effort */ }
  }

  // A 1:1 gets the full person menu; a group keeps the Delete (creator) / Leave split. Closing a
  // 1:1 only hides it, so it no longer offers a destructive "leave".
  function openDmContextMenu(x, y, dm) {
    const isCreator = dm.isGroup && dm.createdBy === state.me.id;
    const label = dm.isGroup ? (dm.name || dm.members.map((m) => m.displayName).join(', ')) : (dm.members[0]?.displayName || t('sidebar.thisConversationFallback'));
    const pref = dmPrefFor(dm.id);
    const unread = isUnread('dm', dm.id, dm.lastMessage?.id);
    const leaveOrDelete = () => {
      confirmModal({
        title: isCreator ? t('sidebar.deleteGroupMenuItem') : t('sidebar.leaveConversationMenuItem'),
        message: isCreator
          ? t('sidebar.deleteGroupConfirmMessage', { name: escapeHtml(label) })
          : t('sidebar.leaveConversationConfirmMessage', { name: escapeHtml(label) }),
        confirmLabel: isCreator ? t('common.deleteForever') : t('sidebar.leaveButton'),
        onConfirm: async () => {
          try {
            if (isCreator) await api.deleteDm(dm.id); else await api.leaveDm(dm.id);
            removeDm(dm.id);
            if (state.view.type === 'dm' && state.view.dmId === dm.id) bus.emit('ui:navigate', { type: 'home' });
          } catch (err) { toast(apiErrorMessage(err, t('sidebar.couldNotLeaveConversation')), { type: 'error' }); }
        },
      });
    };
    const close = async () => {
      await updateDmPref(dm, { hidden: true });
      if (state.view.type === 'dm' && state.view.dmId === dm.id) bus.emit('ui:navigate', { type: 'home' });
    };
    const muted = isScopeMuted('dm', dm.id);
    const muteItem = muted
      ? { label: dm.isGroup ? t('dmMenu.unmuteConversation') : t('dmMenu.unmuteUser', { name: label }), onClick: () => unmute('dm', dm.id) }
      : { label: dm.isGroup ? t('dmMenu.muteConversation') : t('dmMenu.muteUser', { name: label }), submenu: muteSubmenu('dm', dm.id) };
    const head = [
      { label: t('serverRail.markAsReadMenuItem'), disabled: !unread, onClick: () => markDmRead(dm) },
      'sep',
      { label: pref.pinned ? t('dmMenu.unpin') : t('dmMenu.pin'), onClick: () => updateDmPref(dm, { pinned: !pref.pinned }) },
      { label: pref.favorite ? t('dmMenu.unfavorite') : t('dmMenu.favorite'), onClick: () => updateDmPref(dm, { favorite: !pref.favorite }) },
      'sep',
    ];
    if (dm.isGroup) {
      openContextMenu(x, y, [
        ...head,
        muteItem,
        'sep',
        { label: isCreator ? t('sidebar.deleteGroupMenuItem') : t('sidebar.leaveConversationMenuItem'), icon: isCreator ? icons.trash : icons.logout, danger: true, onClick: leaveOrDelete },
      ]);
      return;
    }
    const other = dm.members[0];
    if (!other) return;
    openContextMenu(x, y, [
      ...head,
      ...userActionItems(other, { openProfile: (id) => openFullProfile(id), withClose: { label: t('dmMenu.closeConversation'), onClick: close } }),
      'sep',
      muteItem,
    ]);
  }

  function renderDmRow(dm) {
    const active = state.view.type === 'dm' && state.view.dmId === dm.id;
    const other = dm.members[0];
    const name = dm.isGroup ? (dm.name || dm.members.map((m) => m.displayName).join(', ')) : (other ? nameFor(other) : t('sidebar.unknownUserFallback'));
    const pref = dmPrefFor(dm.id);
    const avatarUser = dm.isGroup ? null : presenceFor(other);
    const preview = dm.lastMessage
      ? (dm.lastMessage.isEncrypted
        ? (peekPlaintext(state.me.id, dm.lastMessage.id)?.text || t('dmEncryption.encryptedPreview'))
        : dm.lastMessage.content || (dm.lastMessage.attachments?.length ? t('sidebar.sentAnAttachment') : ''))
      : t('sidebar.noMessagesYetPreview');
    const status = avatarUser?.status === 'invisible' ? 'offline' : (avatarUser?.status || 'offline');
    const unread = !active && isUnread('dm', dm.id, dm.lastMessage?.id);
    return `
      <div class="nav-item dm-item ${active ? 'active' : ''} ${unread ? 'unread' : ''}" data-dm="${dm.id}">
        <div class="avatar-wrap">
          ${dm.isGroup
            ? `<div class="avatar avatar-fallback" style="width:32px;height:32px;font-size:13px">${icons.users(16)}</div>`
            : avatarHtml(avatarUser || other, 32)}
          ${!dm.isGroup ? `<div class="status-dot ${status}"></div>` : ''}
        </div>
        <div class="meta">
          <div class="name">${escapeHtml(name)}${pref.pinned ? ` <span class="dm-flag" title="${t('dmMenu.pinned')}">${icons.pin(12)}</span>` : ''}${pref.favorite ? ` <span class="dm-flag" title="${t('dmMenu.favorite')}">${icons.star ? icons.star(12) : ''}</span>` : ''}${isScopeMuted('dm', dm.id) ? ` <span class="dm-flag" title="${t('dmMenu.muted')}">${icons.bellOff ? icons.bellOff(12) : ''}</span>` : ''}</div>
          <div class="preview">${escapeHtml(preview)}</div>
        </div>
        ${unread ? '<div class="unread-dot"></div>' : ''}
      </div>`;
  }

  function destroy() { offDms(); offPresence(); offView(); offRead(); offAnn(); offNotif(); }
  return { destroy };
}

export function openNewDmModal() {
  const m = openModal({
    title: t('sidebar.selectFriendModalTitle'),
    render(body) {
      const friends = state.friends.friends || [];
      if (friends.length === 0) {
        body.innerHTML = `<div class="empty-state" style="padding:20px 0"><p>${t('sidebar.addFriendsFirstHint')}</p></div>`;
        return;
      }
      body.innerHTML = `<div>${friends.map((f) => `
        <div class="list-row" data-pick="${f.user.id}" style="cursor:pointer">
          ${avatarHtml(f.user, 36)}
          <div class="lr-main"><div class="lr-title">${escapeHtml(f.user.displayName)}</div><div class="lr-sub">@${escapeHtml(f.user.username)}</div></div>
        </div>`).join('')}</div>`;
      body.querySelectorAll('[data-pick]').forEach((node) => {
        node.addEventListener('click', async () => {
          try {
            const res = await api.openDm(Number(node.dataset.pick));
            const dmsRes = await api.listDms();
            state.dms = dmsRes.dms;
            bus.emit('state:dms');
            bus.emit('ui:navigate', { type: 'dm', dmId: res.dmId });
            m.close();
          } catch (err) {
            toast(apiErrorMessage(err, t('sidebar.couldNotStartConversation')), { type: 'error' });
          }
        });
      });
    },
  });
}
