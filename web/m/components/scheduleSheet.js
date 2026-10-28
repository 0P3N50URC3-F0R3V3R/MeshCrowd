import { t } from '../../js/i18n.js';
import { actionSheet, openSheet } from './bottomSheet.js';

const pad = (n) => String(n).padStart(2, '0');
const toLocalInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

// Resolves with a Date for "send later", or null when dismissed.
export async function pickSendTime() {
  const now = new Date();
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1); tomorrow.setHours(9, 0, 0, 0);
  const choice = await actionSheet({ title: t('m.sendLater'), items: [
    { id: '30', label: t('m.scheduleIn30m') },
    { id: '60', label: t('m.scheduleIn1h') },
    { id: 'tomorrow', label: t('m.scheduleTomorrow') },
    { id: 'custom', label: t('m.scheduleCustom') },
  ] });
  if (!choice) return null;
  if (choice === '30' || choice === '60') return new Date(now.getTime() + Number(choice) * 60_000);
  if (choice === 'tomorrow') return tomorrow;
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    openSheet({
      title: t('m.scheduleCustom'),
      html: `<div style="padding:8px"><input class="m-input" id="m-when" type="datetime-local" value="${toLocalInput(new Date(now.getTime() + 3600_000))}">
        <div class="m-confirm-row" style="margin-top:10px"><button class="btn btn-primary" id="m-when-ok">${t('m.sendLater')}</button></div></div>`,
      onMount(body, close) {
        body.querySelector('#m-when-ok').addEventListener('click', () => {
          const d = new Date(body.querySelector('#m-when').value);
          finish(Number.isNaN(d.getTime()) ? null : d);
          close();
        });
      },
      onClose: () => finish(null),
    });
  });
}
