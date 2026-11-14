import { api } from './api.js';
import { icons } from './icons.js';
import { t } from './i18n.js';
import { escapeHtml, apiErrorMessage } from './utils.js';
import { checklistLevel, checklistProgress, moveRow } from './checklistModel.mjs';

export const MAX_CHECKLIST_ITEMS = 50;

// Card markup shared by desktop chat, mobile chat and Notes. `level` overrides the computed access
// (Notes pass 'edit': the single owner can do everything). The title is the message text above the card.
export function checklistHtml(cl, meId, level = checklistLevel(cl, meId)) {
  const { done, total } = checklistProgress(cl);
  const complete = total > 0 && done === total;
  return `<div class="cl-card${complete ? ' cl-done' : ''}" data-cl="${cl.id}">
    <div class="cl-head"><span class="cl-progress">${t('checklist.progress', { done, total })}</span>${level === 'edit' ? `<button type="button" class="cl-edit" data-cl-edit title="${escapeHtml(t('checklist.editTitle'))}">${icons.edit(14)}</button>` : ''}</div>
    ${cl.items.map((i) => `<button type="button" class="cl-item${i.checked ? ' on' : ''}" data-cl-toggle="${i.id}"${level ? '' : ' disabled'}>
      <span class="cl-box">${i.checked ? icons.check(14) : ''}</span><span class="cl-label">${escapeHtml(i.label)}</span></button>`).join('')}
  </div>`;
}

export function toggleChecklistItem(cl, itemId) {
  const item = cl.items.find((i) => i.id === itemId);
  if (!item) return null;
  return item.checked ? api.uncheckChecklistItem(cl.id, itemId) : api.checkChecklistItem(cl.id, itemId);
}

