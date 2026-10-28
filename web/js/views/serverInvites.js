import { api } from '../api.js';
import { avatarHtml, escapeHtml, toast, apiErrorMessage } from '../utils.js';
import { t } from '../i18n.js';
import { inviteLinkFor } from '../inviteHash.mjs';
import { confirmModal } from './modal.js';

const EXPIRY = [
  { seconds: 1800, key: 'invites.expiry30m' },
  { seconds: 3600, key: 'invites.expiry1h' },
  { seconds: 21600, key: 'invites.expiry6h' },
  { seconds: 43200, key: 'invites.expiry12h' },
  { seconds: 86400, key: 'invites.expiry1d' },
  { seconds: 604800, key: 'invites.expiry7d' },
  { seconds: 2592000, key: 'invites.expiry30d' },
  { seconds: 0, key: 'invites.expiryNever' },
];
const USES = [0, 1, 5, 10, 25, 50, 100];

function expiryText(iso) {
  if (!iso) return t('invites.neverExpires');
  const ms = new Date(iso) - Date.now();
  if (ms <= 0) return t('invites.expired');
  const mins = Math.round(ms / 60000);
  if (mins < 60) return t('invites.expiresInMinutes', { n: mins });
  const hours = Math.round(mins / 60);
  if (hours < 48) return t('invites.expiresInHours', { n: hours });
  return t('invites.expiresInDays', { n: Math.round(hours / 24) });
}

// Server Settings > Invites: extra invite links with their own expiry and use limit, plus the vanity link.
export function renderServerInvites(inner, { serverId, origin = location.origin }) {
  inner.innerHTML = `<h2>${t('invites.title')}</h2><div id="inv-body"><div class="panel-loading" style="height:80px"><div class="spinner"></div></div></div>`;
  const body = inner.querySelector('#inv-body');
  let data = null;

  async function load() {
    try { data = await api.listServerInvites(serverId); draw(); }
    catch (err) { body.innerHTML = `<div class="empty-state"><p>${escapeHtml(apiErrorMessage(err, t('invites.loadError')))}</p></div>`; }
  }

  async function copy(text, msgKey = 'invites.copied') {
    try { await navigator.clipboard.writeText(text); toast(t(msgKey)); } catch { toast(t('serverSettings.couldNotCopyManual')); }
  }

  function draw() {
    const rows = data.invites;
    body.innerHTML = `
      <p class="hint" style="margin:0 0 12px">${t('invites.hint')}</p>
      <div style="display:flex;flex-direction:row;gap:12px;flex-wrap:wrap;align-items:flex-end;margin-bottom:12px">
        <div><label>${t('invites.expiresAfter')}</label>
          <select class="input" id="inv-expiry">${EXPIRY.map((e) => `<option value="${e.seconds}" ${e.seconds === 86400 ? 'selected' : ''}>${t(e.key)}</option>`).join('')}</select></div>
        <div><label>${t('invites.maxUses')}</label>
          <select class="input" id="inv-uses">${USES.map((n) => `<option value="${n}">${n ? n : t('invites.noLimit')}</option>`).join('')}</select></div>
        <button class="btn btn-primary" id="inv-create">${t('invites.create')}</button>
      </div>
      <div class="error-text" id="inv-err"></div>
      <div id="inv-list">
        ${rows.length ? rows.map((i) => `
          <div class="list-row" style="display:flex;align-items:center;gap:12px;padding:10px">
            ${i.createdBy ? avatarHtml(i.createdBy, 32) : ''}
            <div style="flex:1;min-width:0">
              <div style="font-family:monospace;font-weight:600">${escapeHtml(i.code)}</div>
              <div class="hint">${t('invites.usesOf', { uses: i.uses, max: i.maxUses ?? t('invites.unlimited') })} - ${escapeHtml(expiryText(i.expiresAt))}${i.createdBy ? ` - ${escapeHtml(i.createdBy.displayName)}` : ''}</div>
            </div>
            <button class="btn btn-secondary" data-copy="${escapeHtml(i.code)}">${t('invites.copy')}</button>
            <button class="btn btn-secondary" data-copy-link="${escapeHtml(i.code)}">${t('invites.copyLink')}</button>
            <button class="btn btn-danger" data-revoke="${i.id}">${t('invites.revoke')}</button>
          </div>`).join('') : `<div class="empty-state" style="height:auto;padding:16px 0"><p>${t('invites.empty')}</p></div>`}
      </div>
      ${data.canManage ? `
        <div class="divider"></div>
        <h3 style="margin:0 0 6px">${t('invites.vanityTitle')}</h3>
        <p class="hint" style="margin:0 0 8px">${t('invites.vanityHint')}</p>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <input class="input" id="inv-vanity" maxlength="32" value="${escapeHtml(data.vanityCode || '')}" placeholder="my-server" style="max-width:260px">
          <button class="btn btn-primary" id="inv-vanity-save">${t('invites.vanitySave')}</button>
          ${data.vanityCode ? `<button class="btn btn-secondary" id="inv-vanity-link">${t('invites.copyLink')}</button><button class="btn btn-secondary" id="inv-vanity-clear">${t('invites.vanityClear')}</button>` : ''}
        </div>
        <div class="error-text" id="inv-vanity-err"></div>` : ''}`;

    body.querySelector('#inv-create').addEventListener('click', async () => {
      const errEl = body.querySelector('#inv-err');
      errEl.textContent = '';
      const expiresInSeconds = Number(body.querySelector('#inv-expiry').value) || null;
      const maxUses = Number(body.querySelector('#inv-uses').value) || null;
      try {
        const { invite } = await api.createServerInvite(serverId, { expiresInSeconds, maxUses });
        await copy(invite.code);
        await load();
      } catch (err) { errEl.textContent = apiErrorMessage(err, t('invites.createError')); }
    });
    body.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => copy(b.dataset.copy)));
    body.querySelectorAll('[data-copy-link]').forEach((b) => b.addEventListener('click', () => copy(inviteLinkFor(b.dataset.copyLink, origin), 'invites.linkCopied')));
    body.querySelector('#inv-vanity-link')?.addEventListener('click', () => copy(inviteLinkFor(data.vanityCode, origin), 'invites.linkCopied'));
    body.querySelectorAll('[data-revoke]').forEach((b) => b.addEventListener('click', () => {
      confirmModal({
        title: t('invites.revokeTitle'),
        message: t('invites.revokeMessage'),
        confirmLabel: t('invites.revoke'),
        async onConfirm() {
          try { await api.revokeServerInvite(serverId, Number(b.dataset.revoke)); await load(); }
          catch (err) { toast(apiErrorMessage(err, t('invites.createError')), { type: 'error' }); }
        },
      });
    }));
    const saveVanity = async (code) => {
      const errEl = body.querySelector('#inv-vanity-err');
      errEl.textContent = '';
      try { data.vanityCode = (await api.setServerVanity(serverId, code)).vanityCode; draw(); toast(t('invites.vanitySaved')); }
      catch (err) { errEl.textContent = apiErrorMessage(err, t('invites.vanityError')); }
    };
    body.querySelector('#inv-vanity-save')?.addEventListener('click', () => saveVanity(body.querySelector('#inv-vanity').value));
    body.querySelector('#inv-vanity-clear')?.addEventListener('click', () => saveVanity(null));
  }

  load();
}
