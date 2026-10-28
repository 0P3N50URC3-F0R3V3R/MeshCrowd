import { api } from './api.js';
import { t } from './i18n.js';
import { escapeHtml, toast, apiErrorMessage } from './utils.js';

// The server answers 403 {code:'nsfw'} until the account has clicked through once.
export const isAgeGateError = (err) => !!err && err.status === 403 && !!err.body && err.body.code === 'nsfw';

// A plain click-through: nothing is checked and nothing leaves the server.
export function renderAgeGate(container, { channelName, onConfirmed, onLeave }) {
  container.innerHTML = `
    <div class="age-gate">
      <div class="age-gate-badge">18+</div>
      <h2>${escapeHtml(t('ageGate.title'))}</h2>
      <p>${escapeHtml(t('ageGate.body', { name: channelName || '' }))}</p>
      <div class="age-gate-actions">
        <button class="btn btn-secondary" data-age-leave>${escapeHtml(t('ageGate.leave'))}</button>
        <button class="btn btn-primary" data-age-confirm>${escapeHtml(t('ageGate.confirm'))}</button>
      </div>
    </div>`;
  container.querySelector('[data-age-leave]').addEventListener('click', () => onLeave?.());
  container.querySelector('[data-age-confirm]').addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try { await api.confirmAge(); onConfirmed?.(); }
    catch (err) { e.currentTarget.disabled = false; toast(apiErrorMessage(err, t('ageGate.error')), { type: 'error' }); }
  });
}
