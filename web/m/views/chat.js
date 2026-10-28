import { api } from '../../js/api.js';
import { bus } from '../../js/bus.js';
import { ws } from '../../js/ws.js';
import { icons } from '../../js/icons.js';
import { t } from '../../js/i18n.js';
import { avatarHtml, escapeHtml, toast } from '../../js/utils.js';
import { state, setReadState, nameFor, getKnownUser } from '../../js/state.js';
import { PERMISSIONS, has, memberPermissionBits, channelPermissionBits } from '../../js/permissions.js';
import { decryptMessages, encryptForSend, cacheSentPlaintext, uploadDmFile, fetchDmFile, trustView, refreshTrust, NO_IDENTITY, KEY_CHANGED } from '../../js/e2ee/dmCrypto.js';
import { nav } from '../router.js';
import { ensureServerDetail } from '../data.js';
import { handleError } from '../lib/errors.js';
import { onLongPress } from '../lib/longPress.js';
import { getPref, setPref } from '../lib/prefs.js';
import { androidBridge } from '../lib/androidBridge.js';
import { mergeMessages, applyUpdate, applyDelete, reconcileLatest, dropMatchingPending, windowReachesLatest } from '../lib/messageList.mjs';
import { dmTitle } from '../lib/dmPreview.mjs';
import { e2eeFileKind } from '../lib/e2eeFiles.mjs';
import { messageHtml, pendingHtml, ephemeralHtml } from '../components/messageItem.js';
import { mountComposer } from '../components/composer.js';
import { openMessageSheet } from '../components/messageSheet.js';
import { onPollClick, openPollSheet } from '../components/pollCard.js';
import { openEmojiSheet, openStickerSheet } from '../components/emojiSheet.js';
import { openImageViewer, openSheet, promptSheet } from '../components/bottomSheet.js';
import { MAX_TEXT_FILE_BYTES, textByteLength, textToFile } from '../../js/longText.js';
import { openProfileSheet } from './profileSheet.js';
import { pickSendTime } from '../components/scheduleSheet.js';
import { wireVoicePlayers } from '../../js/voiceMessage.js';
import { openVerifySheet } from './dmVerifySheet.js';
import { isAgeGateError, renderAgeGate } from '../../js/ageGate.js';
import { EMOJI_SHORTCODES } from '../../js/emojiShortcodes.js';
import { usageOf, parseInvocation, missingRequired } from '../../js/slashCommands.js';
import { builtinSlashCommands, SHRUG } from '../../js/builtinSlash.js';
import { openDmWith } from '../lib/dmOpen.js';
import { copyText } from './serversTab.js';
import { unreadPrefs, firstUnreadIndex, anchorIndex } from '../../js/unreadLine.mjs';

const MAX_WINDOW = 400;

