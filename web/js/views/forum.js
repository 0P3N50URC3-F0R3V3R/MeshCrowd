import { api } from '../api.js';
import { bus } from '../bus.js';
import { icons } from '../icons.js';
import { escapeHtml, apiErrorMessage, toast } from '../utils.js';
import { openModal } from './modal.js';
import { mountChat } from './chat.js';
import { forumCardHtml, matchesPost, sortPosts } from '../forumCard.js';
import { t } from '../i18n.js';
import { memberNameColor } from '../permissions.js';
import { state, threadUnread, getServerDetail, setReadState, isUnread, pinUnseen } from '../state.js';
import { markPinsSeen } from '../pinSeen.js';
import { mountPinnedPanel } from './pinnedPanel.js';
import { canEditPost, canDeletePost } from '../threadPerms.mjs';
import { editPost, deletePost } from './postActions.js';

// Discord-style forum channel: a list of titled posts (each its own thread) instead of one flat
// message log. Posting = creating a thread with a title + opening message.
export function mountForum(container, { serverId, channelId, channelName, canSend, canManage, channels, customEmoji, stickers, rawHtmlEnabled, roles = [], members = [] }) {
  const colorFor = (userId) => memberNameColor(roles, members.find((m) => m.user.id === userId));
  let posts = [];
  let loading = true;
  let query = '';
  let sort = 'activity';
  let openId = null;
  let openChat = null;
  let pinsPanel = null;

  container.innerHTML = `
    <div class="forum-split">
      <div class="forum-col">
        <div class="forum-toolbar">
          <div class="forum-search">${icons.search(16)}<input class="forum-search-input" id="forum-search" placeholder="${escapeHtml(t('forum.searchPlaceholder'))}" autocomplete="off"></div>
          ${canSend ? `<button class="btn btn-primary" id="forum-new-post">${icons.plus(16)} ${t('forum.newPostButton')}</button>` : ''}
        </div>
        <div class="forum-sortbar"><select class="forum-sort" id="forum-sort">
          <option value="activity">${t('forum.sortActivity')}</option><option value="newest">${t('forum.sortNewest')}</option></select></div>
        <div class="forum-list" id="forum-list"></div>
      </div>
      <div class="forum-pane" id="forum-pane" hidden></div>
    </div>`;

  container.querySelector('#forum-search').addEventListener('input', (e) => { query = e.target.value.trim(); render(); });
  container.querySelector('#forum-sort').addEventListener('change', (e) => { sort = e.target.value; render(); });

  container.querySelector('#forum-new-post')?.addEventListener('click', openNewPostModal);

  const offCreate = bus.on('ws:thread_create', ({ channelId: cid, thread }) => { if (cid === channelId) { upsert(thread); } });
  const offUpdate = bus.on('ws:thread_update', ({ channelId: cid, thread }) => {
    if (cid !== channelId) return;
    upsert(thread);
    if (openId === thread.id) container.querySelector('.fpane-title').textContent = thread.title;
  });
  const offDelete = bus.on('ws:thread_delete', ({ channelId: cid, threadId }) => {
    if (cid !== channelId) return;
    posts = posts.filter((p) => p.id !== threadId);
    if (openId === threadId) closePost(); else render();
  });
  const offMessage = bus.on('ws:message_create', ({ message }) => {
    if (message.scopeType !== 'thread') return;
    const post = posts.find((p) => p.id === message.scopeId);
    if (post) { post.messageCount += 1; post.lastMessageAt = message.createdAt; render(); }
  });

  // A forum never mounts a channel-level chat, so channel-scope messages here (system notices, forwards)
  // would otherwise stay unread forever.
  function markChannelRead() {
    const ch = getServerDetail(serverId)?.channels.find((c) => c.id === channelId);
    if (!ch?.last_message_id || !isUnread('channel', channelId, ch.last_message_id)) return;
    const id = ch.last_message_id;
    api.markRead('channel', channelId, id).then(() => setReadState('channel', channelId, id)).catch(() => {});
  }
  markChannelRead();
  const offChannelMsg = bus.on('ws:message_create', ({ message }) => {
    if (message.scopeType === 'channel' && message.scopeId === channelId) queueMicrotask(markChannelRead);
  });
  const offThreadsUnread = bus.on('state:threads', () => { if (!loading) render(); });

  load();

  async function load() {
    loading = true;
    render();
    try {
      posts = (await api.listThreads(serverId, channelId)).threads;
    } catch {
      posts = [];
    } finally {
      loading = false;
      render();
    }
  }

  function upsert(thread) {
    const idx = posts.findIndex((p) => p.id === thread.id);
    if (idx === -1) posts.unshift(thread);
    else posts[idx] = thread;
    render();
  }

  function render() {
    const listEl = container.querySelector('#forum-list');
    if (!listEl) return;
    if (loading) { listEl.innerHTML = `<div class="panel-loading"><div class="spinner"></div></div>`; return; }
    if (posts.length === 0) {
      listEl.innerHTML = `
        <div class="channel-intro">
          <div class="intro-icon">${icons.messageSquare(34)}</div>
          <h2>${t('forum.welcomeHeading', { channel: escapeHtml(channelName || t('forum.defaultChannelName')) })}</h2>
          <p>${canSend ? t('forum.noPostsStart') : t('forum.noPostsWait')}</p>
        </div>`;
      return;
    }
    const shown = sortPosts(posts.filter((p) => matchesPost(p, query)), sort);
    listEl.innerHTML = shown.map((p) => forumCardHtml(p, { customEmoji, active: p.id === openId, colorFor, canPin: canManage, unread: threadUnread(p.id) && p.id !== openId })).join('')
      || `<div class="forum-nomatch">${t('forum.noMatches')}</div>`;
    listEl.querySelectorAll('.forum-card').forEach((node) => {
      node.addEventListener('click', async (e) => {
        const pinBtn = e.target.closest('[data-pin]');
        if (pinBtn) {
          const id = Number(pinBtn.dataset.pin);
          try { await api.updateThread(serverId, channelId, id, { pinned: !posts.find((p) => p.id === id)?.pinned }); }
          catch (err) { toast(apiErrorMessage(err, t('forum.pinError'))); }
          return;
        }
        const post = posts.find((p) => p.id === Number(node.dataset.id));
        if (!post) return;
        if (container.clientWidth >= 820) openPost(post);
        else bus.emit('ui:navigate', { type: 'server', serverId, channelId, threadId: post.id });
      });
    });
  }

  function closePost() {
    openChat?.destroy?.();
    openChat = null;
    openId = null;
    state.openForumPostId = null;
    pinsPanel?.destroy?.();
    pinsPanel = null;
    const pane = container.querySelector('#forum-pane');
    pane.hidden = true;
    pane.innerHTML = '';
    render();
  }

  function mountPostChat(post, jumpToMessageId) {
    openChat?.destroy?.();
    openChat = mountChat(container.querySelector('#forum-pane-body'), {
      kind: 'thread', serverId, channelId, threadId: post.id, jumpToMessageId,
      canSend: canSend && !post.archived, canManage, channels, customEmoji, stickers, rawHtmlEnabled,
    }, { emptyTitle: t('shell.startOfThread'), emptyBody: '' });
  }

  function togglePins(post) {
    const pane = container.querySelector('#forum-pane');
    const existing = pane.querySelector('.forum-pins');
    if (existing) { pinsPanel?.destroy?.(); pinsPanel = null; existing.remove(); return; }
    const host = document.createElement('div');
    host.className = 'forum-pins';
    pane.appendChild(host);
    markPinsSeen('thread', post.id);
    const close =() => { pinsPanel?.destroy?.(); pinsPanel = null; host.remove(); };
    pinsPanel = mountPinnedPanel(host, 'thread', post.id, {
      canManage,
      onJump: (messageId) => { close(); mountPostChat(post, messageId); },
      onClose: close,
    });
  }

  function openPost(post) {
    openChat?.destroy?.();
    pinsPanel?.destroy?.();
    pinsPanel = null;
    openId = post.id;
    state.openForumPostId = post.id;
    const pane = container.querySelector('#forum-pane');
    pane.hidden = false;
    pane.innerHTML = `
      <div class="forum-pane-head"><span class="fpane-title">${escapeHtml(post.title)}</span>
        <button class="btn-icon" id="forum-pane-pins" title="${escapeHtml(t('shell.pinnedMessagesTitle'))}" aria-label="${escapeHtml(t('shell.pinnedMessagesTitle'))}">${icons.pin(16)}</button>
        ${canEditPost(post, state.me) ? `<button class="btn-icon" id="forum-pane-edit" title="${escapeHtml(t('forum.editPost'))}" aria-label="${escapeHtml(t('forum.editPost'))}">${icons.edit(16)}</button>` : ''}
        ${canDeletePost(post, state.me, { canManage }) ? `<button class="btn-icon" id="forum-pane-delete" title="${escapeHtml(t('forum.deletePost'))}" aria-label="${escapeHtml(t('forum.deletePost'))}" style="color:var(--danger)">${icons.trash(16)}</button>` : ''}
        <button class="btn-icon" id="forum-pane-close" aria-label="${t('common.close')}">${icons.x(18)}</button></div>
      ${post.archived ? `<div class="forum-locked">${t('forum.lockedNotice')}</div>` : ''}
      <div class="forum-pane-body" id="forum-pane-body"></div>`;
    pane.querySelector('#forum-pane-close').addEventListener('click', closePost);
    pane.querySelector('#forum-pane-edit')?.addEventListener('click', () => editPost(serverId, channelId, post.id));
    pane.querySelector('#forum-pane-delete')?.addEventListener('click', () => deletePost(serverId, channelId, post));
    const pinBtn = pane.querySelector('#forum-pane-pins');
    pinBtn.addEventListener('click', () => togglePins(post));
    const paintPinDot = () => pinBtn.classList.toggle('has-dot', pinUnseen('thread', post.id));
    paintPinDot();
    const offPins = bus.on('state:pins', () => {
      if (!pinBtn.isConnected) { offPins(); return; }
      if (pane.querySelector('.forum-pins')) markPinsSeen('thread', post.id);
      paintPinDot();
    });
    mountPostChat(post);
    render();
  }

  function openNewPostModal() {
    const m = openModal({
      title: t('forum.newPostButton'),
      render(body) {
        body.innerHTML = `
          <div class="field">
            <label for="fp-title">${t('forum.titleLabel')}</label>
            <input class="input" id="fp-title" maxlength="100" autofocus>
          </div>
          <div class="field">
            <label for="fp-content">${t('forum.messageLabel')}</label>
            <textarea class="input textarea" id="fp-content" rows="5"></textarea>
          </div>
          <div class="error-text" id="fp-error"></div>
          <button class="btn btn-primary" id="fp-submit">${t('forum.createPostButton')}</button>`;
        body.querySelector('#fp-submit').addEventListener('click', async () => {
          const title = body.querySelector('#fp-title').value.trim();
          const content = body.querySelector('#fp-content').value.trim();
          if (!title || !content) { body.querySelector('#fp-error').textContent = t('forum.titleAndMessageRequired'); return; }
          try {
            const res = await api.createThread(serverId, channelId, { title, content });
            m.close();
            upsert(res.thread);
            if (container.clientWidth >= 820) openPost(res.thread);
            else bus.emit('ui:navigate', { type: 'server', serverId, channelId, threadId: res.thread.id });
          } catch (err) { body.querySelector('#fp-error').textContent = apiErrorMessage(err, t('forum.createError')); }
        });
      },
    });
  }

  function destroy() {
    offCreate(); offUpdate(); offDelete(); offMessage(); offThreadsUnread(); offChannelMsg();
    openChat?.destroy?.();
    pinsPanel?.destroy?.();
    if (state.openForumPostId === openId) state.openForumPostId = null;
  }

  return { destroy };
}
