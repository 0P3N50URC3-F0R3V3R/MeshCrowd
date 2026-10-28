import { bus } from '../bus.js';
import { api } from '../api.js';
import { state, setRemoteServers } from '../state.js';
import { icons } from '../icons.js';
import { avatarHtml, escapeHtml, renderMessageContent, formatTimestamp, formatShortTime, formatBytes, isImageMime, toast, apiErrorMessage, debounce } from '../utils.js';
import { confirmModal } from './modal.js';
import { openEmojiPicker } from './emojiPicker.js';
import { t } from '../i18n.js';

const CHANNEL_ICON = { public: icons.hash, private: icons.lock, announcement: icons.megaphone, readonly: icons.eye };
const INFO_TTL_MS = 15_000;
const GROUP_GAP_MS = 5 * 60 * 1000;

// `${peerId}:${serverId}` -> { at, info }. Only a short-lived convenience so hopping between
// channels of the same remote server does not re-ask the owning instance every time.
const infoCache = new Map();
// Which right-hand panel ('members' | 'threads') stays open while hopping between remote channels.
let openPanel = null;
const MAX_FILES = 5;

export function getRemoteInfo(peerId, serverId) {
  return infoCache.get(`${peerId}:${serverId}`)?.info || null;
}

export async function refreshRemoteServers() {
  try { setRemoteServers((await api.listRemoteServers()).servers); } catch { /* the rail keeps its last known list */ }
}

function errorText(err, fallback) {
  return err?.body?.error === 'unreachable' ? t('remote.unreachable') : apiErrorMessage(err, fallback);
}

export function confirmLeaveRemote(entry) {
  confirmModal({
    title: t('remote.leaveTitle'),
    message: t('remote.leaveConfirm', { name: escapeHtml(entry.name), domain: escapeHtml(entry.domain) }),
    confirmLabel: t('remote.leaveButton'),
    async onConfirm() {
      try { await api.leaveRemoteServer(entry.peerId, entry.serverId); }
      catch (err) { toast(errorText(err, t('remote.couldNotLeave')), { type: 'error' }); return; }
      infoCache.delete(`${entry.peerId}:${entry.serverId}`);
      await refreshRemoteServers();
      const v = state.view;
      if (v.type === 'remote' && v.peerId === entry.peerId && v.serverId === entry.serverId) bus.emit('ui:navigate', { type: 'home' });
    },
  });
}

