import { bus } from '../bus.js';
import { api } from '../api.js';
import { state, annotationFor, setUserAnnotation, setFriends, setNotificationPref } from '../state.js';
import { escapeHtml, toast, apiErrorMessage } from '../utils.js';
import { openModal, confirmModal } from './modal.js';
import { t } from '../i18n.js';

// Everything the right-click menus on a friend, a DM and a profile share: the private note and
// nickname editors, ignore/block/remove-friend, invite-to-server and calling. Callers build their
// own menu around userActionItems() and add what is specific to their surface.

async function refreshFriends() {
  try { setFriends(await api.friends()); } catch { /* the next friends refresh catches up */ }
}

export async function openDmWith(userId, extra = {}) {
  try {
    const res = await api.openDm(userId);
    state.dms = (await api.listDms()).dms;
    bus.emit('state:dms');
    bus.emit('ui:navigate', { type: 'dm', dmId: res.dmId, ...extra });
  } catch (err) {
    toast(apiErrorMessage(err, t('profile.cantMessageError')), { type: 'error' });
  }
}

export const startCallWith = (userId) => openDmWith(userId, { autoOpenCall: true });

async function saveAnnotation(userId, patch) {
  try {
    const res = await api.setUserAnnotation(userId, patch);
    setUserAnnotation(res.annotation);
    return true;
  } catch (err) {
    toast(apiErrorMessage(err, t('userMenu.couldNotSave')), { type: 'error' });
    return false;
  }
}

function openTextModal({ title, label, hint, value, maxLength, multiline, placeholder, onSave }) {
  const m = openModal({
    title,
    render(body) {
      body.innerHTML = `
        <div class="field">
          <label for="tm-input">${escapeHtml(label)}</label>
          ${multiline
            ? `<textarea class="input textarea" id="tm-input" rows="4" maxlength="${maxLength}" placeholder="${escapeHtml(placeholder || '')}">${escapeHtml(value || '')}</textarea>`
            : `<input class="input" id="tm-input" maxlength="${maxLength}" value="${escapeHtml(value || '')}" placeholder="${escapeHtml(placeholder || '')}">`}
          ${hint ? `<p style="color:var(--text-secondary);font-size:13px;margin:6px 0 0">${escapeHtml(hint)}</p>` : ''}
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button class="btn btn-ghost" id="tm-cancel">${t('common.cancel')}</button>
          <button class="btn btn-primary" id="tm-save">${t('serverRail.saveButton')}</button>
        </div>`;
      const input = body.querySelector('#tm-input');
      input.focus();
      body.querySelector('#tm-cancel').addEventListener('click', () => m.close());
      body.querySelector('#tm-save').addEventListener('click', async () => {
        if (await onSave(input.value.trim())) m.close();
      });
      if (!multiline) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') body.querySelector('#tm-save').click(); });
    },
  });
}

export function openNoteModal(user) {
  openTextModal({
    title: t('userMenu.noteModalTitle', { name: user.displayName }),
    label: t('userMenu.noteLabel'),
    hint: t('userMenu.noteSub'),
    value: annotationFor(user.id)?.note || '',
    maxLength: 256,
    multiline: true,
    onSave: (value) => saveAnnotation(user.id, { note: value || null }),
  });
}

export function openNicknameModal(user) {
  openTextModal({
    title: t('userMenu.nicknameModalTitle', { name: user.displayName }),
    label: t('userMenu.nicknameLabel'),
    hint: t('userMenu.nicknameHint'),
    value: annotationFor(user.id)?.nickname || '',
    maxLength: 32,
    placeholder: user.displayName,
    onSave: (value) => saveAnnotation(user.id, { nickname: value || null }),
  });
}

export async function setIgnored(user, ignored) {
  if (await saveAnnotation(user.id, { ignored })) toast(t(ignored ? 'profile.ignoredToast' : 'profile.unignoredToast'));
}

export function confirmBlock(user) {
  confirmModal({
    title: t('userMenu.blockConfirmTitle', { name: user.displayName }),
    message: t('userMenu.blockConfirmMessage', { name: escapeHtml(user.displayName) }),
    confirmLabel: t('userMenu.block'),
    onConfirm: async () => {
      try {
        await api.friendBlock(user.id);
        await refreshFriends();
        toast(t('userMenu.blockedToast'));
      } catch (err) { toast(apiErrorMessage(err), { type: 'error' }); }
    },
  });
}

