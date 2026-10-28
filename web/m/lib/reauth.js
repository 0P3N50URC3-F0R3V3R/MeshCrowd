import { api } from '../../js/api.js';
import { toast, apiErrorMessage } from '../../js/utils.js';
import { t } from '../../js/i18n.js';
import { state } from '../../js/state.js';
import { currentCredential, currentCredentialField } from '../../js/passport/flow.js';
import { setReauthGate } from '../../js/reauth.js';
import { openSheet } from '../components/bottomSheet.js';

function askPassword() {
  return new Promise((resolve) => {
    let ok = false;
    openSheet({
      title: t('m.reauthTitle'),
      html: `<p class="m-confirm-text">${t('m.reauthHint')}</p>
        <input class="m-input" id="re-pw" type="password" autocomplete="current-password" enterkeyhint="done">
        <div class="m-confirm-row" style="margin-top:12px">
          <button class="btn btn-secondary" data-no>${t('m.cancel')}</button>
          <button class="btn btn-primary" data-yes>${t('m.reauthConfirm')}</button></div>`,
      onMount: (body, close) => {
        const input = body.querySelector('#re-pw');
        const yes = body.querySelector('[data-yes]');
        const submit = async () => {
          if (!input.value) return;
          yes.disabled = true;
          try {
            const cred = await currentCredential(state.me, input.value);
            await api.verifyPassword(currentCredentialField(cred));
            ok = true;
            close();
          } catch (err) {
            yes.disabled = false;
            input.value = '';
            toast(apiErrorMessage(err, t('m.reauthWrong')), { type: 'error' });
          }
        };
        body.querySelector('[data-no]').addEventListener('click', close);
        yes.addEventListener('click', submit);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
        setTimeout(() => input.focus(), 250);
      },
      onClose: () => resolve(ok),
    });
  });
}

export function installReauthGate() {
  setReauthGate(askPassword);
}
