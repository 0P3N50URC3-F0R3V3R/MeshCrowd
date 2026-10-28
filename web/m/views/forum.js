import { api } from '../../js/api.js';
import { bus } from '../../js/bus.js';
import { icons } from '../../js/icons.js';
import { t } from '../../js/i18n.js';
import { escapeHtml, apiErrorMessage, toast } from '../../js/utils.js';
import { forumCardHtml, matchesPost, sortPosts } from '../../js/forumCard.js';
import { state } from '../../js/state.js';
import { PERMISSIONS, has, memberPermissionBits, channelPermissionBits, memberNameColor } from '../../js/permissions.js';
import { nav } from '../router.js';
import { ensureServerDetail } from '../data.js';
import { handleError } from '../lib/errors.js';
import { openSheet } from '../components/bottomSheet.js';

// Forum channel: a list of titled posts, each one a thread. Opening a post pushes the thread chat.
export function mountForum(el, params) {
  const { serverId, channelId } = params;
  let posts = [];
  let canSend = false;
  let loading = true;
  let name = '';
  let query = '';
  let sort = 'activity';
  let customEmoji = [];
  let canPin = false;
  let colorFor = () => null;

  el.innerHTML = `<div class="m-header"><button class="m-icon-btn" id="m-back" aria-label="${t('m.back')}">${icons.arrowLeft(22)}</button>
    <h1 id="m-title"></h1><button class="m-icon-btn" id="m-new" aria-label="${t('forum.newPostButton')}" hidden>${icons.plus(22)}</button></div>
    <div class="m-forum-tools"><div class="forum-search">${icons.search(16)}<input class="forum-search-input" id="m-fsearch" placeholder="${escapeHtml(t('forum.searchPlaceholder'))}" autocomplete="off" enterkeyhint="search"></div>
      <select class="forum-sort" id="m-fsort"><option value="activity">${t('forum.sortActivity')}</option><option value="newest">${t('forum.sortNewest')}</option></select></div>
    <div class="m-scroll m-forum-list" id="m-list"></div>`;
  const list = el.querySelector('#m-list');
  el.querySelector('#m-back').addEventListener('click', () => nav.back());
  el.querySelector('#m-fsearch').addEventListener('input', (e) => { query = e.target.value.trim(); paint(); });
  el.querySelector('#m-fsort').addEventListener('change', (e) => { sort = e.target.value; paint(); });

  function paint() {
    if (loading) { list.innerHTML = `<div class="m-empty">${t('m.loading')}</div>`; return; }
    if (!posts.length) {
      list.innerHTML = `<div class="m-empty"><h2>${t('forum.welcomeHeading', { channel: escapeHtml(name) })}</h2>
        <p>${canSend ? t('forum.noPostsStart') : t('forum.noPostsWait')}</p></div>`;
      return;
    }
    const shown = sortPosts(posts.filter((p) => matchesPost(p, query)), sort);
    list.innerHTML = shown.map((p) => forumCardHtml(p, { customEmoji, tag: 'button', colorFor, canPin })).join('')
      || `<div class="m-empty">${t('forum.noMatches')}</div>`;
  }

  function upsert(thread) {
    const i = posts.findIndex((p) => p.id === thread.id);
    if (i === -1) posts.unshift(thread); else posts[i] = thread;
    paint();
  }

  async function load() {
    try {
      const detail = await ensureServerDetail(serverId);
      const channel = detail.channels.find((c) => c.id === channelId);
      name = channel?.name || '';
      customEmoji = detail.customEmoji || [];
      el.querySelector('#m-title').textContent = name;
      const isOwner = detail.server.owner_id === state.me.id;
      const me = detail.members.find((m) => m.user.id === state.me.id);
      const memberBits = memberPermissionBits(detail.server, detail.roles, me, state.me.id);
      canSend = has(channelPermissionBits(channel, detail.roles, me, memberBits, isOwner), PERMISSIONS.SEND_MESSAGES)
        && !(me?.timeoutUntil && new Date(me.timeoutUntil) > new Date());
      el.querySelector('#m-new').hidden = !canSend;
      const chBits = channelPermissionBits(channel, detail.roles, me, memberBits, isOwner);
      canPin = has(chBits, PERMISSIONS.MANAGE_MESSAGES);
      colorFor = (userId) => memberNameColor(detail.roles, detail.members.find((m) => m.user.id === userId));
      posts = (await api.listThreads(serverId, channelId)).threads;
    } catch (err) { handleError(err, 'm.loadFailed'); posts = []; }
    loading = false;
    paint();
  }

  function openNewPost() {
    openSheet({
      title: t('forum.newPostButton'),
      html: `<label class="m-label" for="fp-title">${t('forum.titleLabel')}</label>
        <input class="m-input" id="fp-title" maxlength="100" autocomplete="off" enterkeyhint="next">
        <label class="m-label" for="fp-content" style="margin-top:12px">${t('forum.messageLabel')}</label>
        <textarea class="m-input" id="fp-content" rows="5"></textarea>
        <div class="m-error" id="fp-error"></div>
        <div class="m-confirm-row" style="margin-top:12px"><button class="btn btn-secondary" data-no>${t('m.cancel')}</button>
          <button class="btn btn-primary" data-yes>${t('forum.createPostButton')}</button></div>`,
      onMount: (body, close) => {
        body.querySelector('[data-no]').addEventListener('click', close);
        body.querySelector('[data-yes]').addEventListener('click', async (e) => {
          const title = body.querySelector('#fp-title').value.trim();
          const content = body.querySelector('#fp-content').value.trim();
          const err = body.querySelector('#fp-error');
          if (!title || !content) { err.textContent = t('forum.titleAndMessageRequired'); return; }
          e.currentTarget.disabled = true;
          try {
            const res = await api.createThread(serverId, channelId, { title, content });
            close();
            upsert(res.thread);
            nav.push('chat', { kind: 'thread', serverId, channelId, threadId: res.thread.id });
          } catch (error) { err.textContent = apiErrorMessage(error, t('forum.createError')); e.currentTarget.disabled = false; }
        });
        setTimeout(() => body.querySelector('#fp-title').focus(), 250);
      },
    });
  }

  list.addEventListener('click', async (e) => {
    const pinBtn = e.target.closest('[data-pin]');
    if (pinBtn) {
      const id = Number(pinBtn.dataset.pin);
      try { await api.updateThread(serverId, channelId, id, { pinned: !posts.find((p) => p.id === id)?.pinned }); }
      catch (err) { toast(apiErrorMessage(err, t('forum.pinError')), { type: 'error' }); }
      return;
    }
    const row = e.target.closest('[data-id]');
    if (row) nav.push('chat', { kind: 'thread', serverId, channelId, threadId: Number(row.dataset.id) });
  });
  el.querySelector('#m-new').addEventListener('click', openNewPost);

  const offs = [
    bus.on('ws:thread_create', (p) => { if (p.channelId === channelId) upsert(p.thread); }),
    bus.on('ws:thread_update', (p) => { if (p.channelId === channelId) upsert(p.thread); }),
    bus.on('ws:thread_delete', (p) => { if (p.channelId === channelId) { posts = posts.filter((x) => x.id !== p.threadId); paint(); } }),
    bus.on('ws:message_create', ({ message }) => {
      if (message.scopeType !== 'thread') return;
      const post = posts.find((x) => x.id === message.scopeId);
      if (post) { post.messageCount += 1; post.lastMessageAt = message.createdAt; paint(); }
    }),
  ];
  paint();
  load();
  return { destroy: () => offs.forEach((off) => off()), onShow: () => { if (!loading) load(); } };
}
