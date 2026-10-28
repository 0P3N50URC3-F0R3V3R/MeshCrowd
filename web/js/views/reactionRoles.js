import { api } from '../api.js';
import { escapeHtml, toast, apiErrorMessage } from '../utils.js';
import { t } from '../i18n.js';
import { PERMISSIONS } from '../permissions.js';
import { confirmModal } from './modal.js';

const POWER_BITS = PERMISSIONS.ADMINISTRATOR | PERMISSIONS.MANAGE_ROLES | PERMISSIONS.MANAGE_SERVER | PERMISSIONS.MANAGE_CHANNELS
  | PERMISSIONS.MANAGE_MESSAGES | PERMISSIONS.KICK_MEMBERS | PERMISSIONS.BAN_MEMBERS | PERMISSIONS.MODERATE_MEMBERS
  | PERMISSIONS.MANAGE_NICKNAMES | PERMISSIONS.VIEW_AUDIT_LOG | PERMISSIONS.PRUNE_CONTENT | PERMISSIONS.MANAGE_BOTS;
const QUICK = ['🎮', '🎨', '🎵', '📚', '⚽', '💻', '🔴', '🔵', '🟢', '🟡', '⭐', '✅'];

// Server Settings > Reaction roles (Manage Roles): a reaction on a chosen message gives or takes a role.
export function renderReactionRoles(inner, { serverId, roles, channels }) {
  inner.innerHTML = `<h2>${t('reactionRoles.title')}</h2><div id="rr-body"><div class="panel-loading" style="height:80px"><div class="spinner"></div></div></div>`;
  const body = inner.querySelector('#rr-body');
  const assignable = roles.filter((r) => !r.is_default && (r.permissions & POWER_BITS) === 0);
  const textChannels = channels.filter((c) => ['public', 'private', 'announcement', 'readonly', 'voice'].includes(c.type));
  let list = [];
  let messages = [];
  let chosen = { channelId: textChannels[0]?.id ?? null, messageId: null };

  async function load() {
    try { list = (await api.listReactionRoles(serverId)).reactionRoles; await loadMessages(); draw(); }
    catch (err) { body.innerHTML = `<div class="empty-state"><p>${escapeHtml(apiErrorMessage(err, t('reactionRoles.loadError')))}</p></div>`; }
  }

  async function loadMessages() {
    messages = [];
    if (!chosen.channelId) return;
    try { messages = (await api.listChannelMessages(serverId, chosen.channelId, { limit: 30 })).messages.filter((m) => !m.eventType && m.content); } catch { messages = []; }
    messages.reverse();
    if (!messages.some((m) => m.id === chosen.messageId)) chosen.messageId = messages[0]?.id ?? null;
  }

  function draw() {
    body.innerHTML = `
      <p class="hint" style="margin:0 0 12px">${t('reactionRoles.hint')}</p>
      <div id="rr-list">
        ${list.length ? list.map((r) => `
          <div class="list-row" style="display:flex;align-items:center;gap:12px;padding:10px">
            <span style="font-size:22px">${escapeHtml(r.emoji)}</span>
            <div style="flex:1;min-width:0">
              <div style="font-weight:600">${escapeHtml(r.roleName || '?')}${r.exclusive ? ` <span class="hint">${t('reactionRoles.exclusiveShort')}</span>` : ''}</div>
              <div class="hint">#${escapeHtml(r.channelName || '?')} - ${escapeHtml(r.messagePreview)}</div>
            </div>
            <button class="btn btn-danger" data-del="${r.id}">${t('reactionRoles.remove')}</button>
          </div>`).join('') : `<div class="empty-state" style="height:auto;padding:16px 0"><p>${t('reactionRoles.empty')}</p></div>`}
      </div>
      <div class="divider"></div>
      <h3 style="margin:0 0 8px">${t('reactionRoles.add')}</h3>
      <div class="field"><label>${t('reactionRoles.channel')}</label>
        <select class="input" id="rr-channel" style="max-width:320px">${textChannels.map((c) => `<option value="${c.id}" ${c.id === chosen.channelId ? 'selected' : ''}>#${escapeHtml(c.name)}</option>`).join('')}</select></div>
      <div class="field"><label>${t('reactionRoles.message')}</label>
        <div id="rr-messages" style="max-height:200px;overflow:auto;border:1px solid var(--border-subtle);border-radius:8px">
          ${messages.length ? messages.map((m) => `<label class="list-row" style="display:flex;gap:8px;align-items:center;padding:6px 10px"><input type="radio" name="rr-msg" value="${m.id}" ${m.id === chosen.messageId ? 'checked' : ''}> <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><b>${escapeHtml(m.author.displayName)}</b>: ${escapeHtml(m.content.slice(0, 90))}</span></label>`).join('') : `<div class="hint" style="padding:10px">${t('reactionRoles.noMessages')}</div>`}
        </div></div>
      <div class="field"><label>${t('reactionRoles.emoji')}</label>
        <input class="input" id="rr-emoji" maxlength="34" style="max-width:160px" placeholder="🎮">
        <div style="margin-top:6px;display:flex;gap:4px;flex-wrap:wrap">${QUICK.map((e) => `<button type="button" class="btn btn-ghost" data-quick="${e}" style="font-size:18px;padding:2px 6px">${e}</button>`).join('')}</div></div>
      <div class="field"><label>${t('reactionRoles.role')}</label>
        <select class="input" id="rr-role" style="max-width:320px">${assignable.map((r) => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('')}</select>
        <div class="hint">${t('reactionRoles.roleHint')}</div></div>
      <div class="field"><label class="checkbox-row"><input type="checkbox" id="rr-exclusive"> ${t('reactionRoles.exclusive')}</label></div>
      <div class="error-text" id="rr-err"></div>
      <button class="btn btn-primary" id="rr-add" ${assignable.length && messages.length ? '' : 'disabled'}>${t('reactionRoles.addButton')}</button>`;

    body.querySelector('#rr-channel').addEventListener('change', async (e) => { chosen.channelId = Number(e.target.value); chosen.messageId = null; await loadMessages(); draw(); });
    body.querySelectorAll('[name=rr-msg]').forEach((r) => r.addEventListener('change', () => { chosen.messageId = Number(r.value); }));
    body.querySelectorAll('[data-quick]').forEach((b) => b.addEventListener('click', () => { body.querySelector('#rr-emoji').value = b.dataset.quick; }));
    body.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
      confirmModal({
        title: t('reactionRoles.removeTitle'),
        message: t('reactionRoles.removeMessage'),
        confirmLabel: t('reactionRoles.remove'),
        async onConfirm() {
          try { await api.deleteReactionRole(serverId, Number(b.dataset.del)); await load(); }
          catch (err) { toast(apiErrorMessage(err, t('reactionRoles.saveError')), { type: 'error' }); }
        },
      });
    }));
    body.querySelector('#rr-add').addEventListener('click', async () => {
      const errEl = body.querySelector('#rr-err');
      errEl.textContent = '';
      try {
        await api.createReactionRole(serverId, {
          channelId: chosen.channelId, messageId: chosen.messageId,
          emoji: body.querySelector('#rr-emoji').value.trim(),
          roleId: Number(body.querySelector('#rr-role').value),
          exclusive: body.querySelector('#rr-exclusive').checked,
        });
        toast(t('reactionRoles.saved'));
        await load();
      } catch (err) { errEl.textContent = apiErrorMessage(err, t('reactionRoles.saveError')); }
    });
  }

  load();
}
