import { api } from '../api.js';
import { bus } from '../bus.js';
import { ws } from '../ws.js';
import { icons } from '../icons.js';
import { state, isSelf, getKnownUser, getServerDetail, setReadState, isIgnored, setView } from '../state.js';
import {
  avatarHtml, formatTimestamp, formatShortTime, formatBytes, renderMessageContent,
  isEmojiOnly, isImageMime, isVideoMime, debounce, toast, apiErrorMessage, escapeHtml, refocusInput,
} from '../utils.js';
import { openEmojiPicker } from './emojiPicker.js';
import { notesTargets, saveMessageToNotes } from '../saveToNotes.js';
import { openContextMenu } from './modal.js';
import { EMOJI_SHORTCODES } from '../emojiShortcodes.js';
import { openStickerPicker } from './stickerPicker.js';
import { stickerRef, previewText } from '../stickers.mjs';
import { confirmModal, promptModal, openModal } from './modal.js';
import { MAX_TEXT_FILE_BYTES, textByteLength, textToFile } from '../longText.js';
import { openInviteModal } from './sidebar.js';
import { memberNameColor, memberNameFx } from '../permissions.js';
import { nameAttrs, personalFx } from '../nameStyle.js';
import { memberRoleIcon, roleIconHtml } from '../roleIcon.js';
import { isAgeGateError, renderAgeGate } from '../ageGate.js';
import { usageOf, parseInvocation, missingRequired } from '../slashCommands.js';
import { builtinSlashCommands, SHRUG } from '../builtinSlash.js';
import { t } from '../i18n.js';
import { serverEventText } from '../eventText.js';
import { unreadPrefs, firstUnreadIndex, anchorIndex, unreadEligible, unreadCount } from '../unreadLine.mjs';
import { offlineWindows } from '../offlineTracker.js';
import { uploads } from '../uploadTracker.js';
import { checkUploadFile } from '../uploadGuard.mjs';
import { openScheduleModal } from './scheduled.js';
import { openSoundboardPicker } from './soundboardPicker.js';
import { playSoundboardAudio } from '../soundboardPrefs.js';
import { canRecordVoice, openRecorderBar, voiceMessageHtml, wireVoicePlayers } from '../voiceMessage.js';

const GROUP_WINDOW_MS = 7 * 60 * 1000;
const maxChars = () => state.config.maxMessageChars || 15000;

// Shown as a picker above the composer while typing a command name (Discord's own slash-command
// popup), and doubles as the one place this list needs to stay in sync with handleSlashCommand.
// The list itself lives in builtinSlash.js so the mobile UI shares it.
const slashCommands = () => builtinSlashCommands(!!state.me?.isSiteAdmin);

