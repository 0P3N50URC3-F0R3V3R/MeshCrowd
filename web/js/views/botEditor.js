import { escapeHtml, toast, apiErrorMessage, avatarHtml } from '../utils.js';
import { t } from '../i18n.js';
import { confirmModal } from './modal.js';

// Shared by Server Settings (this server only) and the Admin Panel (any server). The caller
// supplies the API calls and, for the admin panel, a server list so the bot's server can be picked.
// `credentials` carries the token / webhook-secret / test calls for an existing bot.
export function renderBotEditor(container, { bots, providers, servers, create, update, remove, uploadAvatar, credentials, onChange }) {
  let editing = null;
  let chosenAvatar = null;
  let revealed = null; // { kind: 'token' | 'secret', value } - shown once, dropped on the next re-render of the form

  const providerById = (id) => providers.find((p) => p.id === Number(id));

  function replaceBot(bot) {
    const i = bots.findIndex((b) => b.id === bot.id);
    if (i >= 0) bots[i] = bot;
    editing = bot;
  }

  function render() {
    const onOff = (v) => (v ? t('bots.on') : t('bots.off'));
    container.innerHTML = `
      <p class="hint" style="margin:0 0 16px">${t('bots.hint')}</p>
      <div id="bot-list">
        ${bots.length ? bots.map((b) => `
          <div class="list-row" style="display:flex;align-items:center;gap:12px;padding:10px">
            ${avatarHtml(b.user, 36)}
            <div style="flex:1;min-width:0">
              <div style="font-weight:600">${escapeHtml(b.user.displayName)} <span class="bot-badge">${t('bots.badge')}</span></div>
              <div class="hint">@${escapeHtml(b.user.username)} - ${b.hasAi ? `${escapeHtml(b.providerName)} / ${escapeHtml(b.model)}` : t('bots.apiBot')}${servers ? ` - ${escapeHtml(b.serverName)}` : ''}</div>
              <div class="hint">${t('bots.modes', { mention: onOff(b.mentionEnabled && b.hasAi), dm: onOff(b.dmEnabled) })}${b.api.hasToken ? ' - API' : ''}${b.webhook.enabled ? ' - Webhook' : ''}</div>
            </div>
            <button class="btn btn-secondary" data-bot-edit="${b.id}">${t('bots.edit')}</button>
            <button class="btn btn-danger" data-bot-delete="${b.id}">${t('bots.delete')}</button>
          </div>`).join('') : `<div class="empty-state" style="height:auto;padding:16px 0"><p>${t('bots.empty')}</p></div>`}
      </div>
      <div class="divider"></div>
      <h3 style="margin:0 0 12px">${editing ? t('bots.editBot') : t('bots.newBot')}</h3>
      <div id="bot-form"></div>`;

    container.querySelectorAll('[data-bot-edit]').forEach((btn) => btn.addEventListener('click', () => {
      editing = bots.find((b) => b.id === Number(btn.dataset.botEdit));
      chosenAvatar = null;
      revealed = null;
      render();
    }));
    container.querySelectorAll('[data-bot-delete]').forEach((btn) => btn.addEventListener('click', () => {
      const bot = bots.find((b) => b.id === Number(btn.dataset.botDelete));
      confirmModal({
        title: t('bots.deleteTitle'),
        message: t('bots.deleteMessage', { name: escapeHtml(bot.user.displayName) }),
        confirmLabel: t('bots.delete'),
        async onConfirm() {
          try { await remove(bot); toast(t('bots.deleted')); onChange(); }
          catch (err) { toast(apiErrorMessage(err, t('bots.deleteError')), { type: 'error' }); }
        },
      });
    }));
    renderForm();
  }

  function renderForm() {
    const form = container.querySelector('#bot-form');
    const cur = editing;
    const aiOn = cur ? cur.hasAi : providers.length > 0;
    const providerId = cur && cur.hasAi && providerById(cur.providerId) ? cur.providerId : (providers[0]?.id ?? '');
    form.innerHTML = `
      ${!cur && servers ? `
        <div class="field"><label>${t('bots.serverLabel')}</label>
          <select class="input" id="bf-server" style="max-width:320px">${servers.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('')}</select>
        </div>` : ''}
      <div class="field"><label>${t('bots.nameLabel')}</label>
        <input class="input" id="bf-name" maxlength="32" value="${escapeHtml(cur ? cur.user.displayName : '')}" style="max-width:320px"></div>
      <div class="field"><label>${t('bots.providerLabel')}</label>
        <select class="input" id="bf-provider" style="max-width:320px">
          <option value="" ${aiOn ? '' : 'selected'}>${t('bots.noAi')}</option>
          ${providers.map((p) => `<option value="${p.id}" ${aiOn && p.id === providerId ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}
        </select></div>
      <div id="bf-ai">
        <div class="field"><label>${t('bots.modelLabel')}</label><div id="bf-model-wrap"></div></div>
        <div class="field"><label>${t('bots.personaLabel')}</label>
          <textarea class="input" id="bf-persona" rows="4" maxlength="4000" placeholder="${escapeHtml(t('bots.personaPlaceholder'))}">${escapeHtml(cur ? cur.persona : '')}</textarea></div>
        <div class="field"><label><input type="checkbox" id="bf-mention" ${!cur || cur.mentionEnabled ? 'checked' : ''}> ${t('bots.mentionLabel')}</label></div>
        <div class="field"><label>${t('bots.contextLabel')}</label>
          <input class="input" id="bf-context" type="number" min="1" max="30" value="${cur ? cur.contextMessages : 12}" style="width:100px"></div>
        <p class="hint" id="bf-privacy"></p>
      </div>
      <div class="field"><label><input type="checkbox" id="bf-dm" ${cur && cur.dmEnabled ? 'checked' : ''}> ${t('bots.dmLabel')}</label></div>
      ${cur ? `<div class="field"><label>${t('bots.avatarLabel')}</label>
        <button type="button" class="btn btn-secondary" id="bf-avatar-btn">${t('bots.chooseAvatar')}</button>
        <input type="file" id="bf-avatar" class="hidden" accept="image/png,image/jpeg,image/gif,image/webp">
        <span class="hint" id="bf-avatar-name"></span></div>` : ''}
      ${cur && credentials ? `
        <div class="divider"></div>
        <h4 style="margin:0 0 6px">${t('bots.apiTitle')}</h4>
        <p class="hint" style="margin:0 0 8px">${t('bots.apiHint')}</p>
        <div id="bf-api"></div>
        <div class="divider"></div>
        <h4 style="margin:0 0 6px">${t('bots.webhookTitle')}</h4>
        <p class="hint" style="margin:0 0 8px">${t('bots.webhookHint')}</p>
        <div id="bf-hook"></div>` : `<p class="hint">${t('bots.saveFirst')}</p>`}
      <div class="error-text" id="bf-err"></div>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="btn btn-primary" id="bf-save">${cur ? t('bots.save') : t('bots.create')}</button>
        ${cur ? `<button class="btn btn-secondary" id="bf-cancel">${t('bots.cancelEdit')}</button>` : ''}
      </div>`;

    const providerSel = form.querySelector('#bf-provider');
    function renderModel() {
      const aiBlock = form.querySelector('#bf-ai');
      const p = providerById(providerSel.value);
      aiBlock.style.display = p ? '' : 'none';
      if (!p) return;
      const wrap = form.querySelector('#bf-model-wrap');
      const current = cur && cur.providerId === p.id ? cur.model : '';
      wrap.innerHTML = p.models.length
        ? `<select class="input" id="bf-model" style="max-width:320px">${p.models.map((m) => `<option value="${escapeHtml(m)}" ${m === current ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('')}</select>`
        : `<input class="input" id="bf-model" maxlength="200" value="${escapeHtml(current)}" style="max-width:320px">`;
      form.querySelector('#bf-privacy').textContent = t('bots.privacyNotice', { provider: p.name });
    }
    providerSel.addEventListener('change', renderModel);
    renderModel();

    if (cur) {
      const fileInput = form.querySelector('#bf-avatar');
      form.querySelector('#bf-avatar-btn').addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', () => {
        chosenAvatar = fileInput.files[0] || null;
        form.querySelector('#bf-avatar-name').textContent = chosenAvatar ? chosenAvatar.name : '';
      });
      form.querySelector('#bf-cancel').addEventListener('click', () => { editing = null; chosenAvatar = null; revealed = null; render(); });
      if (credentials) { paintApi(); paintHook(); }
    }

    form.querySelector('#bf-save').addEventListener('click', async () => {
      const errEl = form.querySelector('#bf-err');
      errEl.textContent = '';
      const p = providerById(providerSel.value);
      const body = {
        displayName: form.querySelector('#bf-name').value.trim(),
        providerId: p ? p.id : null,
        dmEnabled: form.querySelector('#bf-dm').checked,
      };
      if (p) {
        body.model = form.querySelector('#bf-model').value.trim();
        body.persona = form.querySelector('#bf-persona').value;
        body.mentionEnabled = form.querySelector('#bf-mention').checked;
        body.contextMessages = Number(form.querySelector('#bf-context').value);
      }
      if (cur && credentials) {
        body.webhookUrl = form.querySelector('#hk-url').value.trim();
        body.webhookScope = form.querySelector('#hk-scope').value;
        body.webhookEnabled = form.querySelector('#hk-enabled').checked;
      }
      try {
        let saved;
        if (cur) saved = (await update(cur, body)).bot;
        else saved = (await create({ ...body, serverId: servers ? Number(form.querySelector('#bf-server').value) : undefined })).bot;
        if (chosenAvatar) await uploadAvatar(saved, chosenAvatar);
        toast(t('bots.saved'));
        editing = null;
        chosenAvatar = null;
        revealed = null;
        onChange();
      } catch (err) { errEl.textContent = apiErrorMessage(err, t('bots.saveError')); }
    });
  }

  async function copy(text, button) {
    try { await navigator.clipboard.writeText(text); button.textContent = t('bots.copied'); } catch { /* clipboard blocked: the value stays selectable */ }
  }

  function revealHtml(kind) {
    if (!revealed || revealed.kind !== kind) return '';
    return `<div class="field" style="margin-top:8px">
      <div class="hint">${kind === 'token' ? t('bots.apiShownOnce') : t('bots.webhookSecretShown')}</div>
      <div style="display:flex;gap:8px;align-items:center">
        <input class="input" id="bf-reveal-${kind}" readonly value="${escapeHtml(revealed.value)}" style="flex:1;font-family:monospace" onfocus="this.select()">
        <button type="button" class="btn btn-secondary" id="bf-reveal-copy-${kind}">${t('bots.copy')}</button>
      </div></div>`;
  }

  function wireReveal(box, kind) {
    box.querySelector(`#bf-reveal-copy-${kind}`)?.addEventListener('click', (e) => copy(revealed.value, e.currentTarget));
  }

  function paintApi() {
    const box = container.querySelector('#bf-api');
    if (!box || !editing) return;
    const a = editing.api;
    box.innerHTML = `
      <div class="hint">${a.hasToken ? t('bots.apiTokenInfo', { prefix: escapeHtml(a.tokenPrefix || ''), date: escapeHtml(new Date(a.tokenCreatedAt).toLocaleDateString()) }) : t('bots.apiNoToken')}</div>
      <div style="display:flex;gap:8px;margin-top:6px">
        <button type="button" class="btn btn-secondary" id="bf-token-issue">${a.hasToken ? t('bots.apiRegenerate') : t('bots.apiGenerate')}</button>
        ${a.hasToken ? `<button type="button" class="btn btn-danger" id="bf-token-revoke">${t('bots.apiRevoke')}</button>` : ''}
      </div>${revealHtml('token')}`;
    box.querySelector('#bf-token-issue').addEventListener('click', async () => {
      try {
        const res = await credentials.issueToken(editing);
        replaceBot(res.bot);
        revealed = { kind: 'token', value: res.token };
        paintApi();
      } catch (err) { toast(apiErrorMessage(err, t('bots.apiError')), { type: 'error' }); }
    });
    box.querySelector('#bf-token-revoke')?.addEventListener('click', async () => {
      try {
        replaceBot((await credentials.revokeToken(editing)).bot);
        revealed = null;
        paintApi();
        toast(t('bots.apiRevoked'));
      } catch (err) { toast(apiErrorMessage(err, t('bots.apiError')), { type: 'error' }); }
    });
    wireReveal(box, 'token');
  }

  function paintHook() {
    const box = container.querySelector('#bf-hook');
    if (!box || !editing) return;
    const w = editing.webhook;
    box.innerHTML = `
      <div class="field"><label>${t('bots.webhookUrl')}</label>
        <input class="input" id="hk-url" value="${escapeHtml(w.url)}" placeholder="https://n8n.example.com/webhook/..." style="max-width:480px">
        <div class="hint">${t('bots.webhookPrivate')}</div></div>
      <div class="field"><label>${t('bots.webhookScope')}</label>
        <select class="input" id="hk-scope" style="max-width:320px">
          <option value="mention" ${w.scope === 'mention' ? 'selected' : ''}>${t('bots.webhookScopeMention')}</option>
          <option value="all" ${w.scope === 'all' ? 'selected' : ''}>${t('bots.webhookScopeAll')}</option>
        </select></div>
      <div class="field"><label>${t('bots.webhookSecretLabel')}</label>
        <div class="hint">${w.hasSecret ? t('bots.webhookSecretSet') : t('bots.webhookNoSecret')}</div>
        <button type="button" class="btn btn-secondary" id="hk-secret" style="margin-top:6px">${w.hasSecret ? t('bots.webhookSecretRotate') : t('bots.webhookSecretGenerate')}</button>
        ${revealHtml('secret')}</div>
      <div class="field"><label><input type="checkbox" id="hk-enabled" ${w.enabled ? 'checked' : ''} ${w.hasSecret ? '' : 'disabled'}> ${t('bots.webhookEnabled')}</label></div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button type="button" class="btn btn-secondary" id="hk-test" ${w.url && w.hasSecret ? '' : 'disabled'}>${t('bots.webhookTest')}</button>
        <span class="hint" id="hk-test-out">${w.lastStatus ? escapeHtml(t('bots.webhookLast', { status: w.lastStatus })) : ''}</span>
      </div>`;
    box.querySelector('#hk-secret').addEventListener('click', async () => {
      try {
        const res = await credentials.rotateSecret(editing);
        const typed = { url: box.querySelector('#hk-url').value, scope: box.querySelector('#hk-scope').value };
        replaceBot(res.bot);
        revealed = { kind: 'secret', value: res.secret };
        paintHook();
        box.querySelector('#hk-url').value = typed.url;
        box.querySelector('#hk-scope').value = typed.scope;
      } catch (err) { toast(apiErrorMessage(err, t('bots.webhookError')), { type: 'error' }); }
    });
    box.querySelector('#hk-test').addEventListener('click', async () => {
      const out = box.querySelector('#hk-test-out');
      out.textContent = '...';
      try {
        const res = await credentials.testWebhook(editing);
        replaceBot(res.bot);
        out.textContent = res.ok ? t('bots.webhookTestOk', { status: res.status }) : t('bots.webhookTestFail', { error: res.error });
      } catch (err) { out.textContent = apiErrorMessage(err, t('bots.webhookError')); }
    });
    wireReveal(box, 'secret');
  }

  render();
}
