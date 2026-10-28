import { api } from '../api.js';
import { state } from '../state.js';
import { escapeHtml, toast, apiErrorMessage } from '../utils.js';
import { t } from '../i18n.js';
import { openModal } from './modal.js';

const pad = (n) => String(n).padStart(2, '0');
const toLocalInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

function presets() {
  const now = new Date();
  const inMinutes = (m) => new Date(now.getTime() + m * 60_000);
  const tomorrow9 = new Date(now); tomorrow9.setDate(now.getDate() + 1); tomorrow9.setHours(9, 0, 0, 0);
  const monday9 = new Date(now); monday9.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7)); monday9.setHours(9, 0, 0, 0);
  return [
    { key: 'scheduled.in30m', at: inMinutes(30) },
    { key: 'scheduled.in1h', at: inMinutes(60) },
    { key: 'scheduled.tomorrow', at: tomorrow9 },
    { key: 'scheduled.monday', at: monday9 },
  ];
}

// "Send later" for the text in the composer, plus the list of everything you have scheduled.
// `scope` is {scopeType, scopeId}; with no content the modal is just the list.
export function openScheduleModal({ scope, content = '', replyToMessageId, onScheduled }) {
  const modal = openModal({
    title: content ? t('scheduled.title') : t('scheduled.listTitle'),
    render(body) { draw(body); },
  });

  async function draw(body) {
    let items = [];
    try { items = (await api.listScheduled()).scheduled; } catch { /* the list is optional */ }
    const when = (iso) => new Date(iso).toLocaleString();
    body.innerHTML = `
      ${content ? `
        <div class="field"><label>${t('scheduled.message')}</label>
          <textarea class="input" id="sc-content" rows="4" maxlength="${state.config.maxMessageChars || 15000}">${escapeHtml(content)}</textarea></div>
        <div class="field"><label>${t('scheduled.when')}</label>
          <input class="input" id="sc-when" type="datetime-local" value="${toLocalInput(presets()[1].at)}" style="max-width:260px">
          <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">${presets().map((p, i) => `<button type="button" class="btn btn-secondary" data-preset="${i}">${t(p.key)}</button>`).join('')}</div></div>
        <div class="error-text" id="sc-err"></div>
        <button class="btn btn-primary" id="sc-go">${t('scheduled.schedule')}</button>
        <div class="divider"></div>` : ''}
      <h4 style="margin:0 0 8px">${t('scheduled.yours')}</h4>
      ${items.length ? items.map((s) => `
        <div class="list-row" style="display:flex;align-items:center;gap:10px;padding:8px 10px">
          <div style="flex:1;min-width:0">
            <div class="hint">${escapeHtml(s.where || '?')} - ${escapeHtml(when(s.sendAt))}${s.status === 'failed' ? ` - <span style="color:var(--danger)">${escapeHtml(t('scheduled.failed', { reason: s.error || '' }))}</span>` : ''}</div>
            <div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(s.content)}</div>
          </div>
          <button class="btn btn-danger" data-cancel="${s.id}">${s.status === 'failed' ? t('scheduled.dismiss') : t('scheduled.cancel')}</button>
        </div>`).join('') : `<div class="hint">${t('scheduled.none')}</div>`}`;

    body.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => { body.querySelector('#sc-when').value = toLocalInput(presets()[Number(b.dataset.preset)].at); }));
    body.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
      try { await api.cancelScheduled(Number(b.dataset.cancel)); draw(body); }
      catch (err) { toast(apiErrorMessage(err, t('scheduled.error')), { type: 'error' }); }
    }));
    body.querySelector('#sc-go')?.addEventListener('click', async () => {
      const errEl = body.querySelector('#sc-err');
      errEl.textContent = '';
      const text = body.querySelector('#sc-content').value;
      const at = new Date(body.querySelector('#sc-when').value);
      if (Number.isNaN(at.getTime())) { errEl.textContent = t('scheduled.pickTime'); return; }
      try {
        await api.createScheduled({ ...scope, content: text, sendAt: at.toISOString(), replyToMessageId });
        toast(t('scheduled.done', { when: at.toLocaleString() }));
        modal.close();
        onScheduled?.();
      } catch (err) { errEl.textContent = apiErrorMessage(err, t('scheduled.error')); }
    });
  }
}