export function mountChat(el, params) {
  const kind = params.kind;
  const scopeType = kind;
  const scopeId = kind === 'dm' ? params.dmId : kind === 'thread' ? params.threadId : params.channelId;
  const scopeKey = `${scopeType}:${scopeId}`;
  const prefs = unreadPrefs(state.uiPrefs);
  const PAGE = prefs.initialMessages;
  // Read pointer at open time: the "new" line stays while this chat is open, gone on the next open once read.
  const unreadAfterId = kind === 'thread' || prefs.unreadLine === 'off' ? 0 : (state.readState.get(scopeKey) || 0);
  let firstLoad = true;
  let messages = [];
  const deleted = new Set(); // ids deleted over the websocket, so a racing create cannot bring them back
  let pending = [];
  let detail = null; let channel = null; let thread = null;
  let canSend = true; let canManage = false;
  let atStart = false; let isLatest = true; let loadingOlder = false; let destroyed = false; let stickToBottom = true;
  let composer = null; let readTimer = null; let queue = Promise.resolve();
  const typing = new Map();
  const offs = [];
  let botCommands = [];
  const ephemerals = [];
  const dm = () => (kind === 'dm' ? state.dms.find((d) => d.id === params.dmId) : null);
  const encrypted = () => !!dm()?.e2eeEnabled;

  const scope = {
    list: (q) => (kind === 'dm' ? api.listDmMessages(params.dmId, q)
      : kind === 'thread' ? api.listThreadMessages(params.serverId, params.channelId, params.threadId, q)
        : api.listChannelMessages(params.serverId, params.channelId, q)),
    send: (o) => (kind === 'dm' ? api.sendDmMessage(params.dmId, o)
      : kind === 'thread' ? api.sendThreadMessage(params.serverId, params.channelId, params.threadId, o)
        : api.sendChannelMessage(params.serverId, params.channelId, o)),
  };

  el.innerHTML = `
    <div class="m-header">
      <button class="m-icon-btn" id="m-back" aria-label="${t('m.back')}">${icons.arrowLeft(22)}</button>
      <span class="m-chan-icon" id="m-title-icon"></span>
      <h1 id="m-title"></h1>
      <div id="m-actions" class="m-actions"></div>
    </div>
    <div class="m-e2ee-banner" id="m-e2ee" hidden></div>
    <div class="m-chat-body">
      <div class="m-msgs m-scroll" id="m-msgs"></div>
      <button class="m-jump" id="m-jump" hidden>${icons.chevronDown(18)} ${t('m.jumpLatest')}</button>
    </div>
    <div class="m-typing" id="m-typing"></div>
    <div class="m-slash" id="m-slash" hidden></div>
    <div id="m-composer-host"></div>`;
  const msgsEl = el.querySelector('#m-msgs');
  wireVoicePlayers(msgsEl);
  if (androidBridge() && getPref('chatStyle', 'plain') === 'bubbles') msgsEl.classList.add('m-bubbles');
  const lastChat = { kind, serverId: params.serverId, channelId: params.channelId, threadId: params.threadId, dmId: params.dmId };
  setPref('lastChat', JSON.stringify(lastChat));
  const jumpEl = el.querySelector('#m-jump');
  el.querySelector('#m-back').addEventListener('click', () => nav.back());

  // ---------- context ----------
  async function resolveContext() {
    if (kind === 'dm') {
      const d = dm();
      const title = dmTitle(d, nameFor);
      el.querySelector('#m-title').textContent = title;
      return { placeholder: t('m.composerPhDm', { name: title }) };
    }
    detail = await ensureServerDetail(params.serverId);
    channel = detail.channels.find((c) => c.id === params.channelId);
    const isOwner = detail.server.owner_id === state.me.id;
    const me = detail.members.find((m) => m.user.id === state.me.id);
    const memberBits = memberPermissionBits(detail.server, detail.roles, me, state.me.id);
    const chBits = channelPermissionBits(channel, detail.roles, me, memberBits, isOwner);
    canSend = has(chBits, PERMISSIONS.SEND_MESSAGES) && !(me?.timeoutUntil && new Date(me.timeoutUntil) > new Date());
    canManage = has(chBits, PERMISSIONS.MANAGE_MESSAGES);
    if (kind === 'thread') {
      const res = await api.getThread(params.serverId, params.channelId, params.threadId);
      thread = res.thread;
      if (thread.archived) canSend = false;
      el.querySelector('#m-title').textContent = thread.title;
      el.querySelector('#m-title-icon').innerHTML = thread.iconPath
        ? `<img class="m-chan-img" src="${escapeHtml(thread.iconPath)}" alt="">` : avatarHtml(thread.createdBy, 24);
      return { placeholder: t('m.composerPhChannel', { name: thread.title }) };
    }
    el.querySelector('#m-title').textContent = channel.icon_path ? channel.name : `# ${channel.name}`;
    if (channel.icon_path) el.querySelector('#m-title-icon').innerHTML = `<img class="m-chan-img" src="${escapeHtml(channel.icon_path)}" alt="">`;
    return { placeholder: t('m.composerPhChannel', { name: channel.name }) };
  }

  // ---------- encrypted attachments ----------
  const e2eeUrls = new Map(); // blob id -> Promise<blob: URL | null>
  const findE2eeFile = (id) => { for (const m of messages) { const f = m.e2eeFiles?.find((x) => x.id === id); if (f) return f; } return null; };
  function e2eeUrl(f) {
    let p = e2eeUrls.get(f.id);
    if (!p) {
      p = fetchDmFile(params.dmId, f).then((bytes) => (bytes ? URL.createObjectURL(new Blob([bytes], { type: f.type })) : null)).catch(() => null);
      e2eeUrls.set(f.id, p);
    }
    return p;
  }
  function hydrateEncryptedImages() {
    msgsEl.querySelectorAll('img[data-e2ee-img]').forEach((img) => {
      const f = findE2eeFile(img.dataset.e2eeImg);
      if (!f) return;
      e2eeUrl(f).then((url) => {
        if (!img.isConnected) return;
        if (url) { img.src = url; img.dataset.viewer = url; return; }
        e2eeUrls.delete(f.id);
        img.replaceWith(Object.assign(document.createElement('div'), { className: 'm-text', textContent: t('dmEncryption.fileDecryptFailed') }));
      });
    });
  }
  async function downloadEncryptedFile(f) {
    try {
      const bytes = await fetchDmFile(params.dmId, f);
      if (!bytes) throw new Error(t('dmEncryption.fileDecryptFailed'));
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: f.name });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (err) { handleError(err, 'm.sendFailed'); }
  }

  // ---------- rendering ----------
  const ctxFor = (prev) => ({ prev, meId: state.me.id, detail });
  function paint({ keepScroll = false, anchor = false } = {}) {
    const before = msgsEl.scrollHeight;
    const top = msgsEl.scrollTop;
    // Trimming the head shifts everything, so pin the first visible message instead of the height delta.
    const viewTop = msgsEl.getBoundingClientRect().top;
    const anchorEl = anchor ? [...msgsEl.querySelectorAll('[data-id]')].find((n) => n.getBoundingClientRect().bottom > viewTop) : null;
    const anchorId = anchorEl?.dataset.id;
    const anchorOffset = anchorEl ? anchorEl.getBoundingClientRect().top - viewTop : 0;
    const dividerAt = firstUnreadIndex(messages, unreadAfterId, (m) => m.author.id === state.me.id);
    msgsEl.innerHTML = (atStart ? `<div class="m-empty">${t('m.chatStart')}</div>` : '')
      + messages.map((m, i) => (i === dividerAt ? unreadDividerHtml(m) : '') + messageHtml(m, ctxFor(i === dividerAt ? null : messages[i - 1]))).join('')
      + pending.map((p) => pendingHtml(p, state.me)).join('')
      + ephemerals.map(ephemeralHtml).join('');
    if (keepScroll) msgsEl.scrollTop = top + (msgsEl.scrollHeight - before);
    const next = anchorId && [...msgsEl.querySelectorAll('[data-id]')].find((n) => n.dataset.id === anchorId);
    if (next) msgsEl.scrollTop += next.getBoundingClientRect().top - viewTop - anchorOffset;
    hydrateEncryptedImages();
  }
  function unreadDividerHtml(m) {
    const day = new Date(m.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    return `<div class="m-unread-divider"><span class="m-unread-date">${escapeHtml(day)}</span><span class="m-unread-badge">${escapeHtml(t('chat.newMessagesBadge'))}</span></div>`;
  }
  function scrollToFirstUnread() {
    const at = prefs.unreadJump === 'firstUnread' ? firstUnreadIndex(messages, unreadAfterId, (m) => m.author.id === state.me.id) : -1;
    if (at < 0) return false;
    const anchorAt = anchorIndex(at, prefs.unreadContext);
    const node = anchorAt === at ? msgsEl.querySelector('.m-unread-divider') : msgsEl.querySelector(`[data-id="${messages[anchorAt].id}"]`);
    if (!node) return false;
    node.scrollIntoView({ block: 'start' });
    // Short chats can't scroll that far — then the bottom is already in view and counts as read.
    const nearBottom = msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 80;
    stickToBottom = nearBottom && isLatest;
    jumpEl.hidden = stickToBottom;
    return true;
  }
  const scrollBottom = () => { msgsEl.scrollTop = msgsEl.scrollHeight; stickToBottom = true; jumpEl.hidden = true; };
  function scrollToMessage(id) {
    const node = msgsEl.querySelector(`[data-id="${id}"]`);
    if (!node) return false;
    node.scrollIntoView({ block: 'center' });
    node.classList.add('m-flash');
    setTimeout(() => node.classList.remove('m-flash'), 1500);
    return true;
  }

  async function decryptList(list) {
    const d = dm();
    if (d && list.some((m) => m.isEncrypted)) {
      await decryptMessages(d, state.me, list);
      bus.emit('state:dms');
    }
    return list;
  }

  async function loadInitial() {
    const res = await scope.list({ limit: PAGE, around: params.jumpToMessageId });
    const list = await decryptList(res.messages);
    isLatest = !params.jumpToMessageId || windowReachesLatest(list, params.jumpToMessageId, PAGE);
    messages = mergeMessages(isLatest ? messages : [], list, deleted);
    atStart = list.length < PAGE && !params.jumpToMessageId;
    paint();
    if (params.jumpToMessageId && scrollToMessage(params.jumpToMessageId)) { stickToBottom = false; jumpEl.hidden = isLatest; }
    else if (firstLoad && !params.jumpToMessageId && scrollToFirstUnread()) { /* positioned at the new-messages line */ }
    else scrollBottom();
    firstLoad = false;
    markReadSoon();
    if (!isLatest) requestAnimationFrame(() => msgsEl.dispatchEvent(new Event('scroll'))); // short window: no scroll will ever fire to pull the next page
  }

  async function loadOlder() {
    if (loadingOlder || atStart || !messages.length) return;
    loadingOlder = true;
    try {
      const res = await scope.list({ before: messages[0].id, limit: PAGE });
      const list = await decryptList(res.messages);
      if (list.length < PAGE) atStart = true;
      messages = mergeMessages(messages, list, deleted);
      if (messages.length > MAX_WINDOW && !pending.length) { messages = messages.slice(0, MAX_WINDOW); isLatest = false; }
      paint({ keepScroll: true });
    } catch (err) { handleError(err, 'm.loadFailed'); } finally { loadingOlder = false; }
  }

  async function loadNewer() {
    if (loadingOlder || isLatest || !messages.length) return;
    loadingOlder = true;
    try {
      const res = await scope.list({ after: messages[messages.length - 1].id, limit: PAGE });
      const list = await decryptList(res.messages);
      if (list.length < PAGE) isLatest = true;
      messages = mergeMessages(messages, list, deleted);
      if (messages.length > MAX_WINDOW) { messages = messages.slice(-MAX_WINDOW); atStart = false; }
      paint({ anchor: true });
      if (isLatest) {
        jumpEl.hidden = true;
        stickToBottom = msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 80;
        markReadSoon();
      }
    } catch (err) { handleError(err, 'm.loadFailed'); } finally { loadingOlder = false; }
  }

  function markReadSoon() {
    if (scopeType === 'thread') return;
    clearTimeout(readTimer);
    readTimer = setTimeout(() => {
      const last = messages[messages.length - 1];
      if (!last || !stickToBottom || document.hidden) return;
      setReadState(scopeType, scopeId, last.id);
      api.markRead(scopeType, scopeId, last.id).catch(() => {});
    }, 400);
  }

  msgsEl.addEventListener('scroll', () => {
    const nearBottom = msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 80;
    stickToBottom = nearBottom && isLatest;
    jumpEl.hidden = nearBottom && isLatest;
    if (nearBottom) markReadSoon();
    if (msgsEl.scrollTop < 120) loadOlder();
    else if (nearBottom && !isLatest) loadNewer();
  });
  // A window opened around an old message ("jump to result") is not the latest page: the jump
  // button reloads the real latest messages instead of just scrolling this window.
  jumpEl.addEventListener('click', async () => {
    if (isLatest) return scrollBottom();
    params = { ...params, jumpToMessageId: undefined };
    try { await loadInitial(); } catch (err) { handleError(err, 'm.loadFailed'); }
  });

  // ---------- live ----------
  const belongs = (p) => p.scopeType === scopeType && String(p.scopeId) === String(scopeId);
  const enqueue = (fn) => { queue = queue.then(fn).catch(() => {}); };
  offs.push(bus.on('ws:message_create', ({ message }) => enqueue(async () => {
    if (destroyed || !belongs(message) || messages.some((m) => m.id === message.id)) return;
    if (!isLatest) { jumpEl.hidden = false; return; } // would sit after a gap; the jump button reloads the latest page
    if (deleted.has(message.id)) return;
    await decryptList([message]);
    pending = dropMatchingPending(pending, message, state.me.id, state.config.maxMessageChars);
    messages = mergeMessages(messages, [message], deleted);
    if (messages.length > MAX_WINDOW && stickToBottom) { messages = messages.slice(-MAX_WINDOW); atStart = false; }
    typing.delete(message.author.id);
    paint(); paintTyping();
    if (stickToBottom) scrollBottom();
    markReadSoon();
  })));
  offs.push(bus.on('ws:message_update', ({ message }) => enqueue(async () => {
    if (destroyed || !belongs(message)) return;
    const current = messages.find((m) => m.id === message.id);
    if (!current) return;
    // Decrypt a copy and swap it in afterwards, so the list never holds fresh ciphertext mid-await.
    const [next] = applyUpdate([current], message);
    await decryptList([next]);
    const keep = msgsEl.scrollTop;
    messages = messages.map((m) => (m.id === next.id ? next : m));
    paint(); msgsEl.scrollTop = keep;
  })));
  offs.push(bus.on('ws:ephemeral_message', ({ message: e }) => {
    if (destroyed || kind !== 'channel' || e.scopeType !== 'channel' || e.scopeId !== scopeId) return;
    ephemerals.push(e);
    paint();
    if (stickToBottom) scrollBottom();
  }));
  offs.push(bus.on('ws:message_delete', (p) => enqueue(async () => {
    if (destroyed || !belongs(p)) return;
    deleted.add(p.messageId);
    const keep = msgsEl.scrollTop;
    messages = applyDelete(messages, p.messageId);
    paint(); msgsEl.scrollTop = keep;
  })));
  offs.push(bus.on('ws:typing', (p) => {
    if (!belongs(p) || p.userId === state.me.id) return;
    typing.set(p.userId, Date.now() + 6000);
    paintTyping();
    setTimeout(paintTyping, 6100);
  }));
  offs.push(bus.on('ws:thread_delete', ({ threadId }) => { if (kind === 'thread' && threadId === params.threadId) nav.back(); }));
  offs.push(bus.on('state:connection', (ok) => {
    if (!ok) return;
    enqueue(async () => {
      if (!isLatest) return;
      const res = await scope.list({ limit: PAGE });
      messages = reconcileLatest(messages, await decryptList(res.messages), PAGE);
      for (const id of deleted) messages = applyDelete(messages, id);
      paint();
      if (stickToBottom) scrollBottom();
    });
  }));
  function paintTyping() {
    const now = Date.now();
    const names = [...typing].filter(([, until]) => until > now).map(([id]) => getKnownUser(id)).filter(Boolean).map((u) => nameFor(u));
    el.querySelector('#m-typing').textContent = names.length === 1 ? t('m.typingOne', { name: names[0] }) : names.length > 1 ? t('m.typingMany') : '';
  }

  // ---------- sending ----------
  async function sendEncrypted(text, replyToMessageId, files = []) {
    const d = dm();
    const metas = [];
    try {
      for (const f of files) metas.push(await uploadDmFile(d.id, f));
      const { content, plaintextObj } = await encryptForSend(d, state.me, text, null, metas);
      const res = await api.sendEncryptedDmMessage(d.id, { content, replyToMessageId, fileIds: metas.length ? metas.map((m) => m.id) : undefined });
      await cacheSentPlaintext(state.me.id, res.message.id, plaintextObj);
      Object.assign(res.message, { content: plaintextObj.text, embed: plaintextObj.embed, e2eeFiles: metas, decryptFailed: false });
      files.forEach((file, i) => { if (e2eeFileKind(metas[i]) === 'image') e2eeUrls.set(metas[i].id, Promise.resolve(URL.createObjectURL(file))); });
      return res;
    } catch (err) {
      for (const m of metas) api.deleteDmFile(d.id, m.id).catch(() => {});
      throw err;
    }
  }

  async function deliver(p) {
    try {
      const res = encrypted() ? await sendEncrypted(p.text, p.replyToMessageId, p.files)
        : await scope.send({ content: p.text, files: p.files, replyToMessageId: p.replyToMessageId, voiceDurationMs: p.voiceDurationMs });
      pending = pending.filter((x) => x.key !== p.key);
      if (!isLatest) { params = { ...params, jumpToMessageId: undefined }; await loadInitial(); return; }
      if (!messages.some((m) => m.id === res.message.id)) messages = mergeMessages(messages, [res.message], deleted);
      paint(); scrollBottom(); markReadSoon();
    } catch (err) {
      if (err && err.status === 401) { bus.emit('m:unauthorized'); return; }
      p.failed = true;
      p.error = err.message === KEY_CHANGED ? t('dmVerify.sendBlocked') : err.message === NO_IDENTITY ? t('dmEncryption.needPassport') : null;
      paint(); scrollBottom();
    }
  }

  const ctxForSheets = () => ({ kind, scopeType, scopeId, params, detail, channel, thread, canSend, canManage, dm: dm(), composer, scrollToMessage });

  async function boot() {
    let info;
    try { info = await resolveContext(); } catch (err) { handleError(err, 'm.loadFailed'); nav.back(); return; }
    if (destroyed) return;
    composer = mountComposer(el.querySelector('#m-composer-host'), {
      placeholder: info.placeholder, canSend, readOnlyText: thread?.archived ? t('m.threadArchived') : t('m.readOnly'),
      attachEnabled: true,
      onInput: paintHints,
      onEmoji: () => openEmojiSheet(detail?.customEmoji || []),
      onSend: async ({ text, files }) => {
        if (!files.length && text.startsWith('/')) {
          const handled = await runSlash(text);
          if (typeof handled === 'string') text = handled;
          else if (handled !== null) return handled;
        }
        if (text.length > (encrypted() ? 4000 : state.config.maxMessageChars || 15000)) {
          if (textByteLength(text) > MAX_TEXT_FILE_BYTES) { toast(t('chat.tooLargeForFile', { kb: Math.round(MAX_TEXT_FILE_BYTES / 1024) }), { type: 'error' }); return false; }
          const name = await promptSheet({ title: t('chat.longAsFileTitle'), placeholder: t('chat.longAsFilePlaceholder'), okLabel: t('chat.longAsFileConfirm'), allowEmpty: true });
          if (name === null) return false;
          files = [...files, textToFile(text, name)];
          text = '';
        }
        const p = { key: `${Date.now()}${Math.random().toString(36).slice(2, 6)}`, text, files, replyToMessageId: composer.getReply()?.id };
        pending.push(p); paint(); scrollBottom();
        deliver(p);
        return true;
      },
      onEdit: async (msg, text) => { try { await api.editMessage(msg.id, text); return true; } catch (err) { handleError(err); return false; } },
      onVoice: encrypted() ? null : async ({ file, durationMs, replyToMessageId }) => {
        const p = { key: `${Date.now()}${Math.random().toString(36).slice(2, 6)}`, text: '', files: [file], voiceDurationMs: durationMs, replyToMessageId };
        pending.push(p); paint(); scrollBottom();
        deliver(p);
      },
      onTyping: kind === 'thread' ? null : () => ws.sendTyping(scopeType, scopeId),
      onSchedule: encrypted() ? null : async ({ text, replyToMessageId }) => {
        const at = await pickSendTime();
        if (!at) return false;
        try {
          await api.createScheduled({ scopeType, scopeId, content: text, sendAt: at.toISOString(), replyToMessageId });
          toast(t('m.scheduledFor', { when: at.toLocaleString() }));
          return true;
        } catch (err) { handleError(err, 'm.scheduleFailed'); return false; }
      },
      onPoll: encrypted() ? null : () => openPollSheet(ctxForSheets()),
      onSticker: kind === 'channel' && detail?.stickers?.length ? async () => {
        const id = await openStickerSheet(ctxForSheets());
        if (id) { try { await api.sendChannelMessage(params.serverId, params.channelId, { content: '', stickerId: id }); } catch (err) { handleError(err); } }
      } : null,
    });
    paintHeaderActions();
    if (kind === 'channel') api.listServerCommands(params.serverId).then((r) => { botCommands = r.commands || []; }).catch(() => {});
    await loadGated();
  }

  async function loadGated() {
    const host = el.querySelector('#m-composer-host');
    try { await loadInitial(); host.hidden = false; } catch (err) {
      if (!isAgeGateError(err)) throw err;
      host.hidden = true;
      renderAgeGate(msgsEl, { channelName: channel?.name, onConfirmed: () => { msgsEl.innerHTML = ''; loadGated().catch((e) => handleError(e, 'm.loadFailed')); }, onLeave: () => nav.back() });
    }
  }

  // ---------- bot slash commands ----------
  const slashEl = el.querySelector('#m-slash');
  const botCommandsByName = () => {
    const counts = new Map();
    for (const c of botCommands) counts.set(c.name, (counts.get(c.name) || 0) + 1);
    return botCommands.map((c) => ({ ...c, typed: counts.get(c.name) > 1 ? `${c.name}@${c.botUsername}` : c.name }));
  };
  // ":smi" at the end of the draft suggests custom and shortcode emoji, like the desktop composer popup.
  function emojiCandidates(q) {
    const out = [];
    const taken = new Set();
    for (const e of detail?.customEmoji || []) {
      taken.add(e.name.toLowerCase());
      out.push({ label: e.name, image: e.image_path, insert: `:${e.name}:` });
    }
    for (const [name, glyph] of Object.entries(EMOJI_SHORTCODES)) if (!taken.has(name)) out.push({ label: name, glyph, insert: glyph });
    const l = (c) => c.label.toLowerCase();
    return [...out.filter((c) => l(c).startsWith(q)), ...out.filter((c) => !l(c).startsWith(q) && l(c).includes(q))].slice(0, 10);
  }
  function paintHints(value) {
    const em = /(?:^|\s):([a-zA-Z0-9_]{2,})$/.exec(value || '');
    if (em) {
      const list = emojiCandidates(em[1].toLowerCase());
      slashEl.hidden = !list.length;
      slashEl.innerHTML = list.map((c) => `<button type="button" class="m-slash-item m-emoji-cand" data-emoji="${escapeAttr(c.insert)}">${c.image ? `<img class="custom-emoji" src="${escapeAttr(c.image)}" alt="">` : c.glyph}<span>${escapeAttr(c.label)}</span></button>`).join('');
      return;
    }
    paintSlash(value);
  }
  // Built-ins first; a bot command sharing a built-in's name is hidden, like the desktop picker.
  function slashCandidates() {
    const builtIn = builtinSlashCommands().map((c) => ({ typed: c.name, usage: c.usage, description: c.description }));
    if (kind !== 'channel') return builtIn;
    const taken = new Set(builtIn.map((c) => c.typed));
    const bots = botCommandsByName().filter((c) => !taken.has(c.typed)).map((c) => ({ typed: c.typed, usage: usageOf(c), description: c.description || c.botName }));
    return [...builtIn, ...bots];
  }
  function paintSlash(value) {
    const m = /^\/([a-zA-Z0-9_@.-]*)$/.exec(value || '');
    const list = m ? slashCandidates().filter((c) => c.typed.startsWith(m[1].toLowerCase())) : [];
    slashEl.hidden = !list.length;
    slashEl.innerHTML = list.map((c) => `<button type="button" class="m-slash-item" data-slash="${escapeAttr(c.typed)}"><b>${escapeAttr(c.usage)}</b><span>${escapeAttr(c.description)}</span></button>`).join('');
    slashEl.scrollLeft = 0;
  }
  const escapeAttr = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  slashEl.addEventListener('click', (e) => {
    const em = e.target.closest('[data-emoji]');
    if (em && composer) {
      const cur = composer.getText();
      composer.setText(cur.replace(/:[a-zA-Z0-9_]{2,}$/, em.dataset.emoji) + ' ');
      return;
    }
    const b = e.target.closest('[data-slash]');
    if (b && composer) composer.setText(`/${b.dataset.slash} `);
  });
  async function runBuiltinSlash(cmd, rest) {
    const serverScoped = kind !== 'dm';
    switch (cmd) {
      case 'afk':
        try {
          await api.setStatus({ status: 'idle', customStatusText: rest || 'AFK' });
          state.me.status = 'idle';
          state.me.customStatusText = rest || 'AFK';
          bus.emit('state:me');
          toast(rest ? t('chat.nowAfkWithMessage', { message: rest }) : t('chat.nowAfk'));
        } catch (err) { handleError(err, 'chat.couldNotSetAfkError'); }
        return true;
      case 'help':
        openSheet({
          title: t('chat.commandsShortcutsTitle'),
          html: `<div class="m-help-cmds">${builtinSlashCommands().map((c) => `<div class="m-help-cmd"><b>${escapeAttr(c.usage)}</b><span>${escapeAttr(c.description)}</span></div>`).join('')}</div>`,
        });
        return true;
      case 'invite': {
        if (!serverScoped) { toast(t('chat.inviteOnlyInChannelError')); return true; }
        const code = detail?.server?.invite_code;
        if (!code) { toast(t('chat.couldNotOpenInviteError'), { type: 'error' }); return true; }
        await copyText(code); toast(t('m.copied'));
        return true;
      }
      case 'ping': {
        const start = performance.now();
        try { await api.config(); } catch (err) { handleError(err, 'chat.pingFailedError'); return true; }
        return t('chat.pongMessage', { ms: Math.round(performance.now() - start) });
      }
      case 'dm': case 'msg': {
        const sp = rest.indexOf(' ');
        const username = (sp === -1 ? rest : rest.slice(0, sp)).replace(/^@/, '');
        const initial = sp === -1 ? '' : rest.slice(sp + 1).trim();
        if (!username) { toast(t('chat.dmUsageError', { cmd: `/${cmd}` }), { type: 'error' }); return true; }
        try {
          const { users } = await api.searchUsers(username);
          const target = users.find((u) => u.username.toLowerCase() === username.toLowerCase()) || (users.length === 1 ? users[0] : null);
          if (!target) { toast(t('chat.noUserFoundError', { username }), { type: 'error' }); return true; }
          if (initial) { const { dmId } = await api.openDm(target.id); await api.sendDmMessage(dmId, { content: initial }); }
          await openDmWith(target.id);
        } catch (err) { handleError(err, 'chat.couldNotStartDmError'); }
        return true;
      }
      case 'thread':
        if (kind !== 'channel') { toast(t('chat.threadOnlyInChannelError')); return true; }
        if (!rest) { toast(t('chat.threadUsageError'), { type: 'error' }); return true; }
        try {
          const res = await api.createThread(params.serverId, params.channelId, { title: rest.slice(0, 100), content: t('chat.threadStartedTemplate', { text: rest }) });
          nav.push('chat', { kind: 'thread', serverId: params.serverId, channelId: params.channelId, threadId: res.thread.id });
        } catch (err) { handleError(err, 'chat.couldNotCreateThreadError'); }
        return true;
      case 'nick':
        if (!serverScoped) { toast(t('chat.nickOnlyInChannelError')); return true; }
        try {
          await api.setNickname(params.serverId, state.me.id, rest || null);
          toast(rest ? t('chat.nicknameSetToast', { name: rest }) : t('chat.nicknameClearedToast'));
        } catch (err) { handleError(err, 'chat.couldNotChangeNicknameError'); }
        return true;
      case 'topic':
        if (kind !== 'channel') { toast(t('chat.topicOnlyInChannelError')); return true; }
        try {
          await api.updateChannel(params.serverId, params.channelId, { topic: rest });
          toast(rest ? t('chat.topicUpdatedToast') : t('chat.topicClearedToast'));
        } catch (err) { handleError(err, 'chat.couldNotChangeTopicError'); }
        return true;
      case 'me': return rest ? `*${rest}*` : true;
      case 'spoiler': return rest ? `||${rest}||` : true;
      case 'shrug': return rest ? `${rest} ${SHRUG}` : SHRUG;
      case 'tableflip': return rest ? `${rest} (╯°□°)╯︵ ┻━┻` : '(╯°□°)╯︵ ┻━┻';
      case 'unflip': return rest ? `${rest} ┬─┬ ノ( ゜-゜ノ)` : '┬─┬ ノ( ゜-゜ノ)';
      default: return null;
    }
  }
  // null = not a command, send it as a normal message; true/false = handled (false keeps the text);
  // a string = the built-in rewrote the draft into the message to send instead.
  async function runSlash(text) {
    const sp = text.indexOf(' ');
    const typed = (sp === -1 ? text.slice(1) : text.slice(1, sp)).toLowerCase();
    const builtin = await runBuiltinSlash(typed, sp === -1 ? '' : text.slice(sp + 1).trim());
    if (builtin !== null) return builtin;
    if (kind !== 'channel') return null;
    const def = botCommandsByName().find((c) => c.typed === typed);
    if (!def) return null;
    const options = parseInvocation(def, sp === -1 ? '' : text.slice(sp + 1));
    const missing = missingRequired(def, options);
    if (missing) { toast(t('slash.missingOption', { name: missing, usage: usageOf(def) }), { type: 'error' }); return false; }
    try { await api.invokeCommand(params.serverId, { channelId: params.channelId, botId: def.botId, command: def.name, options }); slashEl.hidden = true; return true; }
    catch (err) { handleError(err, 'slash.invokeFailed'); return false; }
  }

  function paintHeaderActions() {
    const box = el.querySelector('#m-actions');
    box.innerHTML = `<button class="m-icon-btn" id="m-search" aria-label="${t('m.searchAction')}">${icons.search(20)}</button>`
      + (kind === 'dm' ? `<button class="m-icon-btn" id="m-call" aria-label="${t('m.callAction')}">${icons.phone(20)}</button>` : '')
      + (kind === 'channel' ? `<button class="m-icon-btn" id="m-threads" aria-label="${t('m.threads')}">${icons.messageSquare(20)}</button>` : '')
      + (kind === 'dm' && encrypted() && !dm().isGroup ? `<button class="m-icon-btn" id="m-verify" aria-label="${t('dmVerify.title')}">${icons.lock(20)}</button>` : '')
      + `<button class="m-icon-btn" id="m-info" aria-label="${t('m.infoMembers')}">${icons.users(20)}</button>`;
    box.querySelector('#m-call')?.addEventListener('click', () => nav.push('voice', { kind: 'dm', dmId: params.dmId }));
    box.querySelector('#m-verify')?.addEventListener('click', () => openVerifySheet(dm()));
    box.querySelector('#m-search').addEventListener('click', () => nav.push('search', { serverId: params.serverId, channelId: params.channelId, dmId: params.dmId }));
    box.querySelector('#m-threads')?.addEventListener('click', () => nav.push('threads', { serverId: params.serverId, channelId: params.channelId }));
    box.querySelector('#m-info').addEventListener('click', () => nav.push('info', { kind, serverId: params.serverId, channelId: params.channelId, dmId: params.dmId, threadId: params.threadId }));
  }

  // ---------- interaction ----------
  const findMsg = (node) => messages.find((m) => m.id === Number(node.closest('[data-id]')?.dataset.id));
  msgsEl.addEventListener('click', async (e) => {
    const img = e.target.closest('[data-viewer]');
    if (img) return openImageViewer(img.dataset.viewer);
    const goto = e.target.closest('[data-goto]');
    if (goto) { const id = Number(goto.dataset.goto); if (!scrollToMessage(id)) { params = { ...params, jumpToMessageId: id }; await loadInitial(); } return; }
    const user = e.target.closest('[data-user]');
    if (user) return openProfileSheet(Number(user.dataset.user), { serverId: params.serverId });
    const eph = e.target.closest('[data-eph-dismiss]');
    if (eph) { e.preventDefault(); const at = ephemerals.findIndex((x) => x.id === eph.dataset.ephDismiss); if (at !== -1) { ephemerals.splice(at, 1); paint(); } return; }
    const retry = e.target.closest('[data-retry]');
    if (retry) { const p = pending.find((x) => x.key === retry.dataset.retry); if (p) { p.failed = false; paint(); deliver(p); } return; }
    const cancel = e.target.closest('[data-cancel]');
    if (cancel) { pending = pending.filter((x) => x.key !== cancel.dataset.cancel); paint(); return; }
    const dl = e.target.closest('[data-e2ee-dl]');
    if (dl) { const f = findE2eeFile(dl.dataset.e2eeDl); if (f) downloadEncryptedFile(f); return; }
    const react = e.target.closest('[data-react]');
    const msg = findMsg(e.target);
    if (react && msg) {
      const mine = msg.reactions.find((r) => r.emoji === react.dataset.react)?.userIds.includes(state.me.id);
      try { await (mine ? api.removeReaction(msg.id, react.dataset.react) : api.addReaction(msg.id, react.dataset.react)); } catch (err) { handleError(err); }
      return;
    }
    if (msg) onPollClick(e.target, msg);
  });
  onLongPress(msgsEl, '.m-msg[data-id]', (node) => { const msg = findMsg(node); if (msg) openMessageSheet(msg, ctxForSheets()); });
  let swipe = null;
  msgsEl.addEventListener('touchstart', (e) => { const n = e.target.closest('.m-msg[data-id]'); swipe = n ? { n, x: e.touches[0].clientX, y: e.touches[0].clientY } : null; }, { passive: true });
  msgsEl.addEventListener('touchend', (e) => {
    if (!swipe) return;
    const dx = e.changedTouches[0].clientX - swipe.x;
    const dy = Math.abs(e.changedTouches[0].clientY - swipe.y);
    const msg = findMsg(swipe.n);
    swipe = null;
    if (msg && dx < -70 && dy < 30 && canSend) composer.setReply(msg);
  }, { passive: true });

  // Encrypted 1:1 DM: surface a changed peer key as a banner with a Review button.
  const bannerEl = el.querySelector('#m-e2ee');
  function paintBanner() {
    const view = kind === 'dm' && encrypted() ? trustView(params.dmId) : null;
    bannerEl.hidden = !view || view.status !== 'changed';
    if (!bannerEl.hidden) bannerEl.innerHTML = `<span>${t('dmVerify.changedTitle')}</span><button class="btn btn-secondary" data-review>${t('dmVerify.review')}</button>`;
  }
  bannerEl.addEventListener('click', (e) => { if (e.target.closest('[data-review]')) openVerifySheet(dm()); });
  offs.push(bus.on('e2ee:trust', ({ dmId }) => { if (dmId === params.dmId) paintBanner(); }));

  state.mOpenScope = scopeKey;
  boot().then(() => { if (kind === 'dm' && encrypted()) refreshTrust(dm(), state.me).then(paintBanner).catch(() => {}); });
  return {
    destroy() { destroyed = true; clearTimeout(readTimer); for (const p of e2eeUrls.values()) p.then((url) => url && URL.revokeObjectURL(url)); offs.forEach((off) => off()); if (state.mOpenScope === scopeKey) state.mOpenScope = null; },
    onShow() { state.mOpenScope = scopeKey; markReadSoon(); },
    onHide() { if (state.mOpenScope === scopeKey) state.mOpenScope = null; },
  };
}
