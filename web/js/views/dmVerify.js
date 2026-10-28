import { openModal } from './modal.js';
import { bus } from '../bus.js';
import { state } from '../state.js';
import { escapeHtml, toast, apiErrorMessage } from '../utils.js';
import { t } from '../i18n.js';
import { trustView, refreshTrust, getSafetyNumber, setPeerVerified, acceptPeerKey } from '../e2ee/dmCrypto.js';

// Safety-number dialog for an encrypted 1:1 DM. The number is computed from the server's current
// key for the peer, so while a key change is pending it shows the new number to compare.
export function openVerifyModal(dm) {
  const name = dm.members[0]?.displayName || '';
  const off = bus.on('e2ee:trust', ({ dmId }) => { if (dmId === dm.id && body.isConnected) paint(); });
  const { body, close } = openModal({ title: t('dmVerify.title'), onClose: () => off() });
  let number = null;
  let numberKey = null;

  async function paint() {
    const view = trustView(dm.id) || await refreshTrust(dm, state.me);
    const changed = view.status === 'changed';
    body.innerHTML = `
      <p class="verify-intro">${escapeHtml(t('dmVerify.intro', { name }))}</p>
      ${changed ? `<div class="e2ee-banner e2ee-banner-inline" role="alert">${escapeHtml(t('dmVerify.changedBody', { name }))}</div>` : ''}
      ${view.ownMismatch ? `<div class="e2ee-banner e2ee-banner-inline" role="alert">${escapeHtml(t('dmVerify.ownKeyBody', { name }))}</div>` : ''}
      <div class="safety-number-wrap">
        <div class="safety-number" id="verify-number" aria-label="${escapeHtml(t('dmVerify.numberLabel'))}"></div>
        <button class="btn btn-ghost" id="verify-copy" disabled>${escapeHtml(t('dmVerify.copy'))}</button>
      </div>
      <p class="verify-status ${view.verified ? 'is-verified' : ''}">${escapeHtml(view.verified ? t('dmVerify.statusVerified', { name }) : t('dmVerify.statusUnverified'))}</p>
      <p class="verify-hint">${escapeHtml(t('dmVerify.hint'))}</p>
      <div class="verify-actions"></div>`;
    const actions = body.querySelector('.verify-actions');
    const addButton = (label, cls, onClick) => {
      const b = document.createElement('button');
      b.className = `btn ${cls}`;
      b.textContent = label;
      b.addEventListener('click', async () => {
        b.disabled = true;
        try { await onClick(); } catch (err) { toast(apiErrorMessage(err, t('dmVerify.actionFailed')), { type: 'error' }); }
        b.disabled = false;
      });
      actions.appendChild(b);
    };
    if (changed) {
      addButton(t('dmVerify.acceptKey'), 'btn-danger', async () => { await acceptPeerKey(dm, state.me); toast(t('dmVerify.accepted')); });
    } else if (view.status === 'ok') {
      addButton(view.verified ? t('dmVerify.markUnverified') : t('dmVerify.markVerified'), view.verified ? 'btn-ghost' : 'btn-primary',
        () => setPeerVerified(dm, state.me, !view.verified));
    }
    addButton(t('common.close'), 'btn-ghost', async () => close());

    const numberEl = body.querySelector('#verify-number');
    const copyBtn = body.querySelector('#verify-copy');
    try {
      if (numberKey !== view.serverKey) { number = await getSafetyNumber(dm, state.me); numberKey = view.serverKey; }
      for (const group of number.split(' ')) {
        const span = document.createElement('span');
        span.textContent = group;
        numberEl.appendChild(span);
        numberEl.appendChild(document.createTextNode(' '));
      }
      copyBtn.disabled = false;
      copyBtn.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(number); toast(t('dmVerify.copied')); } catch { toast(t('dmVerify.copyFailed'), { type: 'error' }); }
      });
    } catch {
      numberEl.textContent = t('dmVerify.numberUnavailable');
    }
  }
  paint();
}
