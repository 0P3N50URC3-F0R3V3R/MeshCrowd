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
  const at = (days, h) => { const d = new Date(now); d.setDate(now.getDate() + days); d.setHours(h, 0, 0, 0); return d; };
  const monday9 = new Date(now); monday9.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7)); monday9.setHours(9, 0, 0, 0);
  return [
    { key: 'scheduled.in30m', at: inMinutes(30) },
    { key: 'scheduled.in1h', at: inMinutes(60) },
    { key: 'scheduled.in3h', at: inMinutes(180) },
    { key: 'scheduled.tonight', at: at(0, 20) },
    { key: 'scheduled.tomorrow', at: at(1, 9) },
    { key: 'scheduled.monday', at: monday9 },
  ].filter((p) => p.at.getTime() > now.getTime() + 60_000);
}

// "in 2 h 15 min" for a future date, so the exact moment is obvious without doing the sum.
function relative(date) {
  const mins = Math.round((date.getTime() - Date.now()) / 60_000);
  if (mins <= 0) return t('scheduled.inThePast');
  const d = Math.floor(mins / 1440); const h = Math.floor((mins % 1440) / 60); const m = mins % 60;
  return t('scheduled.relative', { when: [d ? `${d} ${t('scheduled.unitDay')}` : '', h ? `${h} ${t('scheduled.unitHour')}` : '', !d && m ? `${m} ${t('scheduled.unitMin')}` : ''].filter(Boolean).join(' ') });
}

// One editor used for a new message and for editing a pending one: text with a counter, a date/time
// field with presets and a live "in ..." line, in the viewer's own time zone.
function editorHtml({ id, text, when, submitLabel }) {
  const max = state.config.maxMessageChars || 15000;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  return `
    <div class="field"><label style="display:flex;justify-content:space-between"><span>${t('scheduled.message')}</span><span class="hint" data-count style="margin:0"></span></label>
      <textarea class="input" data-text rows="4" maxlength="${max}">${escapeHtml(text)}</textarea></div>
    <div class="field"><label>${t('scheduled.when')} <span class="hint" style="margin:0">(${escapeHtml(tz)})</span></label>
      <input class="input" data-when type="datetime-local" value="${toLocalInput(when)}" min="${toLocalInput(new Date())}" style="max-width:260px">
      <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">${presets().map((p, i) => `<button type="button" class="btn btn-secondary" data-preset="${i}">${t(p.key)}</button>`).join('')}</div>
      <div class="hint" data-relative style="margin-top:6px"></div></div>
    <div class="error-text" data-err></div>
    <div style="display:flex;gap:8px">${id ? `<button class="btn btn-ghost" data-cancel-edit>${t('common.cancel')}</button>` : ''}<button class="btn btn-primary" data-go>${submitLabel}</button></div>`;
}

function wireEditor(root, { onSubmit }) {
  const textEl = root.querySelector('[data-text]');
  const whenEl = root.querySelector('[data-when]');
  const max = state.config.maxMessageChars || 15000;
  const paint = () => {
    root.querySelector('[data-count]').textContent = `${[...textEl.value].length}/${max}`;
    const at = new Date(whenEl.value);
    root.querySelector('[data-relative]').textContent = Number.isNaN(at.getTime()) ? '' : relative(at);
  };
  textEl.addEventListener('input', paint);
  whenEl.addEventListener('input', paint);
  const list = presets();
  root.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => { whenEl.value = toLocalInput(list[Number(b.dataset.preset)].at); paint(); }));
  const timer = setInterval(() => { if (!root.isConnected) clearInterval(timer); else paint(); }, 30_000);
  paint();
  root.querySelector('[data-go]').addEventListener('click', async () => {
    const errEl = root.querySelector('[data-err]');
    errEl.textContent = '';
    const text = textEl.value;
    const at = new Date(whenEl.value);
    if (!text.trim()) { errEl.textContent = t('scheduled.emptyMessage'); return; }
    if (Number.isNaN(at.getTime())) { errEl.textContent = t('scheduled.pickTime'); return; }
    if (at.getTime() <= Date.now() + 30_000) { errEl.textContent = t('scheduled.mustBeFuture'); return; }
    try { await onSubmit(text, at); } catch (err) { errEl.textContent = apiErrorMessage(err, t('scheduled.error')); }
  });
}

