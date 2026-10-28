import { t } from '../../js/i18n.js';
import { escapeHtml, toast, apiErrorMessage } from '../../js/utils.js';
import { state } from '../../js/state.js';
import { trustView, refreshTrust, getSafetyNumber, setPeerVerified, acceptPeerKey } from '../../js/e2ee/dmCrypto.js';
import { openSheet } from '../components/bottomSheet.js';

// Safety-number sheet for an encrypted 1:1 DM (the mobile twin of the desktop verify dialog).
export async function openVerifySheet(dm) {
  const name = dm.members[0]?.displayName || '';
  const view = trustView(dm.id) || await refreshTrust(dm, state.me);
  let number = '';
  try { number = await getSafetyNumber(dm, state.me); } catch { number = t('dmVerify.numberUnavailable'); }
  const changed = view.status === 'changed';
  openSheet({
    title: t('dmVerify.title'),
    html: `<p class="m-verify-intro">${escapeHtml(t('dmVerify.intro', { name }))}</p>
      ${changed ? `<div class="m-e2ee-banner" role="alert">${escapeHtml(t('dmVerify.changedBody', { name }))}</div>` : ''}
      ${view.ownMismatch ? `<div class="m-e2ee-banner" role="alert">${escapeHtml(t('dmVerify.ownKeyBody', { name }))}</div>` : ''}
      <div class="m-safety-number" aria-label="${escapeHtml(t('dmVerify.numberLabel'))}">${escapeHtml(String(number))}</div>
      <p class="m-verify-status">${escapeHtml(view.verified ? t('dmVerify.statusVerified', { name }) : t('dmVerify.statusUnverified'))}</p>
      <div class="m-confirm-row">
        ${changed ? `<button class="btn btn-danger" data-a="accept">${escapeHtml(t('dmVerify.acceptKey'))}</button>`
          : `<button class="btn btn-primary" data-a="${view.verified ? 'unverify' : 'verify'}">${escapeHtml(view.verified ? t('dmVerify.markUnverified') : t('dmVerify.markVerified'))}</button>`}
      </div>`,
    onMount: (body, close) => body.addEventListener('click', async (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (!a) return;
      try {
        if (a === 'accept') { await acceptPeerKey(dm, state.me); toast(t('dmVerify.accepted')); }
        else await setPeerVerified(dm, state.me, a === 'verify');
        close();
      } catch (err) { toast(apiErrorMessage(err, t('dmVerify.actionFailed')), { type: 'error' }); }
    }),
  });
}