// `openPanel({ title, html, onMount(body, close) })` is the host's modal (desktop) or sheet (mobile).
// mode 'create': { scope: { scopeType, scopeId }, members }
// mode 'edit':   { message, members, meId, onDone }  — message carries the serialized `checklist`; its title is `content`
// mode 'local':  { items: [{ id, text, checked }], onSave(items) }  — Notes, nothing is sent to the server
export function openChecklistForm({ openPanel, mode, scope, message, members = [], items = [], onSave, onDone, meId }) {
  const cl = message?.checklist;
  const title = message?.content || '';
  let rows = mode === 'edit'
    ? cl.items.map((i) => ({ id: i.id, text: i.label, orig: i.label }))
    : mode === 'local' && items.length ? items.map((i) => ({ id: i.id, text: i.text, checked: i.checked })) : [{ text: '' }, { text: '' }];
  const helpers = new Map((cl?.editors || []).map((e) => [e.userId, e.level]));
  const showHelpers = mode !== 'local' && members.length > 0 && (mode === 'create' || cl.creatorId === meId);

  openPanel({
    title: mode === 'create' ? t('checklist.createTitle') : t('checklist.editTitle'),
    html: `${mode === 'local' ? '' : `<div class="field"><label>${t('checklist.titleLabel')}</label><input class="input m-input" id="cl-title" maxlength="300" placeholder="${escapeHtml(t('checklist.titlePh'))}" value="${escapeHtml(title)}"></div>`}
      <div class="field"><label>${t('checklist.itemsLabel')}</label><div id="cl-rows"></div>
      <button type="button" class="btn btn-secondary btn-sm" id="cl-add">${icons.plus(14)} ${t('checklist.addItem')}</button></div>
      ${showHelpers ? `<div class="field"><label>${t('checklist.helpersLabel')}</label><div id="cl-helpers"></div></div>` : ''}
      <div class="error-text" id="cl-err"></div>
      <button type="button" class="btn btn-primary btn-block" id="cl-save">${mode === 'create' ? t('checklist.create') : t('checklist.save')}</button>`,
    onMount(body, close) {
      const rowsEl = body.querySelector('#cl-rows');
      const err = body.querySelector('#cl-err');
      const saveBtn = body.querySelector('#cl-save');

      function drawRows() {
        rowsEl.innerHTML = rows.map((r, n) => `<div class="cl-row">
          <input class="input m-input" data-n="${n}" maxlength="200" placeholder="${escapeHtml(t('checklist.itemPh', { n: n + 1 }))}" value="${escapeHtml(r.text)}">
          <button type="button" class="btn-icon" data-up="${n}" title="${escapeHtml(t('checklist.moveUp'))}">&uarr;</button>
          <button type="button" class="btn-icon" data-down="${n}" title="${escapeHtml(t('checklist.moveDown'))}">&darr;</button>
          <button type="button" class="btn-icon" data-rm="${n}" title="${escapeHtml(t('checklist.removeItem'))}">${icons.x(14)}</button></div>`).join('');
        body.querySelector('#cl-add').hidden = rows.length >= MAX_CHECKLIST_ITEMS;
      }
      rowsEl.addEventListener('input', (e) => { const n = e.target.dataset.n; if (n !== undefined) rows[Number(n)].text = e.target.value; });
      rowsEl.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.up !== undefined) rows = moveRow(rows, Number(b.dataset.up), -1);
        else if (b.dataset.down !== undefined) rows = moveRow(rows, Number(b.dataset.down), 1);
        else if (b.dataset.rm !== undefined) rows = rows.filter((_, n) => n !== Number(b.dataset.rm));
        drawRows();
      });
      body.querySelector('#cl-add').addEventListener('click', () => {
        rows.push({ text: '' }); drawRows();
        rowsEl.querySelector(`[data-n="${rows.length - 1}"]`)?.focus();
      });
      drawRows();

      if (showHelpers) {
        const hEl = body.querySelector('#cl-helpers');
        hEl.innerHTML = members.map((m) => `<div class="cl-helper"><span>${escapeHtml(m.name)}</span>
          <select class="input m-input" data-helper="${m.id}">
            <option value="">${t('checklist.helperNone')}</option>
            <option value="check"${helpers.get(m.id) === 'check' ? ' selected' : ''}>${t('checklist.helperCheck')}</option>
            <option value="edit"${helpers.get(m.id) === 'edit' ? ' selected' : ''}>${t('checklist.helperEdit')}</option></select></div>`).join('');
        hEl.addEventListener('change', (e) => {
          const id = Number(e.target.dataset.helper);
          if (e.target.value) helpers.set(id, e.target.value); else helpers.delete(id);
        });
      }

      saveBtn.addEventListener('click', async () => {
        err.textContent = '';
        const clean = rows.map((r) => ({ ...r, text: r.text.trim() })).filter((r) => r.text);
        const newTitle = mode === 'local' ? '' : body.querySelector('#cl-title').value.trim();
        if (mode !== 'local' && !newTitle) { err.textContent = t('checklist.titleRequired'); return; }
        if (!clean.length) { err.textContent = t('checklist.needItem'); return; }
        saveBtn.disabled = true;
        try {
          const editors = [...helpers].map(([userId, level]) => ({ userId, level }));
          if (mode === 'local') {
            onSave(clean.map((r) => ({ id: r.id || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`, text: r.text, checked: !!r.checked })));
          } else if (mode === 'create') {
            await api.createChecklist({ ...scope, title: newTitle, items: clean.map((r) => r.text), ...(showHelpers ? { editors } : {}) });
          } else {
            const res = await saveEdit(cl, newTitle !== title ? newTitle : null, clean, showHelpers ? editors : null);
            onDone?.(res);
          }
          close();
        } catch (e) {
          err.textContent = apiErrorMessage(e, t('checklist.couldNotSave'));
          saveBtn.disabled = false;
        }
      });
    },
  });
}

// Applies the form with the fewest calls: adds first (the list is never emptied), then renames,
// deletes, one full reorder, and the helper list when the creator is editing.
async function saveEdit(cl, newTitle, rows, editors) {
  let res = null;
  if (newTitle !== null) res = await api.setChecklistTitle(cl.id, newTitle);
  for (const r of rows.filter((x) => !x.id)) {
    res = await api.addChecklistItem(cl.id, r.text);
    r.id = res.message.checklist.items[res.message.checklist.items.length - 1].id;
  }
  for (const r of rows.filter((x) => x.orig !== undefined && x.text !== x.orig)) res = await api.renameChecklistItem(cl.id, r.id, r.text);
  const kept = new Set(rows.map((r) => r.id));
  for (const i of cl.items.filter((x) => !kept.has(x.id))) res = await api.deleteChecklistItem(cl.id, i.id);
  res = await api.orderChecklist(cl.id, rows.map((r) => r.id));
  if (editors) res = await api.setChecklistEditors(cl.id, editors);
  return res;
}