// Mounts the shared chat pane (message list + composer) for a server channel, a DM, or a thread.
// `scope`: {kind:'channel', serverId, channelId, canSend, canManage, channelType}
//        | {kind:'dm', dmId, canSend:true, canManage:false}
//        | {kind:'thread', serverId, channelId, threadId, canSend, canManage}
// Returns { destroy() } — caller must destroy before mounting a new scope.
export function mountChat(container, scope, { emptyTitle, emptyBody } = {}) {
  let messages = [];
  let loading = false;
  let hasMore = true;
  let hasNewer = false; // loaded window ends before the channel's newest message (after a jump, or after evicting the tail)
  const MAX_LOADED = 300;
  const PAGE_SIZE = 50;
  let uploadFiles = [];
  let editingId = null;
  // A render that replaces the list while an edit box is open (a delete, a reaction, a reconnect
  // catch-up) removes the box without running its cancel/save, which would leave editingId set
  // forever and block every later edit and all live updates. No box in the DOM means no edit.
  function isEditing() {
    if (editingId !== null && !listEl.querySelector('.msg-edit-box')) editingId = null;
    return editingId !== null;
  }
  let replyingTo = null; // the message object being replied to, or null
  let sending = false;
  const typingUsers = new Map(); // userId -> {name, expiresAt}
  let typingTimer = null;

  let wsQueue = Promise.resolve();

  const scopeType = scope.kind === 'dm' ? 'dm' : scope.kind === 'thread' ? 'thread' : 'channel';
  const scopeId = scope.kind === 'dm' ? scope.dmId : scope.kind === 'thread' ? scope.threadId : scope.channelId;

  // Snapshot of the read pointer at open time: the "new messages" line stays put while this pane is
  // open and is gone on the next open, once markRead has advanced the pointer.
  const prefs = unreadPrefs(state.uiPrefs);
  let unreadAfterId = scope.kind === 'thread' || prefs.unreadLine === 'off' ? 0 : (state.readState.get(`${scopeType}:${scopeId}`) || 0);
  let bannerDismissed = false;
  // Only messages already there when the pane opened can get the line; later arrivals are seen live.
  let unreadUpTo = 0;
  let unreadUpToSet = false;
  const offlineAtOpen = offlineWindows();
  const unreadOk = (m) => unreadEligible({ upToId: unreadUpTo, always: prefs.unreadAlways === 'on', windows: offlineAtOpen })(m);

  container.innerHTML = `
    <div class="message-scroll" id="msg-scroll">
      <div class="unread-banner" id="unread-banner" hidden></div>
      <div class="top-spacer"></div>
      <div id="msg-list"></div>
    </div>
    <button type="button" class="jump-latest" id="jump-latest" hidden title="${escapeHtml(t('m.jumpLatest'))}" aria-label="${escapeHtml(t('m.jumpLatest'))}">${icons.chevronDown(18)}</button>
    <div class="typing-indicator" id="typing-indicator"></div>
    <div class="composer-wrap" id="composer-wrap"></div>`;

  const scrollEl = container.querySelector('#msg-scroll');
  const listEl = container.querySelector('#msg-list');
  wireVoicePlayers(listEl);
  const typingEl = container.querySelector('#typing-indicator');
  const composerWrap = container.querySelector('#composer-wrap');
  const unreadBannerEl = container.querySelector('#unread-banner');
  const jumpLatestEl = container.querySelector('#jump-latest');

  // After the initial load the view is pinned to the bottom while images, embeds and fonts settle:
  // each one grows the list and, unpinned, left the view short of the end. Any user scroll gesture lets go.
  let pinBottom = false;
  const releasePin = () => { pinBottom = false; };
  for (const ev of ['wheel', 'touchstart', 'mousedown', 'keydown']) scrollEl.addEventListener(ev, releasePin, { passive: true });
  const pinObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (pinBottom) scrollEl.scrollTop = scrollEl.scrollHeight; }) : null;
  pinObserver?.observe(listEl);
  function pinToBottomBriefly() {
    pinBottom = true;
    setTimeout(releasePin, 4000);
  }
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  function paintJumpLatest() {
    jumpLatestEl.hidden = !hasNewer && isNearBottom();
    jumpLatestEl.style.bottom = `${composerWrap.offsetHeight + typingEl.offsetHeight + 12}px`;
  }
  let viewAnchor = null;
  let wasAtBottom = true;
  function captureViewAnchor() {
    if (!scrollEl.clientHeight) return;
    wasAtBottom = isNearBottom();
    const top = scrollEl.getBoundingClientRect().top;
    const el = [...listEl.querySelectorAll('[data-id]')].find((e) => e.getBoundingClientRect().bottom > top);
    viewAnchor = el ? { id: el.dataset.id, offset: el.getBoundingClientRect().top - top } : null;
  }
  scrollEl.addEventListener('scroll', captureViewAnchor, { passive: true });
  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    if (wasAtBottom) scrollToBottom();
    else if (viewAnchor) {
      const el = [...listEl.querySelectorAll('[data-id]')].find((e) => e.dataset.id === viewAnchor.id);
      if (el) scrollEl.scrollTop += el.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top - viewAnchor.offset;
    }
    paintJumpLatest();
  }) : null;
  resizeObserver?.observe(scrollEl);
  resizeObserver?.observe(composerWrap);
  jumpLatestEl.addEventListener('click', async () => {
    if (hasNewer) await showLatest();
    scrollToBottom();
    pinToBottomBriefly();
    paintJumpLatest();
  });

  function paintUnreadBanner() {
    const at = bannerDismissed ? -1 : firstUnreadIndex(messages, unreadAfterId, (m) => isSelf(m.author.id), unreadOk);
    if (at < 0) { unreadBannerEl.hidden = true; return; }
    const count = unreadCount(messages, unreadAfterId, (m) => isSelf(m.author.id), unreadOk);
    const since = new Date(messages[at].createdAt);
    const sameDay = since.toDateString() === new Date().toDateString();
    const when = since.toLocaleString(undefined, sameDay ? { hour: '2-digit', minute: '2-digit' } : { dateStyle: 'medium', timeStyle: 'short' });
    const label = t('chat.unreadBannerText', { count: hasMore && at === 0 ? `${count}+` : count, since: when });
    unreadBannerEl.hidden = false;
    unreadBannerEl.innerHTML = `<button type="button" class="unread-banner-jump">${escapeHtml(label)}</button><button type="button" class="unread-banner-read">${escapeHtml(t('chat.markAsRead'))} ${icons.check(14)}</button>`;
  }

  unreadBannerEl.addEventListener('click', (e) => {
    if (e.target.closest('.unread-banner-jump')) {
      listEl.querySelector('.unread-divider')?.scrollIntoView({ block: 'start' });
      bannerDismissed = true;
      paintUnreadBanner();
    } else if (e.target.closest('.unread-banner-read')) {
      bannerDismissed = true;
      unreadAfterId = 0;
      if (messages.length) markRead(messages[messages.length - 1].id);
      renderKeepingPosition();
    }
  });

  renderComposer();
  loadInitial();

  loadBotCommands();
  const offEphemeral = bus.on('ws:ephemeral_message', onEphemeral);
  const offCreate = bus.on('ws:message_create', onWsCreate);
  const offUpdate = bus.on('ws:message_update', onWsUpdate);
  const offDelete = bus.on('ws:message_delete', onWsDelete);
  const offTyping = bus.on('ws:typing', onWsTyping);
  const offConnection = bus.on('state:connection', setComposerConnected);
  // Events missed while the socket was down: pull the newest page and fold it in, in place, so the
  // draft, scroll position and open panels survive a reconnect.
  let wsWasClosed = false;
  const offWsClose = bus.on('ws:close', () => { wsWasClosed = true; });
  const offWsOpen = bus.on('ws:open', async () => {
    if (!wsWasClosed) return;
    wsWasClosed = false;
    if (loading || hasNewer) return;
    try {
      const res = await fetchMessages({ limit: prefs.initialMessages });
      const fetched = res.messages;
      const byId = new Map(fetched.map((m) => [m.id, m]));
      const known = new Set(messages.map((m) => m.id));
      messages = messages.map((m) => byId.get(m.id) || m);
      const lastKnown = messages.reduce((mx, m) => Math.max(mx, m.pending ? 0 : m.id), 0);
      const fresh = fetched.filter((m) => !known.has(m.id) && m.id > lastKnown);
      const nearBottom = isNearBottom();
      messages = messages.concat(fresh);
      if (!isEditing()) { renderKeepingPosition(); if (nearBottom) scrollToBottom(); }
      if (fresh.length) markRead(fresh[fresh.length - 1].id);
    } catch { /* the next event or reload catches up */ }
  });
  // A profile edit (name/avatar) updates already-rendered messages in place, so scroll position and
  // a half-typed draft are never disturbed by a re-render.
  const offProfile = bus.on('state:presence', (u) => {
    if (!u?.id) return;
    const fields = { displayName: u.displayName, avatarPath: u.avatarPath, avatarBackground: u.avatarBackground, avatarBgColor: u.avatarBgColor };
    for (const msg of messages) if (msg.author?.id === u.id) msg.author = { ...msg.author, ...fields };
    scrollEl.querySelectorAll(`.msg-group[data-author="${u.id}"]`).forEach((g) => {
      const av = g.querySelector('.gutter > .avatar');
      if (av) av.outerHTML = avatarHtml({ ...u }, 40);
      const nameEl = g.querySelector('.author-name');
      if (nameEl) nameEl.textContent = u.displayName;
    });
  });
  // Only matters for a DM: the other member's read pointer moving is what drives the "Seen" tag.
  const offDms = scope.kind === 'dm' ? bus.on('state:dms', () => {
    if (!isEditing()) renderAll();
  }) : null;
  setComposerConnected(state.wsConnected);
  const onScroll = debounce(checkEdges, 150);
  scrollEl.addEventListener('scroll', onScroll);
  scrollEl.addEventListener('scroll', paintJumpLatest, { passive: true });

  listEl.addEventListener('click', onListClick);
  listEl.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.channel-ref')) { e.preventDefault(); e.target.click(); }
  });
  listEl.addEventListener('contextmenu', onListContextMenu);

  function fetchMessages(opts) {
    if (scope.kind === 'dm') return api.listDmMessages(scope.dmId, opts);
    if (scope.kind === 'thread') return api.listThreadMessages(scope.serverId, scope.channelId, scope.threadId, opts);
    return api.listChannelMessages(scope.serverId, scope.channelId, opts);
  }

  async function loadInitial() {
    loading = true;
    listEl.innerHTML = `<div class="panel-loading"><div class="spinner"></div></div>`;
    const jumpId = scope.jumpToMessageId;
    try {
      const res = await fetchMessages(jumpId ? { around: jumpId } : { limit: prefs.initialMessages });
      const fetched = res.messages;
      const lastFetchedId = res.messages.reduce((mx, m) => Math.max(mx, m.id), 0);
      if (!unreadUpToSet) { unreadUpTo = lastFetchedId; unreadUpToSet = true; }
      const fetchedIds = new Set(res.messages.map((m) => m.id));
      const arrived = jumpId ? [] : messages.filter((m) => !fetchedIds.has(m.id) && m.id > lastFetchedId);
      messages = fetched.concat(arrived, jumpId ? [] : uploads.forScope(myUploadScope).filter((u) => !messages.includes(u)));
      // An "around" page doesn't say how much lies beyond either edge, so assume both and let the
      // first edge fetch correct it (a short page clears the flag).
      hasMore = jumpId ? true : res.messages.length >= prefs.initialMessages;
      hasNewer = !!jumpId;
      renderAll();
      if (jumpId) {
        highlightMessage(jumpId);
        requestAnimationFrame(checkEdges);
      } else {
        const unreadAt = prefs.unreadJump === 'firstUnread' ? firstUnreadIndex(messages, unreadAfterId, (m) => isSelf(m.author.id), unreadOk) : -1;
        if (unreadAt >= 0) {
          const anchorAt = anchorIndex(unreadAt, prefs.unreadContext);
          const anchor = anchorAt === unreadAt ? listEl.querySelector('.unread-divider') : listEl.querySelector(`[data-id="${messages[anchorAt].id}"]`);
          (anchor || listEl.lastElementChild)?.scrollIntoView({ block: 'start' });
        } else { scrollToBottom(); pinToBottomBriefly(); }
        paintJumpLatest();
        // Short backlog: everything is already (nearly) on screen, so the unread line has been "reached".
        requestAnimationFrame(() => {
          if (isNearBottom() && !hasNewer && listEl.querySelector('.unread-divider')) {
            bannerDismissed = true; unreadAfterId = 0; renderKeepingPosition();
          }
        });
        if (messages.length) markRead(messages[messages.length - 1].id);
      }
    } catch (err) {
      if (isAgeGateError(err)) {
        composerWrap.style.display = 'none';
        renderAgeGate(listEl, {
          channelName: (scope.channels || []).find((c) => c.id === scope.channelId)?.name,
          onConfirmed: () => { composerWrap.style.display = ''; loadInitial(); },
          onLeave: () => setView({ type: 'home' }),
        });
      } else {
        listEl.innerHTML = `<div class="empty-state"><p>${escapeHtml(apiErrorMessage(err, t('chat.couldNotLoadMessagesError')))}</p></div>`;
      }
    } finally {
      loading = false;
    }
  }

  function highlightMessage(id) {
    const el = listEl.querySelector(`[data-id="${id}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.classList.add('msg-jump-highlight');
    setTimeout(() => el.classList.remove('msg-jump-highlight'), 2000);
  }

  function checkEdges() {
    if (scrollEl.scrollTop < 80) maybeLoadMore();
    else if (isNearBottom()) {
      maybeLoadNewer();
      if (!hasNewer && !loading && listEl.querySelector('.unread-divider')) { bannerDismissed = true; unreadAfterId = 0; renderKeepingPosition(); }
    }
  }

  // Re-renders while keeping the first message visible at the top of the viewport where it was,
  // so prepending, appending and evicting never shift what the user is reading.
  function renderKeepingPosition() {
    const top = scrollEl.getBoundingClientRect().top;
    const anchor = [...listEl.querySelectorAll('[data-id]')].find((el) => el.getBoundingClientRect().bottom > top);
    const anchorId = anchor?.dataset.id;
    const offset = anchor ? anchor.getBoundingClientRect().top - top : 0;
    renderAll();
    const next = anchorId && [...listEl.querySelectorAll('[data-id]')].find((el) => el.dataset.id === anchorId);
    if (next) scrollEl.scrollTop += next.getBoundingClientRect().top - top - offset;
  }

  function hasPending() {
    return messages.some((m) => m.pending || m.errored);
  }

  async function maybeLoadMore() {
    if (loading || !hasMore || messages.length === 0) return;
    loading = true;
    const before = messages[0].id;
    try {
      const res = await fetchMessages({ before, limit: PAGE_SIZE });
      if (res.messages.length < PAGE_SIZE) hasMore = false;
      const have = new Set(messages.map((m) => m.id));
      messages = [...res.messages.filter((m) => !have.has(m.id)), ...messages];
      if (messages.length > MAX_LOADED && !hasPending()) {
        messages = messages.slice(0, MAX_LOADED);
        hasNewer = true;
      }
      renderKeepingPosition();
    } catch {
      /* silent: pagination isn't critical path */
    } finally {
      loading = false;
    }
  }

  async function maybeLoadNewer() {
    if (loading || !hasNewer || messages.length === 0) return;
    loading = true;
    const after = messages[messages.length - 1].id;
    try {
      const res = await fetchMessages({ after, limit: PAGE_SIZE });
      if (res.messages.length < PAGE_SIZE) hasNewer = false;
      const have = new Set(messages.map((m) => m.id));
      const fresh = res.messages.filter((m) => !have.has(m.id));
      if (!fresh.length) hasNewer = false; // server ignored `after` (federated scope) or nothing newer: don't loop
      messages = [...messages, ...fresh];
      if (messages.length > MAX_LOADED) {
        messages = messages.slice(messages.length - MAX_LOADED);
        hasMore = true;
      }
      if (fresh.length) renderKeepingPosition();
      if (!hasNewer && messages.length) markRead(messages[messages.length - 1].id);
    } catch {
      /* silent: pagination isn't critical path */
    } finally {
      loading = false;
    }
  }

  async function showLatest() {
    scope.jumpToMessageId = null;
    await loadInitial();
  }

  // Marking read follows "this scope is open" rather than window focus — matches how the rest
  // of the app already opens a conversation (no separate "acknowledge" step).
  async function markRead(messageId) {
    try {
      await api.markRead(scopeType, scopeId, messageId);
      setReadState(scopeType, scopeId, messageId);
    } catch { /* best-effort — an unread badge lingering a bit longer isn't worth surfacing */ }
  }

  function isNearBottom() {
    return scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 120;
  }

  function scrollToBottom() {
    scrollEl.scrollTop = scrollEl.scrollHeight;
  }

  function renderAll() {
    paintUnreadBanner();
    if (messages.length === 0) {
      listEl.innerHTML = `
        <div class="channel-intro">
          <div class="intro-icon">${icons.hash(34)}</div>
          <h2>${escapeHtml(emptyTitle || t('chat.defaultEmptyTitle'))}</h2>
          <p>${escapeHtml(emptyBody || t('chat.defaultEmptyBody'))}</p>
        </div>`;
      return;
    }
    let html = '';
    let prev = null;
    // The thread's own opening message reads as a pinned "main post" (per the inline thread
    // view in shell.js) rather than just the first reply — but only once we've actually scrolled
    // back to it (hasMore false); otherwise a still-partially-loaded older page would wrongly
    // flag whatever happens to be message #1 of the currently-loaded page.
    const opId = scope.kind === 'thread' && !hasMore ? messages[0]?.id : null;
    const dividerId = messages[firstUnreadIndex(messages, unreadAfterId, (m) => isSelf(m.author.id), unreadOk)]?.id;
    for (const m of messages) {
      const isDivider = m.id === dividerId;
      if (isDivider) {
        const day = new Date(m.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
        html += `<div class="unread-divider"><span class="unread-divider-date">${escapeHtml(day)}</span><span class="unread-divider-badge">${escapeHtml(t('chat.newMessagesBadge'))}</span></div>`;
      }
      const continued = !isDivider && prev && !prev.eventType && !m.eventType && !m.replyTo && prev.author.id === m.author.id && !prev.pending && !m.pending
        && (new Date(m.createdAt) - new Date(prev.createdAt)) < GROUP_WINDOW_MS;
      html += renderGroup(m, continued, m.id === opId);
      prev = m;
    }
    for (const e of ephemerals) html += renderEphemeral(e);
    html += renderSeenTag();
    listEl.innerHTML = html;
  }

  // 1:1 DMs get a plain "Seen" text tag (matches real Discord's own DM read-state UI); group DMs
  // get a small stack of reader avatars instead — real Discord doesn't have group read receipts
  // at all, but the same per-member read_state rows already needed for unread badges make it
  // cheap to show here, and it's genuinely useful in a small self-hosted group.
  function renderSeenTag() {
    if (scope.kind !== 'dm') return '';
    const dm = state.dms.find((d) => d.id === scope.dmId);
    if (!dm) return '';
    const lastMine = [...messages].reverse().find((m) => !m.eventType && !m.pending && isSelf(m.author.id));
    if (!lastMine) return '';
    const readStates = dm.readStates || [];

    if (!dm.isGroup) {
      const other = readStates[0];
      if (!other || other.lastReadMessageId < lastMine.id) return '';
      return `<div class="dm-seen-tag">${t('chat.seenTag')}</div>`;
    }

    const readers = readStates
      .filter((r) => r.lastReadMessageId >= lastMine.id)
      .map((r) => dm.members.find((m) => m.id === r.userId))
      .filter(Boolean);
    if (readers.length === 0) return '';
    return `<div class="dm-seen-tag dm-seen-avatars" title="${escapeHtml(t('chat.seenByTitle', { names: readers.map((u) => u.displayName).join(', ') }))}">
      ${readers.map((u) => avatarHtml(u, 16)).join('')}
      <span>${readers.length === 1 ? t('chat.seenBySingle', { name: escapeHtml(readers[0].displayName) }) : t('chat.seenByMultiple', { count: readers.length })}</span>
    </div>`;
  }

  const EVENT_ICON = { member_join: icons.userPlus || icons.users, member_leave: icons.users, member_kick: icons.users, member_ban: icons.ban, member_unban: icons.userPlus || icons.users, category_create: icons.hash, category_rename: icons.edit, category_delete: icons.trash, member_greeting: icons.star, member_timeout: icons.clock, member_timeout_clear: icons.clock, member_role_add: icons.shield, member_role_remove: icons.shield, role_create: icons.shield, role_delete: icons.shield, channel_create: icons.hash, channel_rename: icons.edit, channel_topic: icons.edit, channel_delete: icons.trash, server_rename: icons.flag };

  // Per-member override beats their highest colored role - see permissions.js's memberNameColor.
  // Only meaningful for channel/thread scopes (DMs have no server roles/members to look up).
  function authorColor(authorId, author) {
    if (!scope.serverId) return scope.kind === 'dm' ? (author?.nameColor || null) : null; // DMs: anyone's own colour, no roles to outrank it
    const detail = getServerDetail(scope.serverId);
    if (!detail) return null;
    const member = detail.members.find((x) => x.user.id === authorId);
    return memberNameColor(detail.roles, member);
  }

  // Color + personal effect for a name: a role/moderator color hides the effect, DMs use the person's own look.
  function authorFx(authorId, author) {
    if (!scope.serverId) return scope.kind === 'dm' ? personalFx(author) : {};
    const detail = getServerDetail(scope.serverId);
    const member = detail?.members.find((x) => x.user.id === authorId);
    return detail && member ? memberNameFx(detail.roles, member) : {};
  }

  function authorRoleIcon(authorId) {
    if (!scope.serverId) return '';
    const detail = getServerDetail(scope.serverId);
    if (!detail) return '';
    return roleIconHtml(memberRoleIcon(detail.roles, detail.members.find((x) => x.user.id === authorId)));
  }

  const revealedIgnored = new Set();

  function renderGroup(m, continued, isThreadOp = false) {
    if (m.eventType) {
      const logText = (() => { const s = serverEventText(m); return s ? escapeHtml(s) : renderMessageContent(m.content); })();
      return `
      <div class="msg-system" data-id="${m.id}">
        <span class="msg-system-icon">${(EVENT_ICON[m.eventType] || icons.users)(14)}</span>
        <span class="msg-system-text">${logText}</span>
        <span class="msg-system-time">${formatShortTime(m.createdAt)}</span>
      </div>`;
    }

    // Messages from someone the viewer ignores collapse to a one-line stub they can click open.
    if (!isSelf(m.author.id) && isIgnored(m.author.id) && !revealedIgnored.has(m.id)) {
      return `<div class="msg-ignored" data-reveal-ignored="${m.id}">${escapeHtml(t('msgMenu.ignoredMessage'))}</div>`;
    }

    const canEdit = isSelf(m.author.id);
    const canDelete = isSelf(m.author.id) || scope.canManage;
    const canPinHere = scope.kind === 'dm' || scope.canManage;

    return `
      <div class="msg-group ${continued ? 'continued' : ''} ${m.pending ? 'pending' : ''} ${m.errored ? 'errored' : ''} ${isThreadOp ? 'thread-op' : ''}" data-id="${m.id}" data-author="${m.author.id}">
        ${isThreadOp ? `<div class="thread-op-label">${icons.messageSquare(12)} ${t('chat.mainPostLabel')}</div>` : ''}
        <div class="gutter">
          ${continued
            ? `<div class="hover-time">${formatShortTime(m.createdAt)}</div>`
            : avatarHtml(m.author, 40)}
        </div>
        <div class="body">
          ${continued ? '' : `
            ${m.replyTo ? renderReplyPreview(m.replyTo) : ''}
            ${m.interaction ? `<div class="interaction-line">${icons.messageSquare(12)} ${t('slash.usedCommand', { user: escapeHtml(m.interaction.user?.displayName || '?'), command: escapeHtml(m.interaction.command) })}</div>` : ''}
            <div class="msg-head">
              <span data-user="${m.author.id}"${nameAttrs(authorFx(m.author.id, m.author), 'author-name')}>${escapeHtml(m.author.displayName)}</span>${authorRoleIcon(m.author.id)}${m.author.isBot ? `<span class="bot-badge">${t('bots.badge')}</span>` : ''}
              <span class="timestamp">${formatTimestamp(m.createdAt)}</span>
            </div>`}
          ${renderMessageBody(m)}
          ${renderReactions(m)}
        </div>
        ${!m.pending ? `
          <div class="msg-actions">
            ${scope.canSend ? `<button class="btn-icon" data-action="reply" title="${t('chat.replyActionTitle')}">${icons.reply(16)}</button>` : ''}
            <button class="btn-icon" data-action="emoji-react" title="${t('chat.reactActionTitle')}">${icons.smile(16)}</button>
            ${scope.kind === 'channel' && scope.canSend ? `<button class="btn-icon" data-action="create-thread" title="${t('chat.createThreadActionTitle')}">${icons.messageSquare(16)}</button>` : ''}
            ${canPinHere ? `<button class="btn-icon ${m.pinnedAt ? 'active' : ''}" data-action="pin" title="${m.pinnedAt ? t('chat.unpinMessageTitle') : t('chat.pinMessageTitle')}">${icons.pin(16)}</button>` : ''}
            <button class="btn-icon" data-action="forward" title="${t('chat.forwardActionTitle')}">${icons.forward(16)}</button>
            ${canEdit ? `<button class="btn-icon" data-action="edit" title="${t('events.editTitle')}">${icons.edit(16)}</button>` : ''}
            ${canDelete ? `<button class="btn-icon danger" data-action="delete" title="${t('admin.deleteButton')}">${icons.trash(16)}</button>` : ''}
          </div>` : ''}
      </div>`;
  }

  function renderMessageBody(m) {
    const parts = [];
    if (m.forwardedFrom) {
      parts.push(`<div class="forwarded-tag">${icons.forward(12)} ${t('chat.forwardedMessageTag')}</div>`);
      parts.push(`<div class="reply-preview" data-reply-jump="${m.forwardedFrom.id}" data-forward-origin="${m.forwardedFrom.origin ? escapeHtml(JSON.stringify(m.forwardedFrom.origin)) : ''}">
        <span class="rp-name">${escapeHtml(m.forwardedFrom.author.displayName)}</span>
        <span class="rp-snippet">${escapeHtml((m.forwardedFrom.content || (m.forwardedFrom.sticker ? t('chat.stickerFallback') : t('chat.noTextFallback'))).replace(/\s+/g, ' ').slice(0, 150))}</span>
      </div>`);
    }
    if (m.content) {
      const emojiOnly = isEmojiOnly(m.content, scope.customEmoji) && !m.poll;
      parts.push(`<div class="msg-line ${emojiOnly ? 'msg-emoji-only' : ''}">${renderMessageContent(m.content, { channels: scope.channels, customEmoji: scope.customEmoji, rawHtmlEnabled: scope.rawHtmlEnabled })}${m.editedAt ? `<span class="edited-tag">${t('chat.editedTag')}</span>` : ''}</div>`);
    }
    if (m.sticker) parts.push(`<img class="sticker-message anim-limit" src="${escapeHtml(m.sticker.imagePath)}" alt="${escapeHtml(m.sticker.name)}" title="${escapeHtml(m.sticker.name)}">`);
    if (m.sound) parts.push(`<div class="sound-message"><button type="button" class="btn sound-play" data-sound-src="${escapeHtml(m.sound.audioPath)}" title="${escapeHtml(m.sound.name)}">${icons.music(18)} ${m.sound.emoji ? `${escapeHtml(m.sound.emoji)} ` : ''}${escapeHtml(m.sound.name)}</button></div>`);
    if (m.poll) parts.push(renderPoll(m));
    if (m.attachments && m.attachments.length) {
      parts.push(`<div class="attachments">${m.attachments.map(renderAttachment).join('')}</div>`);
    }
    if (m.embed) {
      parts.push(renderEmbed(m.embed));
    }
    if (m.pending && m.uploadProgress !== undefined && m.uploadProgress < 1) {
      parts.push(`<div class="upload-progress"><div class="up-bar"><i style="width:${Math.round(m.uploadProgress * 100)}%"></i></div><div class="msg-edit-hint"><span class="up-pct">${t('chat.uploadingProgress', { pct: Math.round(m.uploadProgress * 100) })}</span> <span class="link-btn" data-action="cancel-upload">${t('chat.cancelUpload')}</span></div></div>`);
    }
    if (m.errored) {
      parts.push(`<div class="msg-edit-hint" style="color:var(--danger)">${t('chat.failedToSend')}<span class="link-btn" data-action="retry">${t('chat.clickToRetry')}</span></div>`);
    }
    return parts.join('');
  }

  function renderReplyPreview(replyTo) {
    const snippet = replyTo.content ? replyTo.content.replace(/\s+/g, ' ').slice(0, 100) : replyTo.sticker ? t('chat.stickerFallback') : t('chat.noTextFallback');
    return `<div class="reply-preview" data-reply-jump="${replyTo.id}">
      ${icons.reply(12)}
      <span class="rp-name">${escapeHtml(replyTo.author?.displayName || t('chat.unknownUserFallback'))}</span>
      <span class="rp-snippet">${escapeHtml(snippet)}</span>
    </div>`;
  }

  function reactionGlyphHtml(emoji) {
    const m = /^:([a-zA-Z0-9_]{2,32}):$/.exec(emoji);
    const custom = m && (scope.customEmoji || []).find((e) => e.name.toLowerCase() === m[1].toLowerCase());
    return custom
      ? `<img class="custom-emoji" src="${escapeHtml(custom.image_path)}" alt="${escapeHtml(emoji)}">`
      : `<span>${escapeHtml(emoji)}</span>`;
  }

  function renderReactions(m) {
    if (!m.reactions || m.reactions.length === 0) return '';
    return `<div class="msg-reactions">${m.reactions.map((r) => {
      const mine = r.userIds.includes(state.me.id);
      return `<button class="reaction-pill ${mine ? 'mine' : ''}" data-reaction="${escapeHtml(r.emoji)}" title="${escapeHtml(t('chat.reactedTitle', { count: r.userIds.length }))}">
        ${reactionGlyphHtml(r.emoji)}<span class="count">${r.userIds.length}</span>
      </button>`;
    }).join('')}</div>`;
  }

  function renderEmbed(embed) {
    let host = '';
    try { host = new URL(embed.url).hostname; } catch { host = ''; }
    return `<a class="link-embed" href="${escapeHtml(embed.url)}" target="_blank" rel="noopener noreferrer">
      <div class="link-embed-body">
        <div class="link-embed-site">${escapeHtml(embed.siteName || host)}</div>
        ${embed.title ? `<div class="link-embed-title">${escapeHtml(embed.title)}</div>` : ''}
        ${embed.description ? `<div class="link-embed-desc">${escapeHtml(embed.description)}</div>` : ''}
      </div>
      ${embed.image ? `<img class="link-embed-image" src="/api/link-preview/image?url=${encodeURIComponent(embed.image)}" alt="" loading="lazy">` : ''}
    </a>`;
  }

  function renderPoll(m) {
    const totalVoters = m.poll.totalVoters || 0;
    const myVotes = new Set();
    for (const o of m.poll.options) if (o.voterIds.includes(state.me.id)) myVotes.add(o.id);
    return `<div class="poll-card">
      ${m.poll.options.map((o) => {
        const count = o.voterIds.length;
        const pct = totalVoters ? Math.round((count / totalVoters) * 100) : 0;
        const mine = myVotes.has(o.id);
        return `<button type="button" class="poll-option ${mine ? 'mine' : ''}" data-poll-vote="${o.id}">
          <div class="poll-option-fill" style="width:${pct}%"></div>
          <span class="poll-option-label">${mine ? icons.check(14) : ''} ${escapeHtml(o.label)}</span>
          <span class="poll-option-pct">${count} · ${pct}%</span>
        </button>`;
      }).join('')}
      <div class="poll-footer">${totalVoters} ${totalVoters === 1 ? t('chat.voteSingular') : t('chat.votePlural')}${m.poll.multiSelect ? t('chat.multipleChoiceSuffix') : ''}</div>
    </div>`;
  }

  function renderAttachment(a) {
    if (isImageMime(a.mimeType)) {
      const isGif = /^image\/gif$/i.test(a.mimeType || '');
      // GIFs get a play/pause overlay - <img> has no native pause, so toggling freezes the
      // current frame via a canvas snapshot swapped in as the src, and un-freezing restores the
      // original animated src (restarting playback from frame 0, since we can't resume mid-GIF).
      const gifToggle = isGif
        ? `<button type="button" class="gif-toggle" data-action="gif-toggle" title="${t('chat.pauseGifTitle')}">${icons.pause(14)}</button>`
        : '';
      return `<div class="attachment-image" data-action="lightbox" data-url="${escapeHtml(a.url)}" data-name="${escapeHtml(a.fileName)}">
        <img src="${escapeHtml(a.url)}" data-original-src="${escapeHtml(a.url)}" alt="${escapeHtml(a.fileName)}" loading="lazy">
        ${gifToggle}
      </div>`;
    }
    if (a.voiceMs && (a.mimeType || '').startsWith('audio/')) return voiceMessageHtml(a);
    if ((a.mimeType || '').startsWith('audio/')) return `<div class="attachment-audio"><audio src="${escapeHtml(a.url)}" controls preload="none"></audio></div>`;
    if (isVideoMime(a.mimeType)) {
      // Native <video controls> — plays inline directly from this instance's own /uploads (no
      // third-party embed/player), and its built-in fullscreen button already covers "large view".
      return `<div class="attachment-video"><video src="${escapeHtml(a.url)}" poster="${escapeHtml(a.url)}.poster.jpg" controls preload="none"></video></div>`;
    }
    // `download` (not target="_blank") so this is a same-window download, not a window-open - in
    // the Electron client, a target="_blank" link gets intercepted by main.js's
    // setWindowOpenHandler and forced out to the system browser instead of downloading in-app.
    return `<a class="attachment-file" href="${escapeHtml(a.url)}" download="${escapeHtml(a.fileName)}">
      <span class="f-icon">${icons.file(22)}</span>
      <span class="f-meta"><div class="f-name">${escapeHtml(a.fileName)}</div><div class="f-size">${formatBytes(a.sizeBytes)}</div></span>
    </a>`;
  }

  function toggleGifPlayback(btn) {
    const img = btn.closest('.attachment-image')?.querySelector('img');
    if (!img) return;
    if (img.dataset.paused === '1') {
      img.src = img.dataset.originalSrc; // restarts playback from frame 0 - no way to resume mid-GIF
      img.dataset.paused = '';
      btn.innerHTML = icons.pause(14);
      btn.title = t('chat.pauseGifTitle');
      return;
    }
    try {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);
      img.src = canvas.toDataURL('image/png');
      img.dataset.paused = '1';
      btn.innerHTML = icons.play(14);
      btn.title = t('chat.playGifTitle');
    } catch { /* same-origin upload, canvas snapshot should never throw - no-op if it somehow does */ }
  }

  function onListClick(e) {
    const soundBtn = e.target.closest('[data-sound-src]');
    if (soundBtn) {
      playSoundboardAudio(soundBtn.dataset.soundSrc);
      return;
    }

    const ignoredStub = e.target.closest('[data-reveal-ignored]');
    if (ignoredStub) {
      revealedIgnored.add(Number(ignoredStub.dataset.revealIgnored));
      return renderAll();
    }

    const dismissTarget = e.target.closest('[data-ephemeral-dismiss]');
    if (dismissTarget) {
      e.preventDefault();
      const at = ephemerals.findIndex((x) => x.id === dismissTarget.dataset.ephemeralDismiss);
      if (at !== -1) { ephemerals.splice(at, 1); renderAll(); }
      return;
    }

    const spoilerTarget = e.target.closest('[data-action="spoiler"]');
    if (spoilerTarget) return spoilerTarget.classList.toggle('revealed');

    const gifToggleTarget = e.target.closest('[data-action="gif-toggle"]');
    if (gifToggleTarget) return toggleGifPlayback(gifToggleTarget);

    const lightboxTarget = e.target.closest('[data-action="lightbox"]');
    if (lightboxTarget) return openLightbox(lightboxTarget.dataset.url, lightboxTarget.dataset.name);

    const replyJumpTarget = e.target.closest('[data-reply-jump]');
    if (replyJumpTarget) {
      const id = Number(replyJumpTarget.dataset.replyJump);
      const raw = replyJumpTarget.dataset.forwardOrigin;
      if (raw === undefined) return highlightMessage(id);
      let o = null;
      try { o = raw ? JSON.parse(raw) : null; } catch { /* no usable origin */ }
      if (!o) return highlightMessage(id);
      if (o.scopeType === 'dm') return o.dmId === scope.dmId ? highlightMessage(id) : bus.emit('ui:navigate', { type: 'dm', dmId: o.dmId, jumpToMessageId: id });
      const here = scope.kind === 'thread' ? o.threadId === scope.threadId : (scope.kind === 'channel' && !o.threadId && o.channelId === scope.channelId);
      if (here && listEl.querySelector(`[data-id="${id}"]`)) return highlightMessage(id);
      return bus.emit('ui:navigate', { type: 'server', serverId: o.serverId, channelId: o.channelId, ...(o.threadId ? { threadId: o.threadId } : {}), jumpToMessageId: id });
    }

    const userTarget = e.target.closest('[data-user]');
    if (userTarget) return bus.emit('ui:openProfile', { userId: Number(userTarget.dataset.user), serverId: scope.serverId, anchor: userTarget });

    const channelRefTarget = e.target.closest('.channel-ref[data-channel-id]');
    if (channelRefTarget) return bus.emit('ui:navigate', { type: 'server', serverId: scope.serverId, channelId: Number(channelRefTarget.dataset.channelId) });

    const groupEl = e.target.closest('.msg-group');
    if (!groupEl) return;
    const id = groupEl.dataset.id;
    const msg = messages.find((m) => String(m.id) === id);
    if (!msg) return;

    const reactionPill = e.target.closest('[data-reaction]');
    if (reactionPill) return toggleReaction(msg, reactionPill.dataset.reaction);

    const pollOptTarget = e.target.closest('[data-poll-vote]');
    if (pollOptTarget) return msg.poll && votePoll(msg, Number(pollOptTarget.dataset.pollVote));

    const actionBtn = e.target.closest('[data-action]');
    if (!actionBtn) return;
    const action = actionBtn.dataset.action;
    if (action === 'edit') startEdit(msg, groupEl);
    else if (action === 'delete') doDelete(msg);
    else if (action === 'retry') retrySend(msg);
    else if (action === 'cancel-upload') uploads.abort(msg.key);
    else if (action === 'emoji-react') openReactionPicker(actionBtn, msg);
    else if (action === 'create-thread') openCreateThreadPrompt(msg);
    else if (action === 'reply') startReply(msg);
    else if (action === 'pin') togglePin(msg);
    else if (action === 'forward') openForwardModal(msg);
    else if (action === 'report') openMessageReportModal(msg);
  }

  const QUICK_REACTIONS = ['\u{1F44D}', '\u{2764}\u{FE0F}', '\u{1F62D}', '\u{1F64F}'];
  const REMINDERS = [['remind5m', 5], ['remind1h', 60], ['remind3h', 180], ['remind24h', 1440], ['remind3d', 4320]];

  function messageLink(msg) {
    const base = `${location.origin}/#msg=`;
    if (scope.kind === 'dm') return `${base}dm:${scope.dmId}:${msg.id}`;
    if (scope.kind === 'thread') return `${base}thread:${scope.serverId}:${scope.channelId}:${scope.threadId}:${msg.id}`;
    return `${base}channel:${scope.serverId}:${scope.channelId}:${msg.id}`;
  }

  async function copyToClipboard(text, doneKey) {
    try { await navigator.clipboard.writeText(text); toast(t(doneKey)); } catch { toast(t('sidebar.couldNotCopyManual')); }
  }

  function toggleBookmark(msg) {
    const saved = state.bookmarkIds.has(msg.id);
    (saved ? api.removeBookmark(msg.id) : api.addBookmark(msg.id)).then(() => {
      if (saved) state.bookmarkIds.delete(msg.id); else state.bookmarkIds.add(msg.id);
      bus.emit('state:bookmarks');
      toast(t(saved ? 'msgMenu.bookmarkRemovedToast' : 'msgMenu.bookmarkAddedToast'));
    }).catch((err) => toast(apiErrorMessage(err, t('msgMenu.couldNotBookmark')), { type: 'error' }));
  }

  function saveToNotesItems(msg) {
    const targets = notesTargets();
    if (!targets.length) return [];
    if (targets.length === 1) return [{ label: t('msgMenu.saveToNotes'), onClick: () => saveMessageToNotes(msg, scope, targets[0]) }];
    return [{ label: t('msgMenu.saveToNotes'), submenu: targets.map((tg) => ({ label: `${tg.serverName} · ${tg.channelName}`, onClick: () => saveMessageToNotes(msg, scope, tg) })) }];
  }

  function remindMe(msg, minutes) {
    api.createReminder(msg.id, minutes).then(() => toast(t('msgMenu.reminderSetToast')))
      .catch((err) => toast(apiErrorMessage(err, t('msgMenu.couldNotRemind')), { type: 'error' }));
  }

  function readAloud(text) {
    if (typeof speechSynthesis === 'undefined') return toast(t('msgMenu.readAloudUnsupported'), { type: 'error' });
    speechSynthesis.cancel();
    speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  }

  function onListContextMenu(e) {
    if (e.target.closest('input, textarea, [contenteditable="true"], .msg-edit-box')) return;
    const systemEl = e.target.closest('.msg-system');
    if (systemEl && scope.kind === 'channel' && scope.canManage) {
      const entry = messages.find((m) => String(m.id) === systemEl.dataset.id);
      if (!entry || !entry.eventType) return;
      e.preventDefault();
      openContextMenu(e.clientX, e.clientY, [{ label: t('serverLog.deleteEntryTitle'), danger: true, onClick: () => doDelete(entry) }]);
      return;
    }
    const groupEl = e.target.closest('.msg-group');
    if (!groupEl) return;
    const msg = messages.find((m) => String(m.id) === groupEl.dataset.id);
    if (!msg || msg.pending || msg.errored || msg.eventType) return;
    e.preventDefault();

    const mine = isSelf(msg.author.id);
    const text = msg.content || '';
    // The custom menu replaces the browser's own, so a highlighted passage has to be picked up here.
    const sel = window.getSelection?.();
    const selected = sel && !sel.isCollapsed && groupEl.contains(sel.anchorNode) && groupEl.contains(sel.focusNode) ? sel.toString().trim() : '';
    const items = [
      { emojiRow: QUICK_REACTIONS, onPick: (emoji) => toggleReaction(msg, emoji) },
      { label: t('msgMenu.addReaction'), onClick: () => openReactionPicker(groupEl.querySelector('.body') || groupEl, msg) },
      'sep',
      ...(scope.canSend ? [{ label: t('chat.replyActionTitle'), onClick: () => startReply(msg) }] : []),
      { label: t('chat.forwardActionTitle'), onClick: () => openForwardModal(msg) },
      ...(scope.kind === 'channel' && scope.canSend ? [{ label: t('chat.createThreadActionTitle'), onClick: () => openCreateThreadPrompt(msg) }] : []),
      'sep',
      ...(selected ? [{ label: t('msgMenu.copySelection'), onClick: () => copyToClipboard(selected, 'msgMenu.textCopiedToast') }] : []),
      ...(text ? [{ label: t('msgMenu.copyText'), onClick: () => copyToClipboard(text, 'msgMenu.textCopiedToast') }] : []),
      { label: state.bookmarkIds.has(msg.id) ? t('msgMenu.removeBookmark') : t('msgMenu.bookmark'), onClick: () => toggleBookmark(msg) },
      ...saveToNotesItems(msg),
      { label: t('msgMenu.remindMe'), submenu: REMINDERS.map(([key, minutes]) => ({ label: t(`msgMenu.${key}`), onClick: () => remindMe(msg, minutes) })) },
      { label: t('msgMenu.copyLink'), onClick: () => copyToClipboard(messageLink(msg), 'msgMenu.linkCopiedToast') },
      ...(text ? [{ label: t('msgMenu.readAloud'), onClick: () => readAloud(text) }] : []),
      ...((scope.kind === 'dm' || scope.canManage) ? [{ label: msg.pinnedAt ? t('chat.unpinMessageTitle') : t('chat.pinMessageTitle'), onClick: () => togglePin(msg) }] : []),
      ...(mine ? [{ label: t('events.editTitle'), onClick: () => startEdit(msg, groupEl) }] : []),
      ...(mine || scope.canManage ? [{ label: t('admin.deleteButton'), danger: true, onClick: () => doDelete(msg) }] : []),
      ...(!mine ? ['sep', { label: t('msgMenu.report'), danger: true, onClick: () => openMessageReportModal(msg) }] : []),
    ];
    openContextMenu(e.clientX, e.clientY, items);
  }

  function openMessageReportModal(msg) {
    const m = openModal({
      title: t('msgMenu.reportModalTitle', { name: msg.author.displayName }),
      render(body) {
        body.innerHTML = `
          <p style="color:var(--text-secondary);font-size:14px;margin:0 0 16px">${t('msgMenu.reportNote')}</p>
          <div class="field">
            <label>${t('profile.reasonLabel')}</label>
            <select class="select" id="mr-reason">
              <option value="spam">${t('profile.reportReasonSpam')}</option>
              <option value="harassment">${t('profile.reportReasonHarassment')}</option>
              <option value="other">${t('profile.reportReasonOther')}</option>
            </select>
          </div>
          <div class="field">
            <label>${t('profile.detailsLabel')} <span class="hint">${t('profile.optional')}</span></label>
            <textarea class="input textarea" id="mr-details" rows="3" maxlength="500" placeholder="${t('profile.detailsPlaceholder')}"></textarea>
          </div>
          <div class="error-text" id="mr-err"></div>`;
      },
    });
    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;width:100%';
    footer.innerHTML = `<button class="btn btn-ghost" data-cancel>${t('common.cancel')}</button><button class="btn btn-danger" data-submit>${t('profile.submitReportButton')}</button>`;
    const footerHost = m.overlay.querySelector('.modal-footer');
    footerHost.classList.remove('hidden');
    footerHost.appendChild(footer);
    footer.querySelector('[data-cancel]').addEventListener('click', m.close);
    footer.querySelector('[data-submit]').addEventListener('click', async () => {
      try {
        await api.fileReport({
          reportedUserId: msg.author.id,
          reason: m.body.querySelector('#mr-reason').value,
          details: m.body.querySelector('#mr-details').value.trim(),
          messageId: msg.id,
          plaintextEvidence: msg.content,
        });
        toast(t('profile.reportSubmittedToast'));
        m.close();
      } catch (err) {
        m.body.querySelector('#mr-err').textContent = apiErrorMessage(err, t('profile.submitReportError'));
      }
    });
  }

  function togglePin(msg) {
    const call = msg.pinnedAt ? api.unpinMessage(msg.id) : api.pinMessage(msg.id);
    call.then((res) => {
      const idx = messages.findIndex((m) => m.id === msg.id);
      if (idx !== -1) { messages[idx] = res.message; renderAll(); }
    }).catch((err) => toast(apiErrorMessage(err, t('chat.couldNotUpdatePinError')), { type: 'error' }));
  }

  function startReply(msg) {
    replyingTo = msg;
    renderComposer();
    composerWrap.querySelector('#composer-input')?.focus();
  }

  async function openCreateThreadPrompt(msg) {
    const title = await promptModal({ title: t('chat.createThreadActionTitle'), label: t('chat.createThreadNameLabel'), value: msg.content ? msg.content.slice(0, 60) : '', confirmLabel: t('serverRail.createButton') });
    if (!title) return;
    try {
      const res = await api.createThread(scope.serverId, scope.channelId, { title, content: t('chat.startedFromTemplate', { snippet: msg.content.slice(0, 200) }), parentMessageId: msg.id });
      bus.emit('ui:navigate', { type: 'server', serverId: scope.serverId, channelId: scope.channelId, threadId: res.thread.id });
    } catch (err) { toast(apiErrorMessage(err, t('chat.couldNotCreateThreadError')), { type: 'error' }); }
  }

  function openCreatePollModal() {
    let optionCount = 2;
    const m = openModal({
      title: t('chat.createPollTitle'),
      render(body) {
        function draw() {
          body.innerHTML = `
            <div class="field">
              <label>${t('chat.questionLabel')}</label>
              <input class="input" id="poll-question" maxlength="300" placeholder="${t('chat.questionPlaceholder')}">
            </div>
            <div class="field">
              <label>${t('chat.optionsLabel')}</label>
              <div id="poll-options">
                ${Array.from({ length: optionCount }).map((_, i) => `
                  <input class="input" style="margin-bottom:6px" data-poll-opt maxlength="100" placeholder="${t('chat.optionPlaceholder', { n: i + 1 })}">`).join('')}
              </div>
              ${optionCount < 10 ? `<button type="button" class="btn btn-secondary btn-sm" id="poll-add-opt">${icons.plus(14)} ${t('chat.addOptionButton')}</button>` : ''}
            </div>
            <label class="checkbox-row">
              <input type="checkbox" id="poll-multi">
              ${t('chat.allowMultipleCheckbox')}
            </label>
            <div class="error-text" id="poll-err"></div>`;
          wireAddOption();
        }
        function wireAddOption() {
          body.querySelector('#poll-add-opt')?.addEventListener('click', () => {
            optionCount++;
            const optionsEl = body.querySelector('#poll-options');
            const input = document.createElement('input');
            input.className = 'input';
            input.style.marginBottom = '6px';
            input.dataset.pollOpt = '';
            input.maxLength = 100;
            input.placeholder = t('chat.optionPlaceholder', { n: optionCount });
            optionsEl.appendChild(input);
            input.focus();
            if (optionCount >= 10) body.querySelector('#poll-add-opt')?.remove();
          });
        }
        draw();
      },
    });
    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;width:100%';
    footer.innerHTML = `<button class="btn btn-ghost" data-cancel>${t('common.cancel')}</button><button class="btn btn-primary" data-save>${t('chat.createPollTitle')}</button>`;
    const footerHost = m.overlay.querySelector('.modal-footer');
    footerHost.classList.remove('hidden');
    footerHost.appendChild(footer);
    footer.querySelector('[data-cancel]').addEventListener('click', m.close);
    footer.querySelector('[data-save]').addEventListener('click', async () => {
      const question = m.body.querySelector('#poll-question').value.trim();
      const options = [...m.body.querySelectorAll('[data-poll-opt]')].map((i) => i.value.trim()).filter(Boolean);
      const multiSelect = m.body.querySelector('#poll-multi').checked;
      if (!question) { m.body.querySelector('#poll-err').textContent = t('chat.questionRequiredError'); return; }
      if (options.length < 2) { m.body.querySelector('#poll-err').textContent = t('chat.minOptionsError'); return; }
      try {
        await api.createPoll({ scopeType, scopeId, question, options, multiSelect });
        m.close();
      } catch (err) { m.body.querySelector('#poll-err').textContent = apiErrorMessage(err, t('chat.couldNotCreatePollError')); }
    });
  }

  function votePoll(msg, optionId) {
    const alreadyMine = (msg.poll.options.find((o) => o.id === optionId)?.voterIds || []).includes(state.me.id);
    const call = alreadyMine ? api.unvotePoll(msg.poll.id, optionId) : api.votePoll(msg.poll.id, optionId);
    call.then((res) => {
      const idx = messages.findIndex((mm) => mm.id === msg.id);
      if (idx !== -1) { messages[idx] = res.message; renderAll(); }
    }).catch((err) => toast(apiErrorMessage(err, t('chat.couldNotVoteError')), { type: 'error' }));
  }

  function openForwardModal(msg) {
    const targets = [];
    for (const dm of state.dms) {
      const label = dm.isGroup ? (dm.name || dm.members.map((u) => u.displayName).join(', ')) : (dm.members[0]?.displayName || t('chat.unknownFallback'));
      targets.push({ scopeType: 'dm', scopeId: dm.id, label: `@ ${label}` });
    }
    for (const detail of state.serverDetail.values()) {
      for (const ch of detail.channels) {
        if (ch.type === 'voice' || ch.type === 'notes') continue;
        targets.push({ scopeType: 'channel', scopeId: ch.id, label: `${detail.server.name} / #${ch.name}` });
      }
    }
    const m = openModal({
      title: t('chat.forwardMessageTitle'),
      render(body) {
        body.innerHTML = `
          <div class="field">
            <label>${t('chat.sendToLabel')}</label>
            <select class="select" id="fwd-target">
              ${targets.length ? targets.map((tg, i) => `<option value="${i}">${escapeHtml(tg.label)}</option>`).join('') : `<option value="">${t('chat.noOpenConversationsOption')}</option>`}
            </select>
          </div>
          <div class="field">
            <label>${t('chat.addCommentLabel')} <span class="hint">${t('auth.optional')}</span></label>
            <input class="input" id="fwd-comment" maxlength="1000">
          </div>
          <div class="error-text" id="fwd-err"></div>`;
      },
    });
    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;width:100%';
    footer.innerHTML = `<button class="btn btn-ghost" data-cancel>${t('common.cancel')}</button><button class="btn btn-primary" data-save>${t('chat.forwardButton')}</button>`;
    const footerHost = m.overlay.querySelector('.modal-footer');
    footerHost.classList.remove('hidden');
    footerHost.appendChild(footer);
    footer.querySelector('[data-cancel]').addEventListener('click', m.close);
    footer.querySelector('[data-save]').addEventListener('click', async () => {
      const idx = Number(m.body.querySelector('#fwd-target').value);
      const target = targets[idx];
      if (!target) { m.body.querySelector('#fwd-err').textContent = t('chat.pickForwardTargetError'); return; }
      const comment = m.body.querySelector('#fwd-comment').value.trim();
      try {
        await api.forwardMessage(msg.id, { scopeType: target.scopeType, scopeId: target.scopeId, comment });
        toast(t('chat.messageForwardedToast'));
        m.close();
      } catch (err) { m.body.querySelector('#fwd-err').textContent = apiErrorMessage(err, t('chat.couldNotForwardError')); }
    });
  }

  function toggleReaction(msg, emoji) {
    const existing = (msg.reactions || []).find((r) => r.emoji === emoji);
    const alreadyMine = existing?.userIds.includes(state.me.id);
    const call = alreadyMine ? api.removeReaction(msg.id, emoji) : api.addReaction(msg.id, emoji);
    call.catch((err) => toast(apiErrorMessage(err, t('chat.couldNotReactError')), { type: 'error' }));
  }

  function openReactionPicker(anchor, msg) {
    openEmojiPicker(anchor, (emoji) => toggleReaction(msg, emoji), scope.customEmoji || [], focusComposer);
  }

  function openLightbox(url, fileName) {
    const box = document.createElement('div');
    box.className = 'lightbox';
    box.innerHTML = `
      <a class="lb-download" href="${escapeHtml(url)}" download="${escapeHtml(fileName || '')}" title="${t('chat.saveImageTitle')}">${icons.download(20)}</a>
      <button class="lb-close">${icons.x(20)}</button>
      <img src="${escapeHtml(url)}" alt="">`;
    document.body.appendChild(box);
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const close = () => {
      box.remove();
      document.removeEventListener('keydown', onKey);
    };
    box.addEventListener('click', (e) => {
      if (e.target === box || e.target.closest('.lb-close')) close();
    });
    document.addEventListener('keydown', onKey);
  }

  function startEdit(msg, groupEl) {
    if (isEditing()) return;
    editingId = msg.id;
    const bodyEl = groupEl.querySelector('.body');
    const lineEl = bodyEl.querySelector('.msg-line');
    if (lineEl) lineEl.style.display = 'none';
    const box = document.createElement('div');
    box.className = 'msg-edit-box';
    box.innerHTML = `
      <textarea rows="1">${escapeHtml(msg.content)}</textarea>
      <div class="msg-edit-hint">${t('chat.editHintTemplate', { cancelLink: `<span class="link-btn" data-cancel>${t('chat.cancelLink')}</span>`, saveLink: `<span class="link-btn" data-save>${t('chat.saveLink')}</span>` })}</div>`;
    bodyEl.appendChild(box);
    const ta = box.querySelector('textarea');
    autoGrow(ta);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);

    const cancel = () => { editingId = null; renderAll(); focusComposer(); };
    const save = async () => {
      const content = ta.value.trim();
      if (!content) return cancel();
      if (content === msg.content) return cancel();
      try {
        const res = await api.editMessage(msg.id, content);
        Object.assign(msg, res.message);
      } catch (err) {
        toast(apiErrorMessage(err, t('chat.couldNotEditMessageError')), { type: 'error' });
      }
      editingId = null;
      renderAll();
      focusComposer();
    };

    box.querySelector('[data-cancel]').addEventListener('click', cancel);
    box.querySelector('[data-save]').addEventListener('click', save);
    ta.addEventListener('input', () => autoGrow(ta));
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
    });
  }

  function doDelete(msg) {
    confirmModal({
      title: t(msg.eventType ? 'serverLog.deleteEntryTitle' : 'chat.deleteMessageTitle'),
      message: t(msg.eventType ? 'serverLog.deleteEntryConfirm' : 'chat.deleteMessageConfirmMessage'),
      confirmLabel: t('admin.deleteButton'),
      async onConfirm() {
        try {
          await api.deleteMessage(msg.id);
          messages = messages.filter((m) => m.id !== msg.id);
          if (editingId === msg.id) editingId = null;
          if (!isEditing()) renderAll();
          else listEl.querySelector(`[data-id="${msg.id}"]`)?.remove();
        } catch (err) {
          toast(apiErrorMessage(err, t('chat.couldNotDeleteMessageError')), { type: 'error' });
        }
      },
    });
  }

  // ---------------- composer ----------------

  function setComposerConnected(connected) {
    const composer = composerWrap.querySelector('.composer');
    if (!composer) return; // no-permission banner is shown instead — nothing to toggle
    composer.classList.toggle('disconnected', !connected);
    composer.querySelectorAll('textarea, button').forEach((el) => { el.disabled = !connected; });
  }

  function focusComposer() {
    refocusInput(composerWrap.querySelector('#composer-input'));
  }

  function renderComposer() {
    if (!scope.canSend) {
      composerWrap.innerHTML = `<div class="no-perm-banner">${t('chat.noPermissionBanner')}</div>`;
      return;
    }
    // startReply()/cancelling a reply both re-run this whole render — preserve whatever draft
    // text was already there instead of silently wiping it.
    const draft = composerWrap.querySelector('#composer-input')?.value ?? '';
    composerWrap.innerHTML = `
      <div class="slash-popup hidden" id="slash-popup"></div>
      ${replyingTo ? `
        <div class="reply-banner" id="reply-banner">
          <span>${icons.reply(14)} ${t('chat.replyingToBanner', { name: `<strong>${escapeHtml(replyingTo.author.displayName)}</strong>` })}</span>
          <button type="button" class="btn-icon" id="reply-cancel" title="${t('chat.cancelReplyTitle')}">${icons.x(14)}</button>
        </div>` : ''}
      <div class="upload-tray" id="upload-tray"></div>
      <div class="composer">
        <button type="button" class="composer-btn" id="btn-attach" title="${escapeHtml(t('chat.uploadFileTitle'))}">${icons.plus(22)}</button>
        <input type="file" id="file-input" multiple class="hidden" accept="*/*">
        <textarea id="composer-input" rows="1" enterkeyhint="send" placeholder="${escapeHtml(placeholderFor(scope))}"></textarea>
        <button type="button" class="composer-btn" id="btn-poll" title="${t('chat.createPollTitle')}">${icons.barChart(20)}</button>
        <button type="button" class="composer-btn" id="btn-sticker" title="${t('admin.stickersTab')}">${icons.image(22)}</button>
        <button type="button" class="composer-btn" id="btn-emoji" title="${t('serverSettings.navEmoji')}">${icons.smile(22)}</button>
        ${scope.channelType === 'stage' || !canRecordVoice() ? '' : `<button type="button" class="composer-btn" id="btn-voice" title="${t('voiceMsg.record')}">${icons.mic(22)}</button>`}
        ${scope.serverId ? `<button type="button" class="composer-btn" id="btn-sounds" title="${t('admin.soundboardTab')}">${icons.music(22)}</button>` : ''}
        ${scope.channelType === 'stage' ? '' : `<button type="button" class="composer-btn" id="btn-schedule" title="${t('chat.scheduleTitle')}">${icons.clock(22)}</button>`}
        <button type="button" class="composer-btn composer-btn-send" id="btn-send" title="${t('chat.sendTitle')}">${icons.send(20)}</button>
      </div>`;

    composerWrap.querySelector('#reply-cancel')?.addEventListener('click', () => { replyingTo = null; renderComposer(); focusComposer(); });

    const input = composerWrap.querySelector('#composer-input');
    input.value = draft;
    const fileInput = composerWrap.querySelector('#file-input');
    const attachBtn = composerWrap.querySelector('#btn-attach');
    const emojiBtn = composerWrap.querySelector('#btn-emoji');
    const sendBtn = composerWrap.querySelector('#btn-send');
    sendBtn.addEventListener('click', () => submit());

    attachBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      addFiles([...fileInput.files]);
      fileInput.value = '';
    });

    emojiBtn.addEventListener('click', () => {
      openEmojiPicker(emojiBtn, (emoji) => {
        insertAtCursor(input, emoji);
      }, scope.customEmoji || [], focusComposer);
    });

    const stickerBtn = composerWrap.querySelector('#btn-sticker');
    stickerBtn?.addEventListener('click', async () => {
      const list = scope.kind === 'dm' ? await availableDmStickers() : scope.stickers || [];
      openStickerPicker(stickerBtn, list, (sticker) => submit(sticker), focusComposer);
    });

    composerWrap.querySelector('#btn-poll').addEventListener('click', () => openCreatePollModal());
    composerWrap.querySelector('#btn-voice')?.addEventListener('click', async () => {
      const host = composerWrap.querySelector('#upload-tray');
      if (host.querySelector('.voice-recorder')) return;
      await openRecorderBar(host, {
        onSend: ({ file, durationMs }) => submit(undefined, { file, durationMs }),
        onError: () => toast(t('voiceMsg.noMic'), { type: 'error' }),
      });
    });
    composerWrap.querySelector('#btn-sounds')?.addEventListener('click', (e) => {
      const sounds = getServerDetail(scope.serverId)?.sounds || [];
      openSoundboardPicker(e.currentTarget, sounds, (sound) => {
        // In a call on this server the room hears it; otherwise it plays only for you, as a preview.
        if (state.voice.channelId && state.voice.serverId === scope.serverId) ws.send({ type: 'voice_soundboard_play', channelId: state.voice.channelId, soundId: sound.id });
        else if (scope.kind === 'dm') new Audio(sound.audioPath).play().catch(() => {});
        else submit(undefined, undefined, sound);
      });
    });
    composerWrap.querySelector('#btn-schedule')?.addEventListener('click', () => {
      openScheduleModal({
        scope: { scopeType, scopeId },
        content: input.value.trim(),
        replyToMessageId: replyingTo?.id,
        onScheduled: () => { input.value = ''; replyingTo = null; renderComposer(); focusComposer(); },
      });
    });

    let lastTypingSent = 0;
    input.addEventListener('input', () => {
      autoGrow(input);
      updateComposerPopup(input);
      const now = Date.now();
      if (now - lastTypingSent > 2500) {
        lastTypingSent = now;
        ws.sendTyping(scopeType, scopeId);
      }
    });

    input.addEventListener('keydown', (e) => {
      if (popupMatches.length && handleComposerPopupKey(e, input)) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit();
        return;
      }
      // Discord/Slack convention: Up in an empty composer edits your own last message, not
      // wherever the cursor happens to sit — an empty box has no cursor history worth navigating.
      if (e.key === 'ArrowUp' && input.value === '' && !isEditing()) {
        const lastOwn = [...messages].reverse().find((m) => !m.eventType && !m.pending && !m.errored && isSelf(m.author.id));
        if (lastOwn) {
          const groupEl = listEl.querySelector(`[data-id="${lastOwn.id}"]`);
          if (groupEl) { e.preventDefault(); startEdit(lastOwn, groupEl); }
        }
      }
    });
    input.addEventListener('blur', () => setTimeout(closeComposerPopup, 150)); // delay so a click on the popup still registers

    input.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files || [])];
      if (files.length) addFiles(files);
    });

    composerWrap.addEventListener('dragover', (e) => e.preventDefault());
    composerWrap.addEventListener('drop', (e) => {
      e.preventDefault();
      const files = [...(e.dataTransfer?.files || [])];
      if (files.length) addFiles(files);
    });

    renderUploadTray();
    autoGrow(input);
  }

  // Composer autocomplete popup: three trigger modes sharing one picker UI (Discord shows all
  // three the same way). "slash" only fires while the composer is just "/" + a partial command
  // name at the very start (no space yet); "mention" and "channel" fire on "@"/"#" immediately
  // preceded by whitespace or the start of the line, anywhere in the text, ending at the caret —
  // typing a space (or picking an item, which appends one) commits and closes the popup.
  let composerPopupMode = null; // 'slash' | 'mention' | 'channel' | 'emoji' | null
  let popupMatches = [];
  let popupActiveIndex = 0;
  let popupQuery = '';
  let popupTriggerStart = 0; // index into input.value of the trigger char itself

  function updateComposerPopup(input) {
    const val = input.value;
    const pos = input.selectionStart ?? val.length;

    const slashMatch = val.match(/^\/([a-zA-Z0-9_@.-]*)$/);
    if (slashMatch) {
      composerPopupMode = 'slash';
      popupQuery = slashMatch[1];
      popupMatches = allSlashCommands().filter((c) => c.name.startsWith(popupQuery.toLowerCase()));
      popupActiveIndex = 0;
      renderComposerPopup();
      return;
    }

    const before = val.slice(0, pos);
    const mentionMatch = before.match(/(?:^|\s)@([a-zA-Z0-9_.]{0,32})$/);
    const channelMatch = scope.kind !== 'dm' ? before.match(/(?:^|\s)#([a-zA-Z0-9_-]{0,80})$/) : null;

    if (mentionMatch) {
      composerPopupMode = 'mention';
      popupQuery = mentionMatch[1];
      popupTriggerStart = pos - mentionMatch[1].length - 1;
      popupMatches = mentionCandidates().filter((c) => c.label.toLowerCase().startsWith(popupQuery.toLowerCase())).slice(0, 8);
      popupActiveIndex = 0;
      renderComposerPopup();
      return;
    }
    if (channelMatch) {
      composerPopupMode = 'channel';
      popupQuery = channelMatch[1];
      popupTriggerStart = pos - channelMatch[1].length - 1;
      popupMatches = channelCandidates().filter((c) => c.label.toLowerCase().startsWith(popupQuery.toLowerCase())).slice(0, 8);
      popupActiveIndex = 0;
      renderComposerPopup();
      return;
    }
    const emojiMatch = before.match(/(?:^|\s):([a-zA-Z0-9_+-]{2,32})$/);
    if (emojiMatch) {
      composerPopupMode = 'emoji';
      popupQuery = emojiMatch[1];
      popupTriggerStart = pos - emojiMatch[1].length - 1;
      popupMatches = emojiCandidates(popupQuery.toLowerCase());
      popupActiveIndex = 0;
      renderComposerPopup();
      return;
    }
    closeComposerPopup();
  }

  // Custom emoji shadow same-named Unicode shortcodes (as in replaceCustomEmoji); prefix matches
  // rank ahead of substring matches.
  function emojiCandidates(q) {
    const all = [];
    const taken = new Set();
    for (const e of scope.customEmoji || []) {
      const lower = e.name.toLowerCase();
      if (taken.has(lower)) continue;
      taken.add(lower);
      all.push({ label: e.name, image: e.image_path, insert: `:${e.name}:` });
    }
    for (const [name, glyph] of Object.entries(EMOJI_SHORTCODES)) {
      if (!taken.has(name)) all.push({ label: name, glyph, insert: glyph });
    }
    const prefix = all.filter((c) => c.label.toLowerCase().startsWith(q));
    const infix = all.filter((c) => !c.label.toLowerCase().startsWith(q) && c.label.toLowerCase().includes(q));
    return [...prefix, ...infix].slice(0, 8);
  }

  // @everyone/@here first, then roles (single-word names only — the server's mention parser has
  // no way to unambiguously delimit a multi-word role name in plain text), then members. DMs
  // have no roles/@everyone, just the other participant(s).
  function mentionCandidates() {
    if (scope.kind === 'dm') {
      const dm = state.dms.find((d) => d.id === scope.dmId);
      return (dm?.members || []).map((u) => ({ label: u.username, sub: u.displayName }));
    }
    const items = [
      { label: 'everyone', sub: t('chat.notifyEveryoneSub') },
      { label: 'here', sub: t('chat.notifyHereSub') },
    ];
    const detail = getServerDetail(scope.serverId);
    if (!detail) return items;
    for (const r of detail.roles) if (r.name && !/\s/.test(r.name)) items.push({ label: r.name, sub: t('chat.roleSub') });
    for (const m of detail.members) items.push({ label: m.user.username, sub: m.user.displayName });
    return items;
  }

  function channelCandidates() {
    return (scope.channels || []).map((ch) => ({ label: ch.name, sub: ch.type }));
  }

  function closeComposerPopup() {
    composerPopupMode = null;
    popupMatches = [];
    renderComposerPopup();
  }

  function renderComposerPopup() {
    const popup = composerWrap.querySelector('#slash-popup');
    if (!popup) return;
    if (!composerPopupMode || popupMatches.length === 0) { popup.classList.add('hidden'); popup.innerHTML = ''; return; }
    popup.classList.remove('hidden');
    const keepScroll = popup.scrollTop;
    const headerHtml = composerPopupMode === 'slash' ? t('chat.commandsMatchingHeader', { query: `<strong>/${escapeHtml(popupQuery)}</strong>` })
      : composerPopupMode === 'mention' ? t('chat.mentionMatchingHeader', { query: `<strong>@${escapeHtml(popupQuery)}</strong>` })
        : composerPopupMode === 'emoji' ? t('chat.emojiMatchingHeader', { query: `<strong>:${escapeHtml(popupQuery)}</strong>` })
          : t('chat.channelsMatchingHeader', { query: `<strong>#${escapeHtml(popupQuery)}</strong>` });
    popup.innerHTML = `
      <div class="slash-popup-header">${headerHtml}</div>
      ${popupMatches.map((item, i) => renderPopupItem(item, i)).join('')}`;
    popup.scrollTop = keepScroll;
    popup.querySelector('.slash-popup-item.active')?.scrollIntoView({ block: 'nearest' });
    popup.querySelectorAll('[data-popup-idx]').forEach((node) => {
      // mousedown (not click) fires before the textarea's blur handler closes the popup out from under it.
      node.addEventListener('mousedown', (e) => {
        e.preventDefault();
        selectComposerItem(popupMatches[Number(node.dataset.popupIdx)], composerWrap.querySelector('#composer-input'));
      });
    });
  }

  function renderPopupItem(item, i) {
    const active = i === popupActiveIndex ? 'active' : '';
    if (composerPopupMode === 'slash') {
      return `<div class="slash-popup-item ${active}" data-popup-idx="${i}">
        <span class="slash-name">${escapeHtml(item.usage)}</span>
        <span class="slash-desc">${escapeHtml(item.description)}</span>
      </div>`;
    }
    if (composerPopupMode === 'emoji') {
      return `<div class="slash-popup-item ${active}" data-popup-idx="${i}">
        <span class="slash-name slash-emoji">${item.image ? `<img class="custom-emoji" src="${escapeHtml(item.image)}" alt="">` : item.glyph}</span>
        <span class="slash-desc">:${escapeHtml(item.label)}:</span>
      </div>`;
    }
    const prefix = composerPopupMode === 'mention' ? '@' : '#';
    return `<div class="slash-popup-item ${active}" data-popup-idx="${i}">
      <span class="slash-name">${prefix}${escapeHtml(item.label)}</span>
      <span class="slash-desc">${escapeHtml(item.sub)}</span>
    </div>`;
  }

  function selectComposerItem(item, input) {
    if (composerPopupMode === 'slash') { selectSlashCommand(item.name, input); return; }
    const prefix = composerPopupMode === 'mention' ? '@' : '#';
    const insertText = composerPopupMode === 'emoji' ? `${item.insert} ` : `${prefix}${item.label} `;
    const val = input.value;
    const pos = input.selectionStart ?? val.length;
    input.value = val.slice(0, popupTriggerStart) + insertText + val.slice(pos);
    closeComposerPopup();
    input.focus();
    const newPos = popupTriggerStart + insertText.length;
    input.setSelectionRange(newPos, newPos);
    autoGrow(input);
  }

  // ---- bot slash commands (server channels only) ----
  let botCommands = [];
  const ephemerals = [];

  function loadBotCommands() {
    if (scope.kind !== 'channel' || !scope.serverId) return;
    api.listServerCommands(scope.serverId).then((res) => { botCommands = res.commands || []; }).catch(() => {});
  }

  // Built-ins first; a bot command that shares a name with another bot's gets "@botname" appended.
  function allSlashCommands() {
    const builtIn = slashCommands();
    const taken = new Set(builtIn.map((c) => c.name));
    const counts = new Map();
    for (const c of botCommands) counts.set(c.name, (counts.get(c.name) || 0) + 1);
    const bots = botCommands.filter((c) => !taken.has(c.name)).map((c) => ({
      name: counts.get(c.name) > 1 ? `${c.name}@${c.botUsername}` : c.name,
      usage: usageOf(c),
      description: `${c.description ? c.description + ' - ' : ''}${c.botName}`,
      bot: c,
    }));
    return [...builtIn, ...bots];
  }

  function findBotCommand(typed) {
    return allSlashCommands().find((c) => c.bot && c.name === typed.toLowerCase())?.bot || null;
  }

  async function runBotCommand(def, rest) {
    const options = parseInvocation(def, rest);
    const missing = missingRequired(def, options);
    if (missing) { toast(t('slash.missingOption', { name: missing, usage: usageOf(def) }), { type: 'error' }); return { handled: true, keepInput: true }; }
    try {
      await api.invokeCommand(scope.serverId, { channelId: scope.channelId, botId: def.botId, command: def.name, options });
    } catch (err) {
      toast(apiErrorMessage(err, t('slash.invokeFailed')), { type: 'error' });
      return { handled: true, keepInput: true };
    }
    return { handled: true };
  }

  function onEphemeral(msg) {
    const e = msg.message;
    if (scope.kind !== 'channel' || e.scopeType !== 'channel' || e.scopeId !== scope.channelId) return;
    ephemerals.push(e);
    const stick = isNearBottom();
    renderAll();
    if (stick) scrollToBottom();
  }

  function renderEphemeral(e) {
    return `
      <div class="msg-group ephemeral-msg" data-ephemeral="${escapeHtml(e.id)}">
        <div class="gutter">${avatarHtml({ id: e.bot.id, username: e.bot.username, displayName: e.bot.displayName, avatarPath: e.bot.avatarPath }, 40)}</div>
        <div class="body">
          <div class="msg-head">
            <span class="author-name">${escapeHtml(e.bot.displayName)}</span><span class="bot-badge">${t('bots.badge')}</span>
            <span class="timestamp">${formatTimestamp(e.createdAt)}</span>
          </div>
          <div class="msg-line">${renderMessageContent(e.content, { channels: scope.channels, customEmoji: scope.customEmoji })}</div>
          <div class="ephemeral-note">${escapeHtml(t('slash.onlyYou'))} - <a href="#" data-ephemeral-dismiss="${escapeHtml(e.id)}">${escapeHtml(t('slash.dismiss'))}</a></div>
        </div>
      </div>`;
  }

  function selectSlashCommand(name, input) {
    input.value = `/${name} `;
    closeComposerPopup();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    autoGrow(input);
  }

  // Returns true if it consumed the keystroke (caller should not also treat it as a normal
  // composer key, e.g. Enter-to-submit).
  function handleComposerPopupKey(e, input) {
    if (e.key === 'ArrowDown') { e.preventDefault(); popupActiveIndex = (popupActiveIndex + 1) % popupMatches.length; renderComposerPopup(); return true; }
    if (e.key === 'ArrowUp') { e.preventDefault(); popupActiveIndex = (popupActiveIndex - 1 + popupMatches.length) % popupMatches.length; renderComposerPopup(); return true; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); selectComposerItem(popupMatches[popupActiveIndex], input); return true; }
    if (e.key === 'Escape') { e.preventDefault(); closeComposerPopup(); return true; }
    return false;
  }

  function placeholderFor(sc) {
    if (sc.kind === 'dm') return t('chat.dmPlaceholder');
    if (sc.kind === 'thread') return t('chat.threadPlaceholder');
    return t('chat.channelPlaceholder', { channel: sc.channelName || 'channel' });
  }

  function autoGrow(ta) {
    ta.style.height = 'auto';
    // A tall draft (e.g. a large paste) drops the buttons below the text instead of leaving an empty
    // column beside it. Enter/leave thresholds differ so the width change can't flip it back and forth.
    const composerEl = ta.closest('.composer');
    if (composerEl) {
      const stacked = composerEl.classList.contains('tall');
      if (!stacked && ta.scrollHeight > 110) composerEl.classList.add('tall');
      else if (stacked && ta.scrollHeight <= 50) composerEl.classList.remove('tall');
      ta.style.height = 'auto';
    }
    // visualViewport.height (when available) reflects the actually-visible area once the
    // on-screen keyboard has shrunk it, unlike window.innerHeight which stays the full layout
    // viewport on many mobile browsers/WebViews - without this the composer could grow taller
    // than what's actually visible above the keyboard.
    const viewportHeight = window.visualViewport?.height || window.innerHeight;
    ta.style.height = `${Math.min(ta.scrollHeight, viewportHeight * 0.5)}px`;
  }

  function insertAtCursor(input, text) {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.value = input.value.slice(0, start) + text + input.value.slice(end);
    const pos = start + text.length;
    input.setSelectionRange(pos, pos);
    input.focus();
    autoGrow(input);
  }

  const RESIZE_PRESETS = { large: 1920, medium: 1280, small: 800 };
  const resizeChoices = new Map(); // File -> preset key ('original' | 'large' | 'medium' | 'small')

  // Re-encodes a still image to fit within maxDim (longest side), preserving aspect ratio.
  // Never called for GIFs (canvas can only capture one frame, which would kill the animation).
  function resizeImageFile(file, maxDim) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        if (scale === 1) { resolve(file); return; }
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => resolve(blob ? new File([blob], file.name, { type: file.type }) : file), file.type, 0.9);
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }

  const objectUrls = new Map(); // File -> blob: URL, so re-renders reuse instead of leaking one per render

  function objectUrlFor(file) {
    let url = objectUrls.get(file);
    if (!url) { url = URL.createObjectURL(file); objectUrls.set(file, url); }
    return url;
  }

  function releaseObjectUrl(file) {
    const url = objectUrls.get(file);
    if (url) { URL.revokeObjectURL(url); objectUrls.delete(file); }
  }

  function addFiles(files) {
    const maxMb = state.config.maxUploadMb || 25;
    for (const f of files) {
      if (uploadFiles.length >= 5) { toast(t('chat.maxFilesToast')); break; }
      const check = checkUploadFile(f, maxMb);
      if (!check.ok) { toast(check.reason === 'blocked' ? t('chat.fileBlockedType', { name: f.name }) : t('chat.fileTooLarge', { name: f.name, mb: maxMb }), { type: 'error', ttl: 8000 }); continue; }
      uploadFiles.push(f);
    }
    renderUploadTray();
  }

  function renderUploadTray() {
    const tray = composerWrap.querySelector('#upload-tray');
    if (!tray) return;
    tray.innerHTML = uploadFiles.map((f, i) => {
      const isImg = isImageMime(f.type);
      const isVid = isVideoMime(f.type);
      const canResize = isImg && f.type !== 'image/gif';
      return `<div class="upload-item">
        <div class="upload-chip" data-idx="${i}">
          ${isImg ? `<img src="${objectUrlFor(f)}" alt="">`
            : isVid ? `<video src="${objectUrlFor(f)}" muted></video>`
            : `<div class="file-glyph">${icons.file(22)}<span>${escapeHtml(f.name.slice(0, 14))}</span></div>`}
          <button class="remove" data-remove="${i}" type="button">${icons.x(12)}</button>
        </div>
        ${canResize ? `
          <select class="resize-select" data-resize-idx="${i}" title="${t('chat.resizeBeforeSendingTitle')}">
            <option value="original">${t('chat.originalOption')}</option>
            <option value="large">${t('chat.largeOption')}</option>
            <option value="medium">${t('chat.mediumOption')}</option>
            <option value="small">${t('chat.smallOption')}</option>
          </select>` : ''}
      </div>`;
    }).join('');
    tray.querySelectorAll('[data-remove]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const [removed] = uploadFiles.splice(Number(btn.dataset.remove), 1);
        if (removed) { releaseObjectUrl(removed); resizeChoices.delete(removed); }
        renderUploadTray();
      });
    });
    tray.querySelectorAll('[data-resize-idx]').forEach((select) => {
      const f = uploadFiles[Number(select.dataset.resizeIdx)];
      select.value = resizeChoices.get(f) || 'original';
      select.addEventListener('change', () => resizeChoices.set(f, select.value));
    });
  }

  // Lightweight, client-only slash commands. Two shapes: some (/afk, /invite, /dm, /nick,
  // /topic) act entirely through their own API calls and never touch the message pipe; others
  // (/ping, /me, /shrug, /tableflip, /unflip) rewrite the composer text into a real message so
  // the result is visible to everyone in the channel, same as typing it by hand.
  async function handleSlashCommand(raw) {
    const spaceIdx = raw.indexOf(' ');
    const cmd = (spaceIdx === -1 ? raw : raw.slice(0, spaceIdx)).toLowerCase();
    const rest = spaceIdx === -1 ? '' : raw.slice(spaceIdx + 1).trim();

    if (cmd === '/afk') {
      try {
        await api.setStatus({ status: 'idle', customStatusText: rest || 'AFK' });
        state.me.status = 'idle';
        state.me.customStatusText = rest || 'AFK';
        bus.emit('state:me');
        toast(rest ? t('chat.nowAfkWithMessage', { message: rest }) : t('chat.nowAfk'));
      } catch (err) { toast(apiErrorMessage(err, t('chat.couldNotSetAfkError')), { type: 'error' }); }
      return { handled: true };
    }
    if (cmd === '/help') {
      openModal({
        title: t('chat.commandsShortcutsTitle'),
        wide: true,
        render(body) {
          body.innerHTML = `
            <div class="activity-section-label">${t('chat.slashCommandsLabel')}</div>
            <div class="help-cmd-list">
              ${slashCommands().map((c) => `
                <div class="help-cmd-row">
                  <span class="slash-name">${escapeHtml(c.usage)}</span>
                  <span class="slash-desc" style="white-space:normal">${escapeHtml(c.description)}</span>
                </div>`).join('')}
            </div>
            <div class="activity-section-label" style="margin-top:16px">${t('chat.autocompleteLabel')}</div>
            <p style="color:var(--text-secondary);font-size:13px;line-height:1.6">
              ${t('chat.autocompleteHint')}
            </p>
            <div class="activity-section-label" style="margin-top:16px">${t('shell.keyboardShortcutsLabel')}</div>
            <p style="color:var(--text-secondary);font-size:13px;line-height:1.8">
              <strong>Enter</strong> ${t('shell.shortcutSend')} &nbsp;·&nbsp; <strong>Shift+Enter</strong> ${t('shell.shortcutNewLine')}<br>
              <strong>↑</strong> ${t('shell.shortcutEditLast')}<br>
              <strong>Esc</strong> ${t('shell.shortcutCloseModal')}
            </p>`;
        },
      });
      return { handled: true };
    }
    if (cmd === '/invite') {
      if (scope.kind !== 'channel') { toast(t('chat.inviteOnlyInChannelError')); return { handled: true }; }
      const detail = getServerDetail(scope.serverId);
      if (detail?.server) openInviteModal(detail.server);
      else toast(t('chat.couldNotOpenInviteError'), { type: 'error' });
      return { handled: true };
    }
    if (cmd === '/ping') {
      const start = performance.now();
      try {
        await api.config();
        return { handled: false, replaceContent: t('chat.pongMessage', { ms: Math.round(performance.now() - start) }) };
      } catch {
        toast(t('chat.pingFailedError'), { type: 'error' });
        return { handled: true };
      }
    }
    if (cmd === '/dm' || cmd === '/msg') {
      const spaceIdx2 = rest.indexOf(' ');
      const username = (spaceIdx2 === -1 ? rest : rest.slice(0, spaceIdx2)).replace(/^@/, '');
      const initialMessage = spaceIdx2 === -1 ? '' : rest.slice(spaceIdx2 + 1).trim();
      if (!username) { toast(t('chat.dmUsageError', { cmd }), { type: 'error' }); return { handled: true }; }
      try {
        const target = await resolveUsername(username);
        if (!target) { toast(t('chat.noUserFoundError', { username }), { type: 'error' }); return { handled: true }; }
        const { dmId } = await api.openDm(target.id);
        if (initialMessage) await api.sendDmMessage(dmId, { content: initialMessage });
        bus.emit('dms:unknownScope'); // refresh the DM list so the new/existing conversation shows up
        bus.emit('ui:navigate', { type: 'dm', dmId });
      } catch (err) { toast(apiErrorMessage(err, t('chat.couldNotStartDmError')), { type: 'error' }); }
      return { handled: true };
    }
    if (cmd === '/thread') {
      if (scope.kind !== 'channel') { toast(t('chat.threadOnlyInChannelError')); return { handled: true }; }
      if (!rest) { toast(t('chat.threadUsageError'), { type: 'error' }); return { handled: true }; }
      try {
        const res = await api.createThread(scope.serverId, scope.channelId, { title: rest.slice(0, 100), content: t('chat.threadStartedTemplate', { text: rest }) });
        bus.emit('ui:navigate', { type: 'server', serverId: scope.serverId, channelId: scope.channelId, threadId: res.thread.id });
      } catch (err) { toast(apiErrorMessage(err, t('chat.couldNotCreateThreadError')), { type: 'error' }); }
      return { handled: true };
    }
    if (cmd === '/nick') {
      if (scope.kind !== 'channel') { toast(t('chat.nickOnlyInChannelError')); return { handled: true }; }
      try {
        await api.setNickname(scope.serverId, state.me.id, rest || null);
        toast(rest ? t('chat.nicknameSetToast', { name: rest }) : t('chat.nicknameClearedToast'));
      } catch (err) { toast(apiErrorMessage(err, t('chat.couldNotChangeNicknameError')), { type: 'error' }); }
      return { handled: true };
    }
    if (cmd === '/topic') {
      if (scope.kind !== 'channel') { toast(t('chat.topicOnlyInChannelError')); return { handled: true }; }
      try {
        await api.updateChannel(scope.serverId, scope.channelId, { topic: rest });
        toast(rest ? t('chat.topicUpdatedToast') : t('chat.topicClearedToast'));
      } catch (err) { toast(apiErrorMessage(err, t('chat.couldNotChangeTopicError')), { type: 'error' }); }
      return { handled: true };
    }
    if (cmd === '/wipe') {
      if (scope.kind !== 'channel') { toast(t('chat.wipeOnlyInChannelError'), { type: 'error' }); return { handled: true }; }
      const count = Number(rest);
      if (!Number.isInteger(count) || count < 1) { toast(t('chat.wipeUsageError'), { type: 'error' }); return { handled: true }; }
      try {
        const res = await api.wipeMessages(scope.serverId, scope.channelId, count);
        toast(t('chat.wipeDoneToast', { count: res.deleted }));
      } catch (err) { toast(apiErrorMessage(err, t('chat.wipeFailedError')), { type: 'error' }); }
      return { handled: true };
    }
    if (cmd === '/me') {
      if (!rest) return { handled: true };
      return { handled: false, replaceContent: `*${rest}*` };
    }
    if (cmd === '/spoiler') {
      if (!rest) return { handled: true };
      return { handled: false, replaceContent: `||${rest}||` };
    }
    if (cmd === '/shrug') return { handled: false, replaceContent: rest ? `${rest} ${SHRUG}` : SHRUG };
    if (cmd === '/tableflip') return { handled: false, replaceContent: rest ? `${rest} (╯°□°)╯︵ ┻━┻` : '(╯°□°)╯︵ ┻━┻' };
    if (cmd === '/unflip') return { handled: false, replaceContent: rest ? `${rest} ┬─┬ ノ( ゜-゜ノ)` : '┬─┬ ノ( ゜-゜ノ)' };
    const botCmd = scope.kind === 'channel' ? findBotCommand(cmd.slice(1)) : null;
    if (botCmd) return runBotCommand(botCmd, rest);
    return { handled: false };
  }

  // Best-effort username -> user resolver for commands like /dm: an exact (case-insensitive)
  // username match wins; otherwise, if the search turns up exactly one hit, that's close enough.
  async function resolveUsername(username) {
    const { users } = await api.searchUsers(username);
    return users.find((u) => u.username.toLowerCase() === username.toLowerCase()) || (users.length === 1 ? users[0] : null);
  }

  let dmStickers = [];
  async function availableDmStickers() {
    try { dmStickers = (await api.listAvailableStickers()).stickers; } catch { /* keep the last list */ }
    return dmStickers;
  }

  async function submit(sentSticker, voice, sentSound) {
    const input = composerWrap.querySelector('#composer-input');
    let content = voice ? '' : input.value.trim();
    if (!content && uploadFiles.length === 0 && !sentSticker && !voice && !sentSound) return;
    if (sending) return;

    if (content.startsWith('/') && uploadFiles.length === 0 && !sentSticker && !sentSound) {
      const result = await handleSlashCommand(content);
      if (result.handled) { if (!result.keepInput) { input.value = ''; autoGrow(input); } focusComposer(); return; }
      if (result.replaceContent) content = result.replaceContent;
    }

    if (!voice && content.length > maxChars()) {
      if (textByteLength(content) > MAX_TEXT_FILE_BYTES) { toast(t('chat.tooLargeForFile', { kb: Math.round(MAX_TEXT_FILE_BYTES / 1024) }), { type: 'error' }); return; }
      const name = await promptModal({ title: t('chat.longAsFileTitle'), label: t('chat.longAsFileLabel'), placeholder: t('chat.longAsFilePlaceholder'), confirmLabel: t('chat.longAsFileConfirm'), allowEmpty: true });
      if (name === null) return;
      uploadFiles = [...uploadFiles, textToFile(content, name)];
      content = '';
    }

    const pendingFiles = voice ? [voice.file] : uploadFiles;
    if (!voice) uploadFiles = [];
    const files = await Promise.all(pendingFiles.map((f) => {
      const preset = resizeChoices.get(f);
      resizeChoices.delete(f);
      return preset && preset !== 'original' ? resizeImageFile(f, RESIZE_PRESETS[preset]) : f;
    }));
    for (const f of pendingFiles) releaseObjectUrl(f);
    const replyToMessageId = replyingTo?.id;
    const replySnapshot = replyingTo;
    replyingTo = null;
    if (!voice) input.value = ''; // renderComposer() below preserves whatever the input currently holds, so clear it first or the just-sent text comes right back
    renderComposer(); // drops the reply banner and re-grows the (now empty) textarea
    focusComposer(); // the re-render replaced the focused textarea

    if (hasNewer) await showLatest();
    const tempId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const optimistic = {
      id: tempId,
      scopeType, scopeId,
      author: state.me,
      content,
      createdAt: new Date().toISOString(),
      editedAt: null,
      attachments: [],
      pending: true,
      uploadProgress: files.length ? 0 : undefined,
      replyTo: replySnapshot ? { id: replySnapshot.id, author: replySnapshot.author, content: replySnapshot.content, sticker: replySnapshot.sticker || null } : null,
      sticker: stickerRef(sentSticker),
      sound: sentSound || null,
    };
    Object.assign(optimistic, { key: tempId, scopeKey: `${scopeType}:${scopeId}`, files });
    messages.push(optimistic);
    renderAll();
    scrollToBottom(); // sending always jumps to the bottom, since it's always your own new message

    sending = true;
    uploads.add(optimistic);
    optimistic._retry = { content, files, sticker: sentSticker, sound: sentSound };
    const onProgress = files.length ? (p) => uploads.progress(optimistic, p) : undefined;
    const stickerId = sentSticker?.id;
    const soundId = sentSound?.id;
    const signal = optimistic.controller.signal;
    const voiceDurationMs = voice?.durationMs;
    (async () => {
      try {
        const res = scope.kind === 'dm'
          ? await api.sendDmMessage(scope.dmId, { content, files, onProgress, replyToMessageId, stickerId, voiceDurationMs, signal })
          : scope.kind === 'thread'
            ? await api.sendThreadMessage(scope.serverId, scope.channelId, scope.threadId, { content, files, onProgress, replyToMessageId, stickerId, voiceDurationMs, signal, soundId })
            : await api.sendChannelMessage(scope.serverId, scope.channelId, { content, files, onProgress, replyToMessageId, stickerId, voiceDurationMs, signal, soundId });
        uploads.finish(optimistic, { res });
      } catch (err) {
        uploads.finish(optimistic, { err });
      }
    })();
  }

  const myUploadScope = `${scopeType}:${scopeId}`;
  const offUploadProgress = bus.on('upload:progress', (item) => {
    if (item.scopeKey !== myUploadScope) return;
    const body = listEl.querySelector(`[data-id="${item.id}"] .body`);
    if (!body) return;
    const bar = body.querySelector('.up-bar i');
    if (bar) bar.style.width = `${Math.round(item.progress * 100)}%`;
    const pct = body.querySelector('.up-pct');
    if (pct) pct.textContent = t('chat.uploadingProgress', { pct: Math.round(item.progress * 100) });
    item.uploadProgress = item.progress;
  });
  const offUploadDone = bus.on('upload:finished', (ev) => {
    const { item, res, err } = ev;
    if (item.scopeKey !== myUploadScope) return;
    ev.handled = true;
    sending = false;
    const idx = messages.findIndex((m) => m.id === item.id);
    if (ev.cancelled) {
      if (idx !== -1) messages.splice(idx, 1);
      renderAll();
      return;
    }
    if (err) {
      if (idx !== -1) { messages[idx].pending = false; messages[idx].errored = true; }
      renderAll();
      toast(apiErrorMessage(err, t('chat.messageFailedToSendError')), { type: 'error' });
      return;
    }
    // The WS create can beat this response and, if the server altered the content (length cap), not match the optimistic entry — then both would stay.
    if (idx !== -1) {
      if (messages.some((m) => m.id === res.message.id)) messages.splice(idx, 1);
      else messages[idx] = res.message;
    }
    renderAll();
  });

  function retrySend(msg) {
    uploads.remove(msg.key);
    const idx = messages.findIndex((m) => m.id === msg.id);
    if (idx !== -1) messages.splice(idx, 1);
    const input = composerWrap.querySelector('#composer-input');
    if (input) {
      input.value = msg._retry?.content || msg.content || '';
      uploadFiles = msg._retry?.files || [];
      renderUploadTray();
      submit(msg._retry?.sticker, undefined, msg._retry?.sound);
    }
  }

  // ---------------- live updates ----------------

  function belongsToScope(payload) {
    return payload.scopeType === scopeType && String(payload.scopeId) === String(scopeId);
  }

  // While a message is being edited, its DOM has a live textarea (see startEdit) — a full
  // renderAll() would wipe that out from under the user. Still apply the data change so the
  // array stays correct; the render catches up as soon as the edit is cancelled/saved.
  function onWsCreate({ message }) {
    if (!belongsToScope(message)) return;
    wsQueue = wsQueue.then(() => applyWsCreate(message)).catch(() => {});
  }

  function applyWsCreate(message) {
    if (typingUsers.delete(message.author.id)) renderTyping();
    if (messages.some((m) => m.id === message.id)) return;
    if (hasNewer) return; // out of the loaded window; scrolling down fetches it in order
    // drop a matching optimistic entry from the same author with identical content, if present
    const dupIdx = messages.findIndex((m) => m.pending && m.author.id === message.author.id && m.content.slice(0, maxChars()) === message.content);
    if (dupIdx !== -1) messages.splice(dupIdx, 1);
    const nearBottom = isNearBottom();
    messages.push(message);
    if (!isEditing()) {
      renderAll();
      if (nearBottom) scrollToBottom();
    }
    markRead(message.id);
  }

  function onWsUpdate({ message }) {
    if (!belongsToScope(message)) return;
    wsQueue = wsQueue.then(() => applyWsUpdate(message)).catch(() => {});
  }

  function applyWsUpdate(message) {
    const idx = messages.findIndex((m) => m.id === message.id);
    if (idx !== -1) {
      messages[idx] = message;
      if (!isEditing()) renderAll();
    }
  }

  function onWsDelete(payload) {
    if (payload.scopeType !== scopeType || String(payload.scopeId) !== String(scopeId)) return;
    const hadIt = messages.some((m) => m.id === payload.messageId);
    if (hadIt) {
      messages = messages.filter((m) => m.id !== payload.messageId);
      if (editingId === payload.messageId) editingId = null;
      if (!isEditing()) renderAll();
    }
  }

  function onWsTyping(payload) {
    if (payload.scopeType !== scopeType || String(payload.scopeId) !== String(scopeId)) return;
    if (isSelf(payload.userId)) return;
    const user = getKnownUser(payload.userId);
    typingUsers.set(payload.userId, { name: user?.displayName || t('chat.typingSomeoneFallback'), expiresAt: Date.now() + 6000 });
    renderTyping();
    clearTimeout(typingTimer);
    typingTimer = setTimeout(renderTyping, 6100);
  }

  function renderTyping() {
    const now = Date.now();
    for (const [id, v] of typingUsers) if (v.expiresAt <= now) typingUsers.delete(id);
    if (typingUsers.size === 0) { typingEl.innerHTML = ''; return; }
    const names = [...typingUsers.values()].map((v) => v.name);
    let text;
    if (names.length === 1) text = t('chat.typingSingular', { name: names[0] });
    else if (names.length === 2) text = t('chat.typingDouble', { name1: names[0], name2: names[1] });
    else text = t('chat.typingMultiple', { count: names.length });
    typingEl.innerHTML = `<span class="typing-dots"><span></span><span></span><span></span></span> ${escapeHtml(text)}…`;
  }

  function destroy() {
    offUploadProgress(); offUploadDone();
    offEphemeral(); offCreate(); offUpdate(); offDelete(); offTyping(); offConnection(); offWsClose(); offWsOpen(); offProfile(); offDms?.();
    scrollEl.removeEventListener('scroll', onScroll);
    pinObserver?.disconnect();
    resizeObserver?.disconnect();
    clearTimeout(typingTimer);
    for (const f of uploadFiles) releaseObjectUrl(f);
  }

  return { destroy };
}
