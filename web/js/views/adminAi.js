import { api } from '../api.js';
import { escapeHtml, toast, apiErrorMessage } from '../utils.js';
import { t } from '../i18n.js';
import { confirmModal } from './modal.js';
import { renderBotEditor } from './botEditor.js';

export function renderAdminAi(inner) {
  inner.innerHTML = `<h2>${t('admin.aiTab')}</h2><div id="admin-ai-body"><div class="panel-loading" style="height:80px"><div class="spinner"></div></div></div>`;
  const body = inner.querySelector('#admin-ai-body');
  let editingProvider = null;

  async function load() {
    try {
      const [prov, bots, servers] = await Promise.all([api.adminListAiProviders(), api.adminListAiBots(), api.adminListAiServers()]);
      draw(prov.providers, bots.bots, servers.servers);
    } catch (err) {
      body.innerHTML = `<div class="empty-state"><p>${escapeHtml(apiErrorMessage(err, t('bots.providerLoadError')))}</p></div>`;
    }
  }

  function draw(providers, bots, servers) {
    body.innerHTML = `
      <h3 style="margin:0 0 8px">${t('bots.providersTitle')}</h3>
      <p class="hint" style="margin:0 0 12px">${t('bots.providersHint')}</p>
      <div id="ai-prov-list">
        ${providers.length ? providers.map((p) => `
          <div class="list-row" style="display:flex;align-items:center;gap:12px;padding:10px">
            <div style="flex:1;min-width:0">
              <div style="font-weight:600">${escapeHtml(p.name)} <span class="hint">${p.kind === 'ollama' ? t('bots.providerKindOllama') : t('bots.providerKindOpenai')}${p.enabled ? '' : ` - ${t('bots.off')}`}</span></div>
              <div class="hint">${escapeHtml(p.baseUrl)}${p.hasKey ? ' (key)' : ''}</div>
            </div>
            <button class="btn btn-secondary" data-prov-edit="${p.id}">${t('bots.edit')}</button>
            <button class="btn btn-danger" data-prov-del="${p.id}">${t('bots.delete')}</button>
          </div>`).join('') : `<div class="empty-state" style="height:auto;padding:12px 0"><p>${t('bots.providerEmpty')}</p></div>`}
      </div>
      <div class="field" style="margin-top:12px" id="ai-prov-form"></div>
      <div class="divider"></div>
      <h3 style="margin:0 0 8px">${t('bots.allBotsTitle')}</h3>
      <div id="ai-bots"></div>`;

    body.querySelectorAll('[data-prov-edit]').forEach((b) => b.addEventListener('click', () => {
      editingProvider = providers.find((p) => p.id === Number(b.dataset.provEdit));
      drawProviderForm();
    }));
    body.querySelectorAll('[data-prov-del]').forEach((b) => b.addEventListener('click', () => {
      const p = providers.find((x) => x.id === Number(b.dataset.provDel));
      confirmModal({
        title: t('bots.providerDeleteTitle'),
        message: t('bots.providerDeleteMessage', { name: escapeHtml(p.name) }),
        confirmLabel: t('bots.delete'),
        async onConfirm() {
          try { await api.adminDeleteAiProvider(p.id); toast(t('bots.providerDeleted')); editingProvider = null; load(); }
          catch (err) { toast(apiErrorMessage(err, t('bots.providerDeleteError')), { type: 'error' }); }
        },
      });
    }));
    drawProviderForm();

    renderBotEditor(body.querySelector('#ai-bots'), {
      bots,
      providers: providers.filter((p) => p.enabled),
      servers,
      create: (b) => api.adminCreateAiBot(b),
      update: (bot, b) => api.adminUpdateAiBot(bot.id, b),
      remove: (bot) => api.adminDeleteAiBot(bot.id),
      uploadAvatar: (bot, file) => api.adminUploadAiBotAvatar(bot.id, file),
      credentials: {
        issueToken: (bot) => api.adminIssueBotToken(bot.id),
        revokeToken: (bot) => api.adminRevokeBotToken(bot.id),
        rotateSecret: (bot) => api.adminRotateBotSecret(bot.id),
        testWebhook: (bot) => api.adminTestBotWebhook(bot.id),
      },
      onChange: load,
    });
  }

  function drawProviderForm() {
    const cur = editingProvider;
    const form = body.querySelector('#ai-prov-form');
    form.innerHTML = `
      <div class="field"><label>${t('bots.providerName')}</label><input class="input" id="pf-name" maxlength="64" value="${escapeHtml(cur ? cur.name : '')}" style="max-width:320px"></div>
      <div class="field"><label>${t('bots.providerKind')}</label>
        <select class="input" id="pf-kind" style="max-width:320px">
          <option value="ollama" ${!cur || cur.kind === 'ollama' ? 'selected' : ''}>${t('bots.providerKindOllama')}</option>
          <option value="openai" ${cur && cur.kind === 'openai' ? 'selected' : ''}>${t('bots.providerKindOpenai')}</option>
        </select></div>
      <div class="field"><label>${t('bots.providerUrl')}</label><input class="input" id="pf-url" value="${escapeHtml(cur ? cur.baseUrl : '')}" placeholder="${escapeHtml(t('bots.providerUrlPlaceholder'))}" style="max-width:420px"></div>
      <div class="field"><label>${t('bots.providerKey')}</label>
        <input class="input" id="pf-key" type="password" autocomplete="off" style="max-width:420px">
        ${cur && cur.hasKey ? `<div class="hint">${t('bots.providerKeySet')}</div><label><input type="checkbox" id="pf-clearkey"> ${t('bots.providerClearKey')}</label>` : ''}</div>
      <div class="field"><label>${t('bots.providerModels')}</label>
        <textarea class="input" id="pf-models" rows="4" style="max-width:420px">${escapeHtml(cur ? cur.models.join('\n') : '')}</textarea>
        <div style="margin-top:6px"><button type="button" class="btn btn-secondary" id="pf-test">${t('bots.providerTest')}</button> <span class="hint" id="pf-test-out"></span></div></div>
      <div class="field" style="display:flex;gap:16px;flex-wrap:wrap">
        <label>${t('bots.providerTimeout')} <input class="input" id="pf-timeout" type="number" min="5" max="600" value="${cur ? cur.timeoutS : 120}" style="width:90px"></label>
        <label>${t('bots.providerConcurrency')} <input class="input" id="pf-conc" type="number" min="1" max="4" value="${cur ? cur.concurrency : 1}" style="width:70px"></label>
      </div>
      <div class="field"><label><input type="checkbox" id="pf-usable" ${cur && cur.serverAdminUsable ? 'checked' : ''}> ${t('bots.providerUsable')}</label></div>
      <div class="field"><label><input type="checkbox" id="pf-enabled" ${!cur || cur.enabled ? 'checked' : ''}> ${t('bots.providerEnabled')}</label></div>
      <div class="error-text" id="pf-err"></div>
      <div style="display:flex;gap:8px"><button class="btn btn-primary" id="pf-save">${t('bots.providerSave')}</button>
      ${cur ? `<button class="btn btn-secondary" id="pf-cancel">${t('bots.cancelEdit')}</button>` : ''}</div>`;

    form.querySelector('#pf-test').addEventListener('click', async () => {
      const out = form.querySelector('#pf-test-out');
      out.textContent = '...';
      try {
        const res = await api.adminTestAiProvider({
          providerId: cur ? cur.id : undefined,
          kind: form.querySelector('#pf-kind').value,
          baseUrl: form.querySelector('#pf-url').value.trim(),
          apiKey: form.querySelector('#pf-key').value || undefined,
        });
        if (res.ok) {
          out.textContent = t('bots.providerTestOk', { ms: res.latencyMs, count: res.models.length });
          const ta = form.querySelector('#pf-models');
          if (!ta.value.trim() && res.models.length) ta.value = res.models.join('\n');
        } else out.textContent = t('bots.providerTestFail', { error: res.error });
      } catch (err) { out.textContent = apiErrorMessage(err, t('bots.providerLoadError')); }
    });
    if (cur) form.querySelector('#pf-cancel').addEventListener('click', () => { editingProvider = null; drawProviderForm(); });

    form.querySelector('#pf-save').addEventListener('click', async () => {
      const errEl = form.querySelector('#pf-err');
      errEl.textContent = '';
      const payload = {
        name: form.querySelector('#pf-name').value.trim(),
        kind: form.querySelector('#pf-kind').value,
        baseUrl: form.querySelector('#pf-url').value.trim(),
        models: form.querySelector('#pf-models').value.split('\n').map((s) => s.trim()).filter(Boolean),
        timeoutS: Number(form.querySelector('#pf-timeout').value),
        concurrency: Number(form.querySelector('#pf-conc').value),
        serverAdminUsable: form.querySelector('#pf-usable').checked,
        enabled: form.querySelector('#pf-enabled').checked,
      };
      const key = form.querySelector('#pf-key').value;
      if (key) payload.apiKey = key;
      else if (cur && form.querySelector('#pf-clearkey')?.checked) payload.apiKey = '';
      try {
        if (cur) await api.adminUpdateAiProvider(cur.id, payload); else await api.adminCreateAiProvider(payload);
        toast(t('bots.providerSaved'));
        editingProvider = null;
        load();
      } catch (err) { errEl.textContent = apiErrorMessage(err, t('bots.providerSaveError')); }
    });
  }

  load();
}
