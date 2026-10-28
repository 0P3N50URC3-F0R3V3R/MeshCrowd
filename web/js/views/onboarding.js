import { api } from '../api.js';
import { escapeHtml, toast, apiErrorMessage } from '../utils.js';
import { t } from '../i18n.js';
import { PERMISSIONS } from '../permissions.js';
import { openModal } from './modal.js';

// Roles a question may hand out must carry no moderation or management power (the server checks too).
const POWER_BITS = PERMISSIONS.ADMINISTRATOR | PERMISSIONS.MANAGE_ROLES | PERMISSIONS.MANAGE_SERVER | PERMISSIONS.MANAGE_CHANNELS
  | PERMISSIONS.MANAGE_MESSAGES | PERMISSIONS.KICK_MEMBERS | PERMISSIONS.BAN_MEMBERS | PERMISSIONS.MODERATE_MEMBERS
  | PERMISSIONS.MANAGE_NICKNAMES | PERMISSIONS.VIEW_AUDIT_LOG | PERMISSIONS.PRUNE_CONTENT | PERMISSIONS.MANAGE_BOTS;

// Shown to a member who still has to accept the rules. Closing it leaves them in view-only mode.
export function openScreeningModal({ serverId, serverName, onboarding, onDone }) {
  const m = openModal({
    title: t('onboarding.modalTitle', { name: serverName }),
    render(body) {
      body.innerHTML = `
        <p class="hint" style="margin:0 0 10px">${t('onboarding.modalHint')}</p>
        <div class="onboarding-rules" style="white-space:pre-wrap;word-break:break-word;max-height:240px;overflow:auto;padding:12px;background:var(--bg-primary-alt);border-radius:8px">${escapeHtml(onboarding.rules)}</div>
        ${onboarding.questions.map((q) => `
          <div class="field" data-q="${q.id}" style="margin-top:14px">
            <label>${escapeHtml(q.title)} <span class="hint">${q.multi ? t('onboarding.pickAny') : t('onboarding.pickOne')}</span></label>
            ${q.options.map((o) => `<label class="checkbox-row"><input type="${q.multi ? 'checkbox' : 'radio'}" name="q${q.id}" value="${o.id}"> ${escapeHtml(o.label)}</label>`).join('')}
          </div>`).join('')}
        <label class="checkbox-row" style="margin-top:14px"><input type="checkbox" id="ob-agree"> ${t('onboarding.agree')}</label>
        <div class="error-text" id="ob-err"></div>`;
    },
  });
  const footer = document.createElement('div');
  footer.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;width:100%';
  footer.innerHTML = `<button class="btn btn-ghost" data-later>${t('onboarding.later')}</button><button class="btn btn-primary" data-accept disabled>${t('onboarding.accept')}</button>`;
  const host = m.overlay.querySelector('.modal-footer');
  host.classList.remove('hidden');
  host.appendChild(footer);
  const agree = m.body.querySelector('#ob-agree');
  const accept = footer.querySelector('[data-accept]');
  agree.addEventListener('change', () => { accept.disabled = !agree.checked; });
  footer.querySelector('[data-later]').addEventListener('click', m.close);
  accept.addEventListener('click', async () => {
    const answers = {};
    for (const q of onboarding.questions) {
      answers[q.id] = [...m.body.querySelectorAll(`[name="q${q.id}"]:checked`)].map((i) => Number(i.value));
    }
    try {
      await api.acceptOnboarding(serverId, answers);
      m.close();
      toast(t('onboarding.accepted'));
      await onDone?.();
    } catch (err) { m.body.querySelector('#ob-err').textContent = apiErrorMessage(err, t('onboarding.acceptError')); }
  });
}