// "Send later" for the text in the composer, plus the list of everything you have scheduled, where a
// pending message can be edited (text and time) or cancelled. With no content the modal is just the list.
export function openScheduleModal({ scope, content = '', replyToMessageId, onScheduled }) {
  const modal = openModal({
    title: content ? t('scheduled.title') : t('scheduled.listTitle'),
    render(body) { draw(body); },
  });
  let editingId = null;

  async function draw(body) {
    let items = [];
    try { items = (await api.listScheduled()).scheduled; } catch { /* the list is optional */ }
    const when = (iso) => new Date(iso).toLocaleString();
    body.innerHTML = `
      ${content ? `<div data-new>${editorHtml({ text: content, when: (presets()[1] || presets()[0] || { at: new Date(Date.now() + 3_600_000) }).at, submitLabel: t('scheduled.schedule') })}</div><div class="divider"></div>` : ''}
      <h4 style="margin:0 0 8px">${t('scheduled.yours')}</h4>
      ${items.length ? '<div data-items></div>' : `<div class="hint">${t('scheduled.none')}</div>`}`;

    const newEl = body.querySelector('[data-new]');
    if (newEl) {
      wireEditor(newEl, {
        async onSubmit(text, at) {
          await api.createScheduled({ ...scope, content: text, sendAt: at.toISOString(), replyToMessageId });
          toast(t('scheduled.done', { when: at.toLocaleString() }));
          modal.close();
          onScheduled?.();
        },
      });
    }

    const itemsEl = body.querySelector('[data-items]');
    for (const s of items) {
      const row = document.createElement('div');
      row.className = 'list-row';
      row.style.cssText = 'display:block;padding:8px 10px';
      if (editingId === s.id) {
        row.innerHTML = editorHtml({ id: s.id, text: s.content, when: new Date(s.sendAt), submitLabel: t('scheduled.saveChanges') });
        wireEditor(row, {
          async onSubmit(text, at) {
            await api.updateScheduled(s.id, { content: text, sendAt: at.toISOString() });
            editingId = null;
            toast(t('scheduled.updated'));
            draw(body);
          },
        });
        row.querySelector('[data-cancel-edit]').addEventListener('click', () => { editingId = null; draw(body); });
      } else {
        row.innerHTML = `
          <div style="display:flex;align-items:center;gap:10px">
            <div style="flex:1;min-width:0">
              <div class="hint">${escapeHtml(s.where || '?')} - ${escapeHtml(when(s.sendAt))}${s.status === 'failed' ? ` - <span style="color:var(--danger)">${escapeHtml(t('scheduled.failed'))}${s.error ? `: ${escapeHtml(s.error)}` : ''}</span>` : ''}</div>
              <div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(s.content)}</div>
            </div>
            ${s.status === 'failed' ? '' : `<button class="btn btn-secondary" data-edit="${s.id}">${t('scheduled.edit')}</button>`}
            <button class="btn btn-danger" data-cancel="${s.id}">${s.status === 'failed' ? t('scheduled.dismiss') : t('scheduled.cancel')}</button>
          </div>`;
        row.querySelector('[data-edit]')?.addEventListener('click', () => { editingId = s.id; draw(body); });
        row.querySelector('[data-cancel]').addEventListener('click', async () => {
          try { await api.cancelScheduled(s.id); draw(body); }
          catch (err) { toast(apiErrorMessage(err, t('scheduled.error')), { type: 'error' }); }
        });
      }
      itemsEl.appendChild(row);
    }
  }
}
