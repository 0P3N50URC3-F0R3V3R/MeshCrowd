import { api } from '../api.js';
import { escapeHtml, toast, apiErrorMessage } from '../utils.js';
import { t } from '../i18n.js';
import { confirmModal } from './modal.js';

const KINDS = ['keywords', 'links', 'mentions', 'spam', 'caps'];

function summary(rule) {
  const c = rule.config;
  switch (rule.kind) {
    case 'keywords': return t('automod.sumKeywords', { n: c.words.length });
    case 'links': return c.mode === 'block_all' ? t('automod.sumLinksAll') : t(c.mode === 'allowlist' ? 'automod.sumLinksAllow' : 'automod.sumLinksBlock', { n: c.domains.length });
    case 'mentions': return t('automod.sumMentions', { n: c.max });
    case 'spam': return t('automod.sumSpam', { n: c.maxMessages, s: c.windowSeconds, d: c.duplicates });
    case 'caps': return t('automod.sumCaps', { n: c.maxPercent, l: c.minLetters });
    default: return '';
  }
}

// Server Settings > AutoMod (Manage Server): rules checked before a message is stored, plus the hit log.
export function renderAutomod(inner, { serverId, roles, channels }) {
  inner.innerHTML = `<h2>${t('automod.title')}</h2><div id="am-body"><div class="panel-loading" style="height:80px"><div class="spinner"></div></div></div>`;
  const body = inner.querySelector('#am-body');
  let data = null;
  let editing = null; // { rule } or { kind } for a new one

  async function load() {
    try { data = await api.getAutomod(serverId); draw(); }
    catch (err) { body.innerHTML = `<div class="empty-state"><p>${escapeHtml(apiErrorMessage(err, t('automod.loadError')))}</p></div>`; }
  }

  function draw() {
    body.innerHTML = `
      <p class="hint" style="margin:0 0 12px">${t('automod.hint')}</p>
      <div id="am-list">
        ${data.rules.length ? data.rules.map((r) => `
          <div class="list-row" style="display:flex;align-items:center;gap:12px;padding:10px">
            <label style="display:flex;align-items:center;gap:6px"><input type="checkbox" data-toggle="${r.id}" ${r.enabled ? 'checked' : ''}></label>
            <div style="flex:1;min-width:0">
              <div style="font-weight:600">${escapeHtml(r.name)} <span class="hint">${t(`automod.kind_${r.kind}`)}</span></div>
              <div class="hint">${escapeHtml(summary(r))} - ${r.action === 'timeout' ? t('automod.actionTimeoutShort', { n: r.timeoutMinutes }) : t('automod.actionBlockShort')}</div>
            </div>
            <button class="btn btn-secondary" data-edit="${r.id}">${t('automod.edit')}</button>
            <button class="btn btn-danger" data-del="${r.id}">${t('automod.delete')}</button>
          </div>`).join('') : `<div class="empty-state" style="height:auto;padding:16px 0"><p>${t('automod.empty')}</p></div>`}
      </div>
      <div style="display:flex;gap:8px;align-items:center;margin:12px 0">
        <select class="input" id="am-newkind" style="max-width:260px">${KINDS.map((k) => `<option value="${k}">${t(`automod.kind_${k}`)}</option>`).join('')}</select>
        <button class="btn btn-primary" id="am-add">${t('automod.addRule')}</button>
      </div>
      <div id="am-form"></div>
      <div class="divider"></div>
      <h3 style="margin:0 0 8px">${t('automod.logTitle')}</h3>
      <div id="am-log">${data.log.length ? data.log.map((e) => `
        <div class="list-row" style="padding:8px 10px">
          <div class="hint">${escapeHtml(new Date(e.createdAt).toLocaleString())} - <b>${escapeHtml(e.user ? e.user.displayName : '?')}</b> - ${escapeHtml(e.ruleName)} - ${escapeHtml(e.action)}${e.channelName ? ` - #${escapeHtml(e.channelName)}` : ''}</div>
          <div style="font-family:monospace;font-size:12px;opacity:.8;white-space:pre-wrap;word-break:break-word">${escapeHtml(e.excerpt)}</div>
        </div>`).join('') : `<div class="empty-state" style="height:auto;padding:12px 0"><p>${t('automod.logEmpty')}</p></div>`}</div>`;

    body.querySelectorAll('[data-toggle]').forEach((cb) => cb.addEventListener('change', async () => {
      try { await api.updateAutomodRule(serverId, Number(cb.dataset.toggle), { enabled: cb.checked }); await load(); }
      catch (err) { toast(apiErrorMessage(err, t('automod.saveError')), { type: 'error' }); cb.checked = !cb.checked; }
    }));
    body.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => { editing = { rule: data.rules.find((r) => r.id === Number(b.dataset.edit)) }; drawForm(); }));
    body.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
      const rule = data.rules.find((r) => r.id === Number(b.dataset.del));
      confirmModal({
        title: t('automod.deleteTitle'),
        message: t('automod.deleteMessage', { name: escapeHtml(rule.name) }),
        confirmLabel: t('automod.delete'),
        async onConfirm() {
          try { await api.deleteAutomodRule(serverId, rule.id); editing = null; await load(); }
          catch (err) { toast(apiErrorMessage(err, t('automod.saveError')), { type: 'error' }); }
        },
      });
    }));
    body.querySelector('#am-add').addEventListener('click', () => { editing = { kind: body.querySelector('#am-newkind').value }; drawForm(); });
    if (editing) drawForm();
  }

  function configFields(kind, c) {
    switch (kind) {
      case 'keywords': return `
        <div class="field"><label>${t('automod.words')}</label>
          <textarea class="input" id="am-words" rows="5" placeholder="${escapeHtml(t('automod.wordsPlaceholder'))}">${escapeHtml((c.words || []).join('\n'))}</textarea>
          <div class="hint">${t('automod.wordsHint')}</div></div>
        <div class="field"><label><input type="checkbox" id="am-whole" ${c.wholeWord === false ? '' : 'checked'}> ${t('automod.wholeWord')}</label></div>`;
      case 'links': return `
        <div class="field"><label>${t('automod.linkMode')}</label>
          <select class="input" id="am-linkmode" style="max-width:320px">
            <option value="block_all" ${c.mode === 'block_all' || !c.mode ? 'selected' : ''}>${t('automod.linkBlockAll')}</option>
            <option value="allowlist" ${c.mode === 'allowlist' ? 'selected' : ''}>${t('automod.linkAllowlist')}</option>
            <option value="blocklist" ${c.mode === 'blocklist' ? 'selected' : ''}>${t('automod.linkBlocklist')}</option>
          </select></div>
        <div class="field"><label>${t('automod.domains')}</label>
          <textarea class="input" id="am-domains" rows="4" placeholder="example.com">${escapeHtml((c.domains || []).join('\n'))}</textarea>
          <div class="hint">${t('automod.domainsHint')}</div></div>`;
      case 'mentions': return `<div class="field"><label>${t('automod.maxMentions')}</label><input class="input" id="am-max" type="number" min="1" max="50" value="${c.max ?? 5}" style="width:100px"><div class="hint">${t('automod.maxMentionsHint')}</div></div>`;
      case 'spam': return `
        <div class="field"><label>${t('automod.maxMessages')}</label><input class="input" id="am-maxmsg" type="number" min="2" max="50" value="${c.maxMessages ?? 6}" style="width:100px"></div>
        <div class="field"><label>${t('automod.windowSeconds')}</label><input class="input" id="am-window" type="number" min="2" max="120" value="${c.windowSeconds ?? 8}" style="width:100px"></div>
        <div class="field"><label>${t('automod.duplicates')}</label><input class="input" id="am-dups" type="number" min="2" max="20" value="${c.duplicates ?? 3}" style="width:100px"></div>`;
      case 'caps': return `
        <div class="field"><label>${t('automod.minLetters')}</label><input class="input" id="am-minl" type="number" min="5" max="200" value="${c.minLetters ?? 12}" style="width:100px"></div>
        <div class="field"><label>${t('automod.maxPercent')}</label><input class="input" id="am-pct" type="number" min="30" max="100" value="${c.maxPercent ?? 70}" style="width:100px"></div>`;
      default: return '';
    }
  }

  function readConfig(kind, form) {
    const v = (sel) => form.querySelector(sel).value;
    switch (kind) {
      case 'keywords': return { words: v('#am-words').split('\n'), wholeWord: form.querySelector('#am-whole').checked };
      case 'links': return { mode: v('#am-linkmode'), domains: v('#am-domains').split('\n') };
      case 'mentions': return { max: Number(v('#am-max')) };
      case 'spam': return { maxMessages: Number(v('#am-maxmsg')), windowSeconds: Number(v('#am-window')), duplicates: Number(v('#am-dups')) };
      case 'caps': return { minLetters: Number(v('#am-minl')), maxPercent: Number(v('#am-pct')) };
      default: return {};
    }
  }

  function drawForm() {
    const form = body.querySelector('#am-form');
    const cur = editing.rule || null;
    const kind = cur ? cur.kind : editing.kind;
    const c = cur ? cur.config : {};
    const pickRoles = cur ? cur.exemptRoles : [];
    const pickChannels = cur ? cur.exemptChannels : [];
    form.innerHTML = `
      <div class="settings-card" style="padding:12px;border:1px solid var(--border-subtle);border-radius:8px">
        <h4 style="margin:0 0 8px">${cur ? t('automod.editRule') : t('automod.newRule')} - ${t(`automod.kind_${kind}`)}</h4>
        <div class="field"><label>${t('automod.name')}</label><input class="input" id="am-name" maxlength="60" value="${escapeHtml(cur ? cur.name : t(`automod.kind_${kind}`))}" style="max-width:360px"></div>
        ${configFields(kind, c)}
        <div class="field"><label>${t('automod.action')}</label>
          <select class="input" id="am-action" style="max-width:360px">
            <option value="block" ${!cur || cur.action === 'block' ? 'selected' : ''}>${t('automod.actionBlock')}</option>
            <option value="timeout" ${cur && cur.action === 'timeout' ? 'selected' : ''}>${t('automod.actionTimeout')}</option>
          </select></div>
        <div class="field" id="am-timeout-wrap"><label>${t('automod.timeoutMinutes')}</label><input class="input" id="am-timeout" type="number" min="1" max="40320" value="${cur ? cur.timeoutMinutes : 10}" style="width:120px"></div>
        <div class="field"><label>${t('automod.exemptRoles')}</label>
          <select class="input" id="am-exroles" multiple size="4" style="max-width:360px">${roles.filter((r) => !r.is_default).map((r) => `<option value="${r.id}" ${pickRoles.includes(r.id) ? 'selected' : ''}>${escapeHtml(r.name)}</option>`).join('')}</select></div>
        <div class="field"><label>${t('automod.exemptChannels')}</label>
          <select class="input" id="am-exch" multiple size="4" style="max-width:360px">${channels.map((ch) => `<option value="${ch.id}" ${pickChannels.includes(ch.id) ? 'selected' : ''}>#${escapeHtml(ch.name)}</option>`).join('')}</select>
          <div class="hint">${t('automod.exemptHint')}</div></div>
        <div class="error-text" id="am-err"></div>
        <div style="display:flex;gap:8px"><button class="btn btn-primary" id="am-save">${t('automod.save')}</button><button class="btn btn-secondary" id="am-cancel">${t('automod.cancel')}</button></div>
      </div>`;
    const action = form.querySelector('#am-action');
    const syncTimeout = () => { form.querySelector('#am-timeout-wrap').style.display = action.value === 'timeout' ? '' : 'none'; };
    action.addEventListener('change', syncTimeout);
    syncTimeout();
    form.querySelector('#am-cancel').addEventListener('click', () => { editing = null; form.innerHTML = ''; });
    form.querySelector('#am-save').addEventListener('click', async () => {
      const errEl = form.querySelector('#am-err');
      errEl.textContent = '';
      const selected = (sel) => [...form.querySelector(sel).selectedOptions].map((o) => Number(o.value));
      const payload = {
        name: form.querySelector('#am-name').value.trim(),
        config: readConfig(kind, form),
        action: action.value,
        timeoutMinutes: Number(form.querySelector('#am-timeout').value),
        exemptRoles: selected('#am-exroles'),
        exemptChannels: selected('#am-exch'),
      };
      try {
        if (cur) await api.updateAutomodRule(serverId, cur.id, payload);
        else await api.createAutomodRule(serverId, { ...payload, kind });
        editing = null;
        toast(t('automod.saved'));
        await load();
      } catch (err) { errEl.textContent = apiErrorMessage(err, t('automod.saveError')); }
    });
    form.scrollIntoView?.({ block: 'nearest' });
  }

  load();
}
