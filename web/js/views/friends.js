import { bus } from '../bus.js';
import { api } from '../api.js';
import { state, presenceFor, nameFor } from '../state.js';
import { icons } from '../icons.js';
import { avatarHtml, escapeHtml, toast, apiErrorMessage, el, debounce } from '../utils.js';
import { t } from '../i18n.js';
import { openContextMenu } from './modal.js';
import { userActionItems } from './userMenu.js';
import { openFullProfile } from './fullProfile.js';

// A function (not a module-level constant) so the labels re-evaluate against the current
// language — see userBar.js's statusOptions() for why a plain top-level array would freeze.
function tabs() {
  return [
    { id: 'online', label: t('friends.tabOnline') },
    { id: 'all', label: t('friends.tabAll') },
    { id: 'pending', label: t('friends.tabPending') },
    { id: 'blocked', label: t('friends.tabBlocked') },
    { id: 'add', label: t('friends.tabAddFriend'), cta: true },
  ];
}

export function mountFriends(container, initialTab = 'online') {
  let tab = initialTab;

  render();
  const off = bus.on('state:friends', render);
  const offAnn = bus.on('state:annotations', render);
  const offPresence = bus.on('state:presence', render);

  async function refresh() {
    try {
      const res = await api.friends();
      state.friends = res;
      bus.emit('state:friends');
    } catch { /* silent */ }
  }
  refresh();

  function render() {
    container.innerHTML = `
      <div class="friends-header">
        <span class="ft-icon">${icons.users(22)}</span>
        <div class="friends-tabs">
          ${tabs().map((tb) => `<button class="friends-tab ${tb.cta ? 'cta' : ''} ${tab === tb.id ? 'active' : ''}" data-tab="${tb.id}">${escapeHtml(tb.label)}</button>`).join('')}
        </div>
      </div>
      <div class="friends-body" id="friends-body"></div>`;

    container.querySelectorAll('[data-tab]').forEach((btn) => {
      btn.addEventListener('click', () => { tab = btn.dataset.tab; render(); });
    });

    const body = container.querySelector('#friends-body');
    if (tab === 'add') return renderAddFriend(body);
    if (tab === 'pending') return renderPending(body);
    if (tab === 'blocked') return renderBlocked(body);
    return renderFriendsList(body, tab === 'online');
  }

  function renderFriendsList(body, onlineOnly) {
    let list = state.friends.friends.map((f) => ({ ...f, user: presenceFor(f.user) }));
    if (onlineOnly) list = list.filter((f) => f.user.status && f.user.status !== 'offline' && f.user.status !== 'invisible');
    body.innerHTML = `<div class="friends-count">${onlineOnly ? t('friends.tabOnline') : t('friends.countAllFriends')} — ${list.length}</div>`;
    if (list.length === 0) {
      body.insertAdjacentHTML('beforeend', emptyMsg(onlineOnly ? t('friends.noOnline') : t('friends.noFriends')));
      return;
    }
    for (const f of list) {
      const row = friendRow(f.user, [
        { label: t('friends.messageButton'), onClick: () => openDmWith(f.user.id) },
        { label: t('friends.removeButton'), danger: true, onClick: () => removeFriend(f.user.id) },
      ]);
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openContextMenu(e.clientX, e.clientY, userActionItems(f.user, { openProfile: (id) => openFullProfile(id), withMessage: true, withCall: true }));
      });
      row.querySelector('.fr-meta').addEventListener('click', () => openFullProfile(f.user.id));
      body.appendChild(row);
    }
  }

  function renderPending(body) {
    const list = state.friends.pending;
    body.innerHTML = `<div class="friends-count">${t('friends.tabPending')} — ${list.length}</div>`;
    if (list.length === 0) {
      body.insertAdjacentHTML('beforeend', emptyMsg(t('friends.noPending')));
      return;
    }
    for (const f of list) {
      const actions = f.direction === 'incoming'
        ? [
          { label: t('friends.acceptButton'), onClick: () => acceptFriend(f.user.id) },
          { label: t('friends.declineButton'), danger: true, onClick: () => removeFriend(f.user.id) },
        ]
        : [{ label: t('friends.cancelButton'), danger: true, onClick: () => removeFriend(f.user.id) }];
      body.appendChild(friendRow(f.user, actions, f.direction === 'incoming' ? t('friends.incomingRequestLabel') : t('friends.outgoingRequestLabel')));
    }
  }

  function renderBlocked(body) {
    const list = state.friends.blocked;
    body.innerHTML = `<div class="friends-count">${t('friends.tabBlocked')} — ${list.length}</div>`;
    if (list.length === 0) {
      body.insertAdjacentHTML('beforeend', emptyMsg(t('friends.noBlocked')));
      return;
    }
    for (const f of list) {
      body.appendChild(friendRow(f.user, [{ label: t('friends.unblockButton'), onClick: () => removeFriend(f.user.id) }]));
    }
  }

  function renderAddFriend(body) {
    body.innerHTML = `
      <div class="add-friend-box" style="padding-top:20px">
        <h3 style="margin:0 0 8px;font-size:16px">${t('friends.tabAddFriend')}</h3>
        <p style="color:var(--text-secondary);font-size:14px;margin:0 0 16px">${t('friends.addFriendHint')}</p>
        <div class="afb-input-row">
          <input type="text" id="af-input" placeholder="${t('friends.searchOrUsernamePlaceholder')}">
          <button class="btn btn-primary" id="af-send">${t('friends.sendRequestButton')}</button>
        </div>
        <div class="afb-msg" id="af-msg"></div>
        <div id="af-results" style="margin-top:12px"></div>
      </div>`;
    const input = body.querySelector('#af-input');
    const msg = body.querySelector('#af-msg');
    const results = body.querySelector('#af-results');

    const send = async (username) => {
      const name = username ?? input.value.trim();
      if (!name) return;
      msg.className = 'afb-msg';
      msg.textContent = '';
      try {
        await api.friendRequest(name);
        msg.className = 'afb-msg ok';
        msg.textContent = t('friends.requestSentMsg', { name });
        if (!username) input.value = '';
      } catch (err) {
        msg.className = 'afb-msg err';
        msg.textContent = apiErrorMessage(err, t('friends.sendRequestError'));
      }
    };
    body.querySelector('#af-send').addEventListener('click', () => send());
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });

    const runSearch = debounce(async () => {
      const q = input.value.trim();
      if (q.length < 2) { results.innerHTML = ''; return; }
      try {
        const res = await api.searchUsers(q);
        results.innerHTML = res.users.length === 0
          ? `<p style="color:var(--text-muted);font-size:13px">${t('friends.noMatchingUsers')}</p>`
          : '';
        for (const u of res.users) {
          const row = el(`
            <div class="list-row" data-uid="${u.id}">
              ${avatarHtml(u, 32)}
              <div class="lr-main"><div class="lr-title">${escapeHtml(u.displayName)}</div><div class="lr-sub">@${escapeHtml(u.username)}</div></div>
              <button class="btn btn-sm btn-secondary" data-add="${u.username}">${t('friends.addButton')}</button>
            </div>`);
          row.querySelector('[data-add]').addEventListener('click', () => send(u.username));
          results.appendChild(row);
        }
      } catch { /* search is a nicety, fail silently */ }
    }, 300);
    input.addEventListener('input', runSearch);
  }

  function friendRow(user, actions, subLabelOverride) {
    const status = user.status === 'invisible' ? 'offline' : (user.status || 'offline');
    const row = el(`
      <div class="friend-row" data-uid="${user.id}">
        <div class="avatar-wrap">
          ${avatarHtml(user, 40)}
          <div class="status-dot ${status}"></div>
        </div>
        <div class="fr-meta">
          <div class="fr-name">${escapeHtml(nameFor(user))}</div>
          <div class="fr-sub">${escapeHtml(subLabelOverride || `@${user.username}`)}</div>
        </div>
        <div class="fr-actions"></div>
      </div>`);
    const actionsEl = row.querySelector('.fr-actions');
    for (const a of actions) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-sm btn-secondary';
      btn.textContent = a.label;
      btn.title = a.label;
      btn.addEventListener('click', a.onClick);
      actionsEl.appendChild(btn);
    }
    return row;
  }

  function emptyMsg(text) {
    return `<div class="empty-state" style="padding-top:60px"><p>${escapeHtml(text)}</p></div>`;
  }

  async function openDmWith(userId) {
    try {
      const res = await api.openDm(userId);
      const dmsRes = await api.listDms();
      state.dms = dmsRes.dms;
      bus.emit('state:dms');
      bus.emit('ui:navigate', { type: 'dm', dmId: res.dmId });
    } catch (err) {
      toast(apiErrorMessage(err, t('friends.startConversationError')), { type: 'error' });
    }
  }

  async function acceptFriend(userId) {
    try { await api.friendAccept(userId); await refresh(); } catch (err) { toast(apiErrorMessage(err), { type: 'error' }); }
  }
  async function removeFriend(userId) {
    try { await api.friendRemove(userId); await refresh(); } catch (err) { toast(apiErrorMessage(err), { type: 'error' }); }
  }

  function destroy() { off(); offPresence(); offAnn(); }
  return { destroy };
}
