import { api } from './api.js';
import { bus } from './bus.js';
import { state, setDms } from './state.js';
import { t } from './i18n.js';
import { avatarHtml, escapeHtml, apiErrorMessage } from './utils.js';

// Multi-select friend picker used for "new message" (1 person = DM, 2+ = group) and "add people".
// `openPanel({ title, html, onMount(body, close) })` is the host's modal (desktop) or sheet (mobile).
// `exclude` = user ids already in the conversation. `onConfirm(userIds, name)` may throw to keep the panel open.
export function openDmPicker({ openPanel, title, exclude = new Set(), confirmLabel, askName = false, onConfirm }) {
  const friends = (state.friends.friends || []).map((f) => f.user).filter((u) => !exclude.has(u.id));
  openPanel({
    title,
    html: friends.length === 0
      ? `<div class="empty-state" style="padding:20px 0"><p>${t('dmPicker.noFriends')}</p></div>`
      : `<div class="dm-picker-list">${friends.map((u) => `
          <label class="list-row dm-picker-row" style="cursor:pointer">
            <input type="checkbox" data-pick="${u.id}">
            ${avatarHtml(u, 32)}
            <div class="lr-main"><div class="lr-title">${escapeHtml(u.displayName)}</div><div class="lr-sub">@${escapeHtml(u.username)}</div></div>
          </label>`).join('')}</div>
        ${askName ? `<div class="field" id="dmp-name-field" style="display:none"><label>${t('dmPicker.groupName')}</label><input class="input m-input" id="dmp-name" maxlength="100" placeholder="${escapeHtml(t('dmPicker.groupNamePh'))}"></div>` : ''}
        <div class="error-text" id="dmp-err"></div>
        <button type="button" class="btn btn-primary btn-block" id="dmp-go" disabled>${escapeHtml(confirmLabel)}</button>`,
    onMount(body, close) {
      const go = body.querySelector('#dmp-go');
      if (!go) return;
      const picked = () => [...body.querySelectorAll('[data-pick]:checked')].map((n) => Number(n.dataset.pick));
      body.addEventListener('change', () => {
        const n = picked().length;
        go.disabled = n === 0;
        const nameField = body.querySelector('#dmp-name-field');
        if (nameField) nameField.style.display = n < 2 ? 'none' : '';
      });
      go.addEventListener('click', async () => {
        go.disabled = true;
        try {
          await onConfirm(picked(), body.querySelector('#dmp-name')?.value.trim() || '');
          close();
        } catch (err) {
          body.querySelector('#dmp-err').textContent = apiErrorMessage(err, t('dmPicker.couldNotStart'));
          go.disabled = false;
        }
      });
    },
  });
}

// One person opens (or reuses) the 1:1, two or more start a group. Resolves with the dm id.
export async function startConversation(userIds, name) {
  const { dmId } = userIds.length === 1 ? await api.openDm(userIds[0]) : await api.openGroupDm(userIds, name);
  setDms((await api.listDms()).dms);
  return dmId;
}

// 1:1 -> a new group is created (new id); group -> the people join in place. Resolves with the dm id to show.
export async function addPeople(dmId, userIds, name) {
  const res = await api.addDmMembers(dmId, userIds, name);
  setDms((await api.listDms()).dms);
  return res.dmId;
}

export function navigateToDm(dmId) { bus.emit('ui:navigate', { type: 'dm', dmId }); }