export async function unblock(user) {
  try { await api.friendRemove(user.id); await refreshFriends(); toast(t('userMenu.unblockedToast')); } catch (err) { toast(apiErrorMessage(err), { type: 'error' }); }
}

export function confirmRemoveFriend(user) {
  confirmModal({
    title: t('userMenu.removeFriendConfirmTitle', { name: user.displayName }),
    message: t('userMenu.removeFriendConfirmMessage', { name: escapeHtml(user.displayName) }),
    confirmLabel: t('userMenu.removeFriend'),
    onConfirm: async () => {
      try { await api.friendRemove(user.id); await refreshFriends(); } catch (err) { toast(apiErrorMessage(err), { type: 'error' }); }
    },
  });
}

export function inviteSubmenu(user, excludeServerIds = new Set()) {
  const servers = state.servers.filter((s) => !excludeServerIds.has(s.id));
  if (!servers.length) return [{ label: t('userMenu.noServersToInvite'), disabled: true }];
  return servers.map((s) => ({
    label: s.name,
    onClick: async () => {
      try { await api.inviteUserToServer(s.id, user.id); toast(t('profile.inviteSentToast')); } catch (err) { toast(apiErrorMessage(err, t('profile.inviteError')), { type: 'error' }); }
    },
  }));
}

const isFriend = (id) => state.friends.friends.some((f) => f.user.id === id);
const isBlocked = (id) => state.friends.blocked.some((f) => f.user.id === id);

// Timed mute choices for a conversation. `scopeType`/`scopeId` as in notification_prefs.
export function muteSubmenu(scopeType, scopeId) {
  const apply = async (extra) => {
    try {
      const res = await api.setNotificationPref(scopeType, scopeId, 'mute', extra);
      setNotificationPref(scopeType, scopeId, 'mute', res.mutedUntil);
    } catch { toast(t('shell.couldNotUpdateNotifPref'), { type: 'error' }); }
  };
  return [
    ...[['mute15m', 15], ['mute1h', 60], ['mute3h', 180], ['mute8h', 480], ['mute24h', 1440]]
      .map(([key, minutes]) => ({ label: t(`serverRail.${key}`), onClick: () => apply({ minutes }) })),
    { label: t('serverRail.muteForever'), onClick: () => apply({ forever: true }) },
  ];
}

export async function unmute(scopeType, scopeId) {
  try {
    await api.setNotificationPref(scopeType, scopeId, scopeType === 'dm' ? 'all' : 'mentions');
    setNotificationPref(scopeType, scopeId, scopeType === 'dm' ? 'all' : 'mentions');
  } catch { toast(t('shell.couldNotUpdateNotifPref'), { type: 'error' }); }
}

// The block of items common to a friend row and a DM row. `openProfile` is injected so this module
// stays free of the profile views (they import it too).
export function userActionItems(user, { openProfile, withMessage = false, withCall = true, withClose = null, onReport = null } = {}) {
  const ann = annotationFor(user.id);
  const items = [
    { label: t('userMenu.profile'), onClick: () => openProfile(user.id) },
    ...(withMessage ? [{ label: t('userMenu.message'), onClick: () => openDmWith(user.id) }] : []),
    ...(withCall ? [{ label: t('userMenu.startCall'), onClick: () => startCallWith(user.id) }] : []),
    { label: ann?.note ? t('userMenu.editNote') : t('userMenu.addNote'), sub: t('userMenu.noteSub'), onClick: () => openNoteModal(user) },
    { label: ann?.nickname ? t('userMenu.editNickname') : t('userMenu.addNickname'), onClick: () => openNicknameModal(user) },
    ...(withClose ? [withClose] : []),
    'sep',
    { label: t('userMenu.inviteToServer'), submenu: inviteSubmenu(user) },
    ...(isFriend(user.id) ? [{ label: t('userMenu.removeFriend'), onClick: () => confirmRemoveFriend(user) }] : []),
    { label: ann?.ignored ? t('userMenu.unignore') : t('userMenu.ignore'), onClick: () => setIgnored(user, !ann?.ignored) },
    isBlocked(user.id)
      ? { label: t('userMenu.unblock'), danger: true, onClick: () => unblock(user) }
      : { label: t('userMenu.block'), danger: true, onClick: () => confirmBlock(user) },
    ...(onReport ? [{ label: t('profile.reportUserMenuItem'), danger: true, onClick: () => onReport(user) }] : []),
  ];
  return items;
}

