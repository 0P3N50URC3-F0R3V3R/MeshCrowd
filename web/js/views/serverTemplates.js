import { api } from '../api.js';
import { escapeHtml, toast, apiErrorMessage } from '../utils.js';
import { t } from '../i18n.js';
import { confirmModal } from './modal.js';

// Server Settings > Templates (Manage Server): frozen copies of this server's structure that others
// can start a server from with the code. Nothing but structure is copied.
export function renderServerTemplates(inner, { serverId }) {
  inner.innerHTML = `<h2>${t('templates.title')}</h2><div id="tp-body"><div class="panel-loading" style="height:80px"><div class="spinner"></div></div></div>`;
  const body = inner.querySelector('#tp-body');
  let list = [];

  async function load() {
    try { list = (await api.listServerTemplates(serverId)).templates; draw(); }
    catch (err) { body.innerHTML = `<div class="empty-state"><p>${escapeHtml(apiErrorMessage(err, t('templates.loadError')))}</p></div>`; }
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast(t('templates.copied')); } catch { toast(t('serverSettings.couldNotCopyManual')); }
  }

  function draw() {
    body.innerHTML = `
      <p class="hint" style="margin:0 0 12px">${t('templates.hint')}</p>
      <div id="tp-list">
        ${list.length ? list.map((x) => `
          <div class="list-row" style="display:flex;align-items:center;gap:12px;padding:10px;flex-wrap:wrap">
            <div style="flex:1;min-width:200px">
              <div style="font-weight:600">${escapeHtml(x.name)} <span class="hint" style="font-family:monospace">${escapeHtml(x.code)}</span></div>
              <div class="hint">${t('templates.summary', { roles: x.summary.roles, categories: x.summary.categories, channels: x.summary.channels.length })} - ${t('templates.uses', { n: x.uses })}</div>
              ${x.description ? `<div class="hint">${escapeHtml(x.description)}</div>` : ''}
            </div>
            <button class="btn btn-secondary" data-copy="${escapeHtml(x.code)}">${t('templates.copy')}</button>
            <button class="btn btn-secondary" data-sync="${x.id}">${t('templates.sync')}</button>
            <button class="btn btn-danger" data-del="${x.id}">${t('templates.delete')}</button>
          </div>`).join('') : `<div class="empty-state" style="height:auto;padding:16px 0"><p>${t('templates.empty')}</p></div>`}
      </div>
      <div class="divider"></div>
      <h3 style="margin:0 0 8px">${t('templates.create')}</h3>
      <div class="field"><label>${t('templates.name')}</label><input class="input" id="tp-name" maxlength="100" style="max-width:360px"></div>
      <div class="field"><label>${t('templates.description')}</label><textarea class="input" id="tp-desc" rows="2" maxlength="500" style="max-width:480px"></textarea></div>
      <div class="error-text" id="tp-err"></div>
      <button class="btn btn-primary" id="tp-create">${t('templates.createButton')}</button>`;

    body.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => copy(b.dataset.copy)));
    body.querySelectorAll('[data-sync]').forEach((b) => b.addEventListener('click', async () => {
      try { await api.syncServerTemplate(serverId, Number(b.dataset.sync)); toast(t('templates.synced')); await load(); }
      catch (err) { toast(apiErrorMessage(err, t('templates.error')), { type: 'error' }); }
    }));
    body.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
      confirmModal({
        title: t('templates.deleteTitle'),
        message: t('templates.deleteMessage'),
        confirmLabel: t('templates.delete'),
        async onConfirm() {
          try { await api.deleteServerTemplate(serverId, Number(b.dataset.del)); await load(); }
          catch (err) { toast(apiErrorMessage(err, t('templates.error')), { type: 'error' }); }
        },
      });
    }));
    body.querySelector('#tp-create').addEventListener('click', async () => {
      const errEl = body.querySelector('#tp-err');
      errEl.textContent = '';
      try {
        const { template } = await api.createServerTemplate(serverId, { name: body.querySelector('#tp-name').value.trim(), description: body.querySelector('#tp-desc').value.trim() });
        await copy(template.code);
        await load();
      } catch (err) { errEl.textContent = apiErrorMessage(err, t('templates.error')); }
    });
  }

  load();
}