// Simplified, read/post-only view of a server owned by a paired instance. Everything shown is
// fetched live through this instance's /api/remote proxy; nothing from the remote server is stored
// locally and message text is only ever rendered through the escaping renderer (never raw HTML).
export function mountRemoteServer({ sidebarEl, mainEl }, view) {
  const { peerId, serverId } = view;
  let destroyed = false;
  let info = null;
  let channelId = view.channelId || null;
  let messages = [];
  let hasMore = false;
  let loadingMore = false;
  let editingId = null;
  let editDraft = null;
  let sending = false;
  let failure = null; // 'unreachable' | 'gone' | null
  let thread = null; // { id, title } while a read-only thread is open
  let pendingFiles = [];
  const membersEl = document.getElementById('s-members');
  const offs = [];

  load();

  async function load(force = false) {
    const key = `${peerId}:${serverId}`;
    const cached = infoCache.get(key);
    if (!force && cached && Date.now() - cached.at < INFO_TTL_MS) info = cached.info;
    else {
      renderLoading();
      try {
        info = await api.getRemoteServer(peerId, serverId);
        infoCache.set(key, { at: Date.now(), info });
      } catch (err) {
        if (destroyed) return;
        if (err.status === 404) {
          toast(t('remote.notFound'), { type: 'error' });
          await refreshRemoteServers();
          bus.emit('ui:navigate', { type: 'home' });
          return;
        }
        failure = 'unreachable';
        info = cached?.info || null;
        renderFailure();
        return;
      }
    }
    if (destroyed) return;
    failure = null;
    bus.emit('remote:info', { peerId, serverId });
    if (!channelId || !info.channels.some((c) => c.id === channelId)) {
      const first = info.channels[0];
      if (first && first.id !== channelId) { queueMicrotask(() => { if (!destroyed) bus.emit('ui:navigate', { type: 'remote', peerId, serverId, channelId: first.id }); }); return; }
      channelId = first ? first.id : null;
    }
    renderSidebar();
    renderMain();
    if (channelId) loadMessages();
  }

  function channel() { return info?.channels.find((c) => c.id === channelId) || null; }

  function renderLoading() {
    sidebarEl.innerHTML = `<div class="sidebar-header"><span class="title">${escapeHtml(state.remoteServers.find((s) => s.peerId === peerId && s.serverId === serverId)?.name || '')}</span></div>
      <div class="panel-loading"><div class="spinner"></div></div>`;
    mainEl.innerHTML = `<div class="panel-loading"><div class="spinner"></div></div>`;
  }

  function renderFailure() {
    sidebarEl.innerHTML = `<div class="sidebar-header"><span class="title">${escapeHtml(state.remoteServers.find((s) => s.peerId === peerId && s.serverId === serverId)?.name || t('remote.serverFallback'))}</span></div>`;
    mainEl.innerHTML = `
      <div class="empty-state" style="height:100%">
        <div class="intro-icon" style="width:96px;height:96px">${icons.globe(48)}</div>
        <h3>${t('remote.unreachable')}</h3>
        <button class="btn btn-secondary" id="r-retry">${t('remote.retry')}</button>
      </div>`;
    mainEl.querySelector('#r-retry').addEventListener('click', () => load(true));
  }

  function renderSidebar() {
    sidebarEl.innerHTML = `
      <div class="sidebar-header">
        <span class="title">${escapeHtml(info.server.name)}</span>
      </div>
      <div class="sidebar-scroll">
        <div class="remote-host-note">${icons.globe(12)} ${t('remote.hostedOn', { domain: escapeHtml(info.domain) })}</div>
        <div class="sidebar-section-label"><span>${t('remote.channelsLabel')}</span></div>
        ${info.channels.map((c) => `
          <div class="channel-item ${c.id === channelId ? 'active' : ''}" data-channel="${c.id}">
            <span class="ch-icon">${(CHANNEL_ICON[c.type] || icons.hash)(16)}</span>
            <span class="ch-name">${escapeHtml(c.name)}</span>
          </div>`).join('') || `<div style="padding:8px 16px;color:var(--text-muted);font-size:13px">${t('remote.noChannels')}</div>`}
      </div>`;
    sidebarEl.querySelectorAll('[data-channel]').forEach((node) => {
      node.addEventListener('click', () => bus.emit('ui:navigate', { type: 'remote', peerId, serverId, channelId: Number(node.dataset.channel) }));
    });
  }

  function renderMain() {
    const ch = channel();
    if (!ch) {
      mainEl.innerHTML = `<div class="empty-state" style="height:100%"><div class="intro-icon" style="width:96px;height:96px">${icons.globe(48)}</div><h3>${t('remote.noChannels')}</h3></div>`;
      return;
    }
    const titleHtml = thread
      ? `<button class="btn-icon" id="r-thread-back" title="${escapeHtml(t('remote.backToChannel', { channel: ch.name }))}">${icons.chevronsLeft(18)}</button>
        <span class="ch-icon">${icons.messageSquare(18)}</span>
        <span class="ch-title">${escapeHtml(thread.title)}</span>
        <span class="ch-topic">${t('remote.threadReadOnly')}</span>`
      : `<span class="ch-icon">${(CHANNEL_ICON[ch.type] || icons.hash)(20)}</span>
        <span class="ch-title">${escapeHtml(ch.name)}</span>`;
    mainEl.innerHTML = `
      <div class="chat-header">
        ${titleHtml}
        <div class="spacer"></div>
        <span class="remote-host-note">${icons.globe(12)} ${escapeHtml(info.domain)}</span>
        <div class="header-actions">
          <button class="btn-icon" id="r-threads-btn" title="${t('remote.threadsTitle')}">${icons.messageSquare(18)}</button>
          <button class="btn-icon" id="r-members-btn" title="${t('remote.membersTitle')}">${icons.users(20)}</button>
        </div>
      </div>
      <div style="flex:1;display:flex;flex-direction:column;min-height:0">
        <div class="message-scroll" id="r-scroll"><div class="top-spacer"></div><div id="r-list"></div></div>
        <div class="composer-wrap" id="r-composer"></div>
      </div>`;
    const scrollEl = mainEl.querySelector('#r-scroll');
    scrollEl.addEventListener('scroll', debounce(() => { if (scrollEl.scrollTop < 80) loadOlder(); }, 150));
    mainEl.querySelector('#r-list').addEventListener('click', onListClick);
    mainEl.querySelector('#r-list').addEventListener('keydown', onListKeydown);
    mainEl.querySelector('#r-thread-back')?.addEventListener('click', () => openThread(null));
    mainEl.querySelector('#r-threads-btn').addEventListener('click', () => togglePanel('threads'));
    mainEl.querySelector('#r-members-btn').addEventListener('click', () => togglePanel('members'));
    // shell.js collapses the members slot right after mounting a remote view; reopen after it.
    if (openPanel) queueMicrotask(() => { if (!destroyed) renderPanel(); });
    renderComposer();
  }

  function togglePanel(mode) {
    openPanel = openPanel === mode ? null : mode;
    renderPanel();
  }

  function renderPanel() {
    if (!membersEl) return;
    if (!openPanel) { membersEl.classList.add('collapsed'); membersEl.innerHTML = ''; return; }
    membersEl.classList.remove('collapsed');
    const heading = openPanel === 'members' ? t('remote.membersTitle') : t('remote.threadsTitle');
    membersEl.innerHTML = `<div class="pinned-panel-head"><h3>${heading}</h3><button class="btn-icon" id="r-panel-close" title="${t('common.close')}">${icons.x(16)}</button></div>
      <div id="r-panel-body"><div class="panel-loading"><div class="spinner"></div></div></div>`;
    membersEl.querySelector('#r-panel-close').addEventListener('click', () => { openPanel = null; renderPanel(); });
    if (openPanel === 'members') loadMembersPanel();
    else loadThreadsPanel();
  }

  function panelBody(mode) {
    return openPanel === mode && !destroyed ? membersEl.querySelector('#r-panel-body') : null;
  }

  async function loadMembersPanel() {
    let members;
    try { members = (await api.listRemoteMembers(peerId, serverId)).members; }
    catch (err) { const body = panelBody('members'); if (body) body.innerHTML = `<div class="member-group-label">${escapeHtml(errorText(err, t('remote.couldNotLoadMembers')))}</div>`; return; }
    const body = panelBody('members');
    if (!body) return;
    const online = members.filter((m) => m.status !== 'offline');
    const offline = members.filter((m) => m.status === 'offline');
    const row = (m) => `
      <div class="member-item ${m.status === 'offline' ? 'offline' : ''}">
        <div class="avatar-wrap">
          ${avatarHtml({ id: m.id, displayName: m.displayName, username: m.username, avatarPath: m.hasAvatar ? api.remoteAvatarUrl(peerId, serverId, m.id) : null }, 32)}
          <div class="status-dot ${escapeHtml(m.status)}" style="width:10px;height:10px"></div>
        </div>
        <div class="m-meta">
          <div class="m-name">${m.isOwner ? '👑 ' : ''}${escapeHtml(m.displayName)}</div>
          <div class="m-status">@${escapeHtml(m.username)}${m.domain !== info.domain ? `<span class="remote-author-domain">@${escapeHtml(m.domain)}</span>` : ''}</div>
        </div>
      </div>`;
    const group = (label, list) => (list.length ? `<div class="member-group-label">${label} — ${list.length}</div>${list.map(row).join('')}` : '');
    body.innerHTML = group(t('memberList.online'), online) + group(t('memberList.offline'), offline)
      || `<div class="member-group-label">${t('memberList.noMembers')}</div>`;
  }

  async function loadThreadsPanel() {
    const forChannel = channelId;
    let threads;
    try { threads = (await api.listRemoteThreads(peerId, serverId, forChannel)).threads; }
    catch (err) { const body = panelBody('threads'); if (body) body.innerHTML = `<div class="member-group-label">${escapeHtml(errorText(err, t('remote.couldNotLoadThreads')))}</div>`; return; }
    const body = panelBody('threads');
    if (!body || forChannel !== channelId) return;
    body.innerHTML = threads.map((th) => `
      <div class="channel-item ${thread?.id === th.id ? 'active' : ''}" data-thread="${th.id}">
        <span class="ch-icon">${icons.messageSquare(16)}</span>
        <span class="ch-name">${escapeHtml(th.title)}</span>
        <span style="margin-left:auto;color:var(--text-muted);font-size:12px">${th.messageCount}</span>
      </div>`).join('') || `<div class="member-group-label">${t('remote.noThreads')}</div>`;
    body.querySelectorAll('[data-thread]').forEach((node) => {
      node.addEventListener('click', () => openThread(threads.find((th) => th.id === Number(node.dataset.thread))));
    });
  }

  function openThread(next) {
    thread = next ? { id: next.id, title: next.title } : null;
    editingId = null; editDraft = null;
    messages = []; hasMore = false;
    renderMain();
    loadMessages();
  }

  function fetchPage(query) {
    return thread
      ? api.listRemoteThreadMessages(peerId, serverId, channelId, thread.id, query)
      : api.listRemoteMessages(peerId, serverId, channelId, query);
  }

  function renderComposer() {
    const wrap = mainEl.querySelector('#r-composer');
    if (!wrap) return;
    const ch = channel();
    if (thread) {
      wrap.innerHTML = `<div class="no-perm-banner">${t('remote.threadReadOnlyBanner')}</div>`;
      return;
    }
    if (!ch.canSend) {
      wrap.innerHTML = `<div class="no-perm-banner">${t('remote.noPermissionBanner')}</div>`;
      return;
    }
    wrap.innerHTML = `
      <div class="upload-tray" id="r-tray"></div>
      <div class="composer">
        <button type="button" class="composer-btn" id="r-attach" title="${t('remote.attachTitle')}">${icons.plus(22)}</button>
        <input type="file" id="r-file-input" multiple class="hidden" accept="*/*">
        <textarea id="r-input" rows="1" enterkeyhint="send" placeholder="${escapeHtml(t('remote.composerPlaceholder', { channel: ch.name }))}"></textarea>
        <button type="button" class="composer-btn" id="r-emoji" title="${t('remote.emojiTitle')}">${icons.smile(22)}</button>
        <button type="button" class="composer-btn composer-btn-send" id="r-send" title="${t('remote.sendTitle')}">${icons.send(20)}</button>
      </div>`;
    const input = wrap.querySelector('#r-input');
    const fileInput = wrap.querySelector('#r-file-input');
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input); }
    });
    input.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files || [])];
      if (files.length) addFiles(files);
    });
    wrap.addEventListener('dragover', (e) => e.preventDefault());
    wrap.addEventListener('drop', (e) => {
      e.preventDefault();
      const files = [...(e.dataTransfer?.files || [])];
      if (files.length) addFiles(files);
    });
    wrap.querySelector('#r-attach').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => { addFiles([...fileInput.files]); fileInput.value = ''; });
    wrap.querySelector('#r-send').addEventListener('click', () => send(input));
    wrap.querySelector('#r-emoji').addEventListener('click', (e) => {
      openEmojiPicker(e.currentTarget, (emoji) => { input.value += emoji; input.focus(); });
    });
    renderTray();
    input.focus();
  }

  function addFiles(files) {
    for (const f of files) {
      if (pendingFiles.length >= MAX_FILES) { toast(t('chat.maxFilesToast')); break; }
      pendingFiles.push(f);
    }
    renderTray();
  }

  function renderTray() {
    const tray = mainEl.querySelector('#r-tray');
    if (!tray) return;
    tray.innerHTML = pendingFiles.map((f, i) => `
      <div class="upload-item"><div class="upload-chip">
        <div class="file-glyph">${icons.file(22)}<span>${escapeHtml(f.name.slice(0, 14))}</span></div>
        <button class="remove" data-remove="${i}" type="button">${icons.x(12)}</button>
      </div></div>`).join('');
    tray.querySelectorAll('[data-remove]').forEach((btn) => btn.addEventListener('click', () => {
      pendingFiles.splice(Number(btn.dataset.remove), 1);
      renderTray();
    }));
  }

  async function loadMessages() {
    const listEl = mainEl.querySelector('#r-list');
    if (listEl) listEl.innerHTML = `<div class="panel-loading"><div class="spinner"></div></div>`;
    const forChannel = channelId;
    const forThread = thread?.id ?? null;
    try {
      const res = await fetchPage({ limit: 50 });
      if (destroyed || forChannel !== channelId || forThread !== (thread?.id ?? null)) return;
      messages = res.messages;
      hasMore = res.hasMore;
      renderList();
      scrollToBottom();
    } catch (err) {
      if (destroyed || forChannel !== channelId || forThread !== (thread?.id ?? null)) return;
      if (err.status === 404) { thread = null; await load(true); return; }
      if (listEl) listEl.innerHTML = `<div class="empty-state"><p>${escapeHtml(errorText(err, t('remote.couldNotLoadMessages')))}</p></div>`;
    }
  }

  async function loadOlder() {
    if (loadingMore || !hasMore || messages.length === 0) return;
    loadingMore = true;
    const scrollEl = mainEl.querySelector('#r-scroll');
    const prevHeight = scrollEl.scrollHeight;
    const forThread = thread;
    try {
      const res = await fetchPage({ before: messages[0].id, limit: 50 });
      if (destroyed || forThread !== thread) return;
      messages = [...res.messages, ...messages];
      hasMore = res.hasMore;
      renderList();
      scrollEl.scrollTop = scrollEl.scrollHeight - prevHeight;
    } catch (err) {
      toast(errorText(err, t('remote.couldNotLoadMessages')), { type: 'error' });
    } finally {
      loadingMore = false;
    }
  }

  function scrollToBottom() {
    const el = mainEl.querySelector('#r-scroll');
    if (el) el.scrollTop = el.scrollHeight;
  }

  function nearBottom() {
    const el = mainEl.querySelector('#r-scroll');
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }

  function renderList() {
    const listEl = mainEl.querySelector('#r-list');
    if (!listEl) return;
    const liveEditor = listEl.querySelector('#r-edit-input');
    if (liveEditor) editDraft = liveEditor.value;
    if (messages.length === 0) {
      listEl.innerHTML = `<div class="empty-state"><p>${t('remote.emptyChannel')}</p></div>`;
      return;
    }
    listEl.innerHTML = messages.map((m, i) => renderMessage(m, i > 0 ? messages[i - 1] : null)).join('');
    const editor = listEl.querySelector('#r-edit-input');
    if (editor) { editor.focus(); editor.setSelectionRange(editor.value.length, editor.value.length); }
  }

  function renderMessage(m, prev) {
    const continued = prev && prev.author.id === m.author.id && prev.author.domain === m.author.domain
      && new Date(m.createdAt) - new Date(prev.createdAt) < GROUP_GAP_MS;
    const mine = m.author.id === info.selfUserId;
    const crossInstance = m.author.domain !== info.domain;
    return `
      <div class="msg-group ${continued ? 'continued' : ''}" data-id="${m.id}">
        <div class="gutter">${continued ? `<div class="hover-time">${formatShortTime(m.createdAt)}</div>` : avatarHtml({ id: m.author.id, displayName: m.author.displayName, username: m.author.username }, 40)}</div>
        <div class="body">
          ${continued ? '' : `
            <div class="msg-head">
              <span class="author-name">${escapeHtml(m.author.displayName)}</span>
              <span class="timestamp">@${escapeHtml(m.author.username)}${crossInstance ? `<span class="remote-author-domain">@${escapeHtml(m.author.domain)}</span>` : ''}</span>
              <span class="timestamp">${formatTimestamp(m.createdAt)}</span>
            </div>`}
          ${renderBody(m)}
          ${renderReactions(m)}
        </div>
        ${thread ? '' : `<div class="msg-actions">
          <button class="btn-icon" data-action="react" title="${t('remote.reactTitle')}">${icons.smile(16)}</button>
          ${mine ? `<button class="btn-icon" data-action="edit" title="${t('remote.editTitle')}">${icons.edit(16)}</button>
                    <button class="btn-icon danger" data-action="delete" title="${t('remote.deleteTitle')}">${icons.trash(16)}</button>` : ''}
        </div>`}
      </div>`;
  }

  // Every file goes through this instance's authenticated proxy; the owner's URL is never known here.
  function renderAttachments(m) {
    if (!m.attachments?.length) return '';
    return `<div class="attachments">${m.attachments.map((a) => {
      const url = api.remoteAttachmentUrl(peerId, serverId, m.channelId, a.id);
      if (isImageMime(a.mimeType)) {
        return `<a class="attachment-image" href="${escapeHtml(url)}" download="${escapeHtml(a.fileName)}"><img src="${escapeHtml(url)}" alt="${escapeHtml(a.fileName)}" loading="lazy"></a>`;
      }
      return `<a class="attachment-file" href="${escapeHtml(url)}" download="${escapeHtml(a.fileName)}">
        <span class="f-icon">${icons.file(22)}</span>
        <span class="f-meta"><div class="f-name">${escapeHtml(a.fileName)}</div><div class="f-size">${formatBytes(a.sizeBytes)}</div></span>
      </a>`;
    }).join('')}</div>`;
  }

  function renderBody(m) {
    if (editingId === m.id) {
      return `<textarea class="msg-edit-input" id="r-edit-input" rows="2">${escapeHtml(editDraft ?? m.content)}</textarea>
        <div class="msg-edit-hint">${t('remote.editHint')}</div>`;
    }
    if (m.unsupported) return `<div class="msg-line"><em style="color:var(--text-muted)">${t('remote.unsupportedMessage')}</em></div>`;
    const text = m.content.trim() ? `<div class="msg-line">${renderMessageContent(m.content, { remote: true })}${m.editedAt ? `<span class="edited-tag">${t('chat.editedTag')}</span>` : ''}</div>` : '';
    return text + renderAttachments(m);
  }

  function renderReactions(m) {
    if (!m.reactions.length) return '';
    return `<div class="msg-reactions">${m.reactions.map((r) => `
      <button class="reaction-pill ${r.userIds.includes(info.selfUserId) ? 'mine' : ''}" data-reaction="${escapeHtml(r.emoji)}">
        <span>${escapeHtml(r.emoji)}</span><span class="count">${r.userIds.length}</span>
      </button>`).join('')}</div>`;
  }

  function upsertMessage(message) {
    const stick = nearBottom();
    const i = messages.findIndex((x) => x.id === message.id);
    if (i === -1) messages.push(message);
    else messages[i] = message;
    renderList();
    if (stick) scrollToBottom();
  }

  async function send(input) {
    const content = input.value.trim();
    if ((!content && !pendingFiles.length) || sending) return;
    sending = true;
    const files = pendingFiles;
    try {
      const res = await api.sendRemoteMessage(peerId, serverId, channelId, content, files);
      input.value = '';
      if (pendingFiles === files) { pendingFiles = []; renderTray(); }
      upsertMessage(res.message);
      scrollToBottom();
    } catch (err) {
      toast(errorText(err, t('remote.couldNotSend')), { type: 'error' });
    } finally {
      sending = false;
    }
  }

  async function saveEdit(id, content) {
    const original = messages.find((m) => m.id === id);
    editingId = null; editDraft = null;
    if (!content.trim() || (original && original.content === content)) { renderList(); return; }
    try { upsertMessage((await api.editRemoteMessage(peerId, serverId, channelId, id, content)).message); }
    catch (err) { toast(errorText(err, t('remote.couldNotEdit')), { type: 'error' }); renderList(); }
  }

  async function react(id, emoji, add) {
    try {
      const call = add ? api.addRemoteReaction : api.removeRemoteReaction;
      upsertMessage((await call(peerId, serverId, channelId, id, emoji)).message);
    } catch (err) {
      toast(errorText(err, t('remote.couldNotReact')), { type: 'error' });
    }
  }

  function onListKeydown(e) {
    if (e.target.id !== 'r-edit-input' || editingId === null) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const id = editingId; editDraft = null; saveEdit(id, e.target.value); }
    else if (e.key === 'Escape') { editingId = null; editDraft = null; renderList(); }
  }

  function onListClick(e) {
    const group = e.target.closest('.msg-group');
    if (!group || thread) return;
    const id = Number(group.dataset.id);
    const m = messages.find((x) => x.id === id);
    if (!m) return;
    const pill = e.target.closest('[data-reaction]');
    if (pill) { react(id, pill.dataset.reaction, !m.reactions.find((r) => r.emoji === pill.dataset.reaction)?.userIds.includes(info.selfUserId)); return; }
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'react') {
      openEmojiPicker(e.target.closest('[data-action]'), (emoji) => react(id, emoji, true));
    } else if (action === 'edit') {
      editingId = id;
      editDraft = null;
      renderList();
    } else if (action === 'delete') {
      confirmModal({
        title: t('remote.deleteTitle'),
        message: t('remote.deleteConfirm'),
        confirmLabel: t('remote.deleteTitle'),
        async onConfirm() {
          try { await api.deleteRemoteMessage(peerId, serverId, channelId, id); messages = messages.filter((x) => x.id !== id); renderList(); }
          catch (err) { toast(errorText(err, t('remote.couldNotDelete')), { type: 'error' }); }
        },
      });
    }
  }

  offs.push(bus.on('ws:remote_channel_event', (ev) => {
    if (thread || ev.peerId !== peerId || ev.serverId !== serverId || ev.channelId !== channelId || !mainEl.querySelector('#r-list')) return;
    if (ev.kind === 'message_delete') {
      messages = messages.filter((m) => m.id !== ev.messageId);
      renderList();
    } else if (ev.message && editingId !== ev.message.id) {
      upsertMessage(ev.message);
    }
  }));
  offs.push(bus.on('ws:open', () => { if (!destroyed && info && channelId) loadMessages(); }));

  function destroy() {
    destroyed = true;
    offs.forEach((off) => off());
  }
  return { destroy };
}
