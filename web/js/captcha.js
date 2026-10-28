import { api } from './api.js';
import { t } from './i18n.js';

// The sign-in screens' captcha and bot traps. `kind` is 'login' or 'register'.
//   const cap = createCaptcha('login'); cap.mount(slotElement);
//   body = { ...credentials, ...cap.payload() };  if (!cap.ready()) ...;  on failure: await cap.refresh();
// The picture only appears when the server says it is needed (always, after failed attempts, or
// under attack); the honeypot input and timer are always there and invisible to people.
export function createCaptcha(kind) {
  const shownAt = Date.now();
  let slot = null;
  let required = false;
  let challenge = null;
  let loading = false;

  const answerInput = () => slot && slot.querySelector('[data-captcha-answer]');
  const trapInput = () => slot && slot.querySelector('[data-captcha-trap]');

  function draw() {
    if (!slot) return;
    const keepTrap = trapInput() ? trapInput().value : '';
    slot.innerHTML = `
      <input data-captcha-trap name="contact_extra" type="text" tabindex="-1" autocomplete="off" aria-hidden="true"
        style="position:absolute;left:-10000px;width:1px;height:1px;opacity:0" value="${keepTrap.replace(/"/g, '&quot;')}">
      ${required ? `
        <div class="field captcha-box">
          <label>${t('auth.captchaLabel')}</label>
          <div class="captcha-row" style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
            ${challenge
              ? `<img class="captcha-img" alt="${t('auth.captchaAlt')}" src="${challenge.image}" style="max-width:100%;height:auto;border-radius:6px;background:#fff">`
              : `<div class="spinner" style="width:20px;height:20px"></div>`}
            <button type="button" class="btn btn-secondary" data-captcha-reload title="${t('auth.captchaRefresh')}" aria-label="${t('auth.captchaRefresh')}">&#8635;</button>
          </div>
          <input class="input" data-captcha-answer type="text" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="${t('auth.captchaLabel')}">
          <div class="hint">${t('auth.captchaHint')}</div>
        </div>` : ''}`;
    slot.querySelector('[data-captcha-reload]')?.addEventListener('click', () => loadChallenge());
  }

  async function loadChallenge() {
    if (!required || loading) return;
    loading = true;
    challenge = null;
    draw();
    try { challenge = await api.captchaChallenge(); } catch { challenge = null; }
    loading = false;
    draw();
  }

  // Asks the server whether a captcha is needed right now and (re)loads a fresh picture if so.
  async function refresh() {
    let status;
    try { status = await api.captchaStatus(kind); } catch { status = { required }; }
    required = !!status.required;
    if (required) await loadChallenge(); else { challenge = null; draw(); }
  }

  return {
    mount(el) { slot = el; draw(); return refresh(); },
    refresh,
    ready() { return !required || (!!challenge && !!answerInput() && answerInput().value.trim().length > 0); },
    payload() {
      return {
        website: trapInput() ? trapInput().value : '',
        formMs: Date.now() - shownAt,
        ...(required && challenge && answerInput() ? { captchaId: challenge.id, captchaAnswer: answerInput().value.trim() } : {}),
      };
    },
    isRequired: () => required,
  };
}

// Server codes that deserve a specific, translated message on the sign-in screens.
export function captchaErrorMessage(err) {
  const code = err && err.body && err.body.code;
  if (code === 'captcha_required') return t('auth.captchaNeeded');
  if (code === 'captcha_invalid') return t('auth.captchaWrong');
  if (code === 'registration_limited') return t('auth.registrationLimited');
  if (code === 'rejected') return t('auth.requestRejected');
  return null;
}
