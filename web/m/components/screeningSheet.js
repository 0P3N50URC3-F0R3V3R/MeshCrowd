import { api } from '../../js/api.js';
import { t } from '../../js/i18n.js';
import { escapeHtml, toast } from '../../js/utils.js';
import { handleError } from '../lib/errors.js';
import { openSheet } from './bottomSheet.js';

// A member who has not accepted the server's rules yet can read but not post; this is where they accept.
export function openScreeningSheet({ serverId, serverName, onboarding, onDone }) {
  openSheet({
    title: t('m.screeningTitle', { name: serverName }),
    html: `
      <div class="m-screening-rules" style="white-space:pre-wrap;word-break:break-word;max-height:38vh;overflow:auto;padding:4px 8px 10px">${escapeHtml(onboarding.rules)}</div>
      ${onboarding.questions.map((q) => `
        <div data-q="${q.id}" style="padding:6px 8px">
          <b>${escapeHtml(q.title)}</b>
          ${q.options.map((o) => `<label class="m-row" style="min-height:44px"><input type="${q.multi ? 'checkbox' : 'radio'}" name="q${q.id}" value="${o.id}"> <span class="m-grow">${escapeHtml(o.label)}</span></label>`).join('')}
        </div>`).join('')}
      <label class="m-row" style="min-height:48px"><input type="checkbox" id="m-agree"> <span class="m-grow">${t('m.screeningAgree')}</span></label>
      <div class="m-confirm-row" style="padding:8px"><button class="btn btn-primary" id="m-accept" disabled>${t('m.screeningAccept')}</button></div>`,
    onMount(body, close) {
      const agree = body.querySelector('#m-agree');
      const accept = body.querySelector('#m-accept');
      agree.addEventListener('change', () => { accept.disabled = !agree.checked; });
      accept.addEventListener('click', async () => {
        const answers = {};
        for (const q of onboarding.questions) answers[q.id] = [...body.querySelectorAll(`[name="q${q.id}"]:checked`)].map((i) => Number(i.value));
        try {
          await api.acceptOnboarding(serverId, answers);
          close();
          toast(t('m.screeningDone'));
          await onDone?.();
        } catch (err) { handleError(err, 'm.screeningFailed'); }
      });
    },
  });
}