// Server Settings > Onboarding (Manage Server): the rules, and questions whose answers hand out roles.
export function renderOnboardingSettings(inner, { serverId, roles }) {
  inner.innerHTML = `<h2>${t('onboarding.title')}</h2><div id="ob-body"><div class="panel-loading" style="height:80px"><div class="spinner"></div></div></div>`;
  const body = inner.querySelector('#ob-body');
  const assignable = roles.filter((r) => !r.is_default && (r.permissions & POWER_BITS) === 0);
  let cfg = null;

  async function load() {
    try { cfg = (await api.getOnboarding(serverId)).config; draw(); }
    catch (err) { body.innerHTML = `<div class="empty-state"><p>${escapeHtml(apiErrorMessage(err, t('onboarding.loadError')))}</p></div>`; }
  }

  function readForm() {
    return {
      enabled: body.querySelector('#ob-enabled').checked,
      rules: body.querySelector('#ob-rules').value,
      questions: [...body.querySelectorAll('[data-qi]')].map((qEl) => ({
        title: qEl.querySelector('[data-title]').value.trim(),
        multi: qEl.querySelector('[data-multi]').checked,
        options: [...qEl.querySelectorAll('[data-oi]')].map((oEl) => ({
          label: oEl.querySelector('[data-label]').value.trim(),
          roleId: Number(oEl.querySelector('[data-role]').value) || null,
        })),
      })),
    };
  }

  function draw() {
    body.innerHTML = `
      <p class="hint" style="margin:0 0 12px">${t('onboarding.hint')}</p>
      <label class="checkbox-row"><input type="checkbox" id="ob-enabled" ${cfg.enabled ? 'checked' : ''}> ${t('onboarding.enable')}</label>
      <div class="field"><label>${t('onboarding.rules')}</label><textarea class="input" id="ob-rules" rows="8" maxlength="4000" placeholder="${escapeHtml(t('onboarding.rulesPlaceholder'))}">${escapeHtml(cfg.rules)}</textarea></div>
      <h3 style="margin:14px 0 6px">${t('onboarding.questions')}</h3>
      <p class="hint" style="margin:0 0 8px">${t('onboarding.questionsHint')}</p>
      <div id="ob-questions">
        ${cfg.questions.map((q, qi) => `
          <div class="settings-card" data-qi="${qi}" style="padding:12px;border:1px solid var(--border-subtle);border-radius:8px;margin-bottom:10px">
            <div style="display:flex;gap:8px;align-items:center">
              <input class="input" data-title maxlength="100" value="${escapeHtml(q.title)}" placeholder="${escapeHtml(t('onboarding.questionPlaceholder'))}" style="flex:1">
              <label class="checkbox-row" style="margin:0"><input type="checkbox" data-multi ${q.multi ? 'checked' : ''}> ${t('onboarding.multi')}</label>
              <button class="btn btn-danger" data-del-q="${qi}">${t('onboarding.remove')}</button>
            </div>
            <div style="margin-top:8px">
              ${q.options.map((o, oi) => `
                <div data-oi="${oi}" style="display:flex;gap:8px;align-items:center;margin-bottom:6px">
                  <input class="input" data-label maxlength="80" value="${escapeHtml(o.label)}" placeholder="${escapeHtml(t('onboarding.optionPlaceholder'))}" style="flex:1">
                  <select class="input" data-role style="max-width:200px">
                    <option value="">${t('onboarding.noRole')}</option>
                    ${assignable.map((r) => `<option value="${r.id}" ${o.roleId === r.id ? 'selected' : ''}>${escapeHtml(r.name)}</option>`).join('')}
                  </select>
                  <button class="btn btn-ghost" data-del-o="${qi}:${oi}">x</button>
                </div>`).join('')}
              <button class="btn btn-secondary" data-add-o="${qi}">${t('onboarding.addOption')}</button>
            </div>
          </div>`).join('')}
      </div>
      <button class="btn btn-secondary" id="ob-add-q" ${cfg.questions.length >= 5 ? 'disabled' : ''}>${t('onboarding.addQuestion')}</button>
      <div class="error-text" id="ob-err"></div>
      <div style="margin-top:12px"><button class="btn btn-primary" id="ob-save">${t('onboarding.save')}</button></div>`;

    const sync = () => { cfg = { ...cfg, ...readForm() }; };
    body.querySelector('#ob-add-q').addEventListener('click', () => { sync(); cfg.questions.push({ title: '', multi: false, options: [{ label: '', roleId: null }] }); draw(); });
    body.querySelectorAll('[data-del-q]').forEach((b) => b.addEventListener('click', () => { sync(); cfg.questions.splice(Number(b.dataset.delQ), 1); draw(); }));
    body.querySelectorAll('[data-add-o]').forEach((b) => b.addEventListener('click', () => { sync(); const q = cfg.questions[Number(b.dataset.addO)]; if (q.options.length < 10) q.options.push({ label: '', roleId: null }); draw(); }));
    body.querySelectorAll('[data-del-o]').forEach((b) => b.addEventListener('click', () => { sync(); const [qi, oi] = b.dataset.delO.split(':').map(Number); cfg.questions[qi].options.splice(oi, 1); draw(); }));
    body.querySelector('#ob-save').addEventListener('click', async () => {
      const errEl = body.querySelector('#ob-err');
      errEl.textContent = '';
      try {
        cfg = (await api.saveOnboarding(serverId, readForm())).config;
        toast(t('onboarding.saved'));
        draw();
      } catch (err) { errEl.textContent = apiErrorMessage(err, t('onboarding.saveError')); }
    });
  }

  load();
}
