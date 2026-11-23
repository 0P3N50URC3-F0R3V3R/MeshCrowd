import { api } from './api.js';
import { icons } from './icons.js';
import { t } from './i18n.js';
import { escapeHtml, apiErrorMessage } from './utils.js';
import { checklistLevel, checklistProgress, moveRow } from './checklistModel.mjs';

export const MAX_CHECKLIST_ITEMS = 50;

// Card markup shared by desktop chat, mobile chat and Notes. `level` overrides the computed access
// (Notes pass 'edit': the single owner can do everything). The title (the message text) is shown as the card's header.
export function checklistHtml(cl, meId, level = checklistLevel(cl, meId), title = '') {
  const { done, total } = checklistProgress(cl);
  const complete = total > 0 && done === total;
  return `<div class="cl-card${complete ? ' cl-done' : ''}" data-cl="${cl.id}">
    <div class="cl-head">${title ? `<span class="cl-title">${escapeHtml(title)}</span>` : ''}<span class="cl-progress">${t('checklist.progress', { done, total })}</span>${level === 'edit' ? `<button type="button" class="cl-edit" data-cl-edit title="${escapeHtml(t('checklist.editTitle'))}">${icons.edit(14)}</button>` : ''}</div>
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
// mode 'local':  { title, items: [{ id, text, checked }], onSave(items, title) }  — Notes, nothing is sent to the server; the title is optional there
export function openChecklistForm({ openPanel, mode, scope, message, members = [], items = [], title: localTitle = '', onSave, onDone, meId }) {
  const cl = message?.checklist;
  const title = mode === 'local' ? localTitle : (message?.content || '');
  let rows = mode === 'edit'
    ? cl.items.map((i) => ({ id: i.id, text: i.label, orig: i.label }))
    : mode === 'local' && items.length ? items.map((i) => ({ id: i.id, text: i.text, checked: i.checked })) : [{ text: '' }, { text: '' }];
  const helpers = new Map((cl?.editors || []).map((e) => [e.userId, e.level]));
  const showHelpers = mode !== 'local' && members.length > 0 && (mode === 'create' || cl.creatorId === meId);

  openPanel({
    title: mode === 'create' ? t('checklist.createTitle') : t('checklist.editTitle'),
    html: `${`<div class="field"><label>${t('checklist.titleLabel')}${mode === 'local' ? ` (${t('checklist.optional')})` : ''}</label><input class="input m-input" id="cl-title" maxlength="300" placeholder="${escapeHtml(t('checklist.titlePh'))}" value="${escapeHtml(title)}"></div>`}
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
        const byId = new Map(members.map((m) => [m.id, m]));
        const picked = new Set();
        const levelOpts = (sel) => `<option value="check"${sel === 'check' ? ' selected' : ''}>${t('checklist.helperCheck')}</option><option value="edit"${sel === 'edit' ? ' selected' : ''}>${t('checklist.helperEdit')}</option>`;
        hEl.innerHTML = `<div class="cl-helper-added" id="cl-h-added"></div>
          <input class="input m-input" id="cl-h-search" placeholder="${escapeHtml(t('checklist.helperSearchPh'))}" autocomplete="off">
          <div class="cl-helper-results" id="cl-h-results"></div>
          <div class="cl-helper cl-helper-bar"><select class="input m-input" id="cl-h-level">${levelOpts('check')}</select>
          <button type="button" class="btn btn-secondary btn-sm" id="cl-h-add" disabled></button></div>`;
        const addedEl = hEl.querySelector('#cl-h-added');
        const resultsEl = hEl.querySelector('#cl-h-results');
        const searchEl = hEl.querySelector('#cl-h-search');
        const addBtn = hEl.querySelector('#cl-h-add');
        const levelEl = hEl.querySelector('#cl-h-level');
        const MAX_SHOWN = 50;

        function drawAdded() {
          addedEl.innerHTML = [...helpers].map(([id, level]) => `<div class="cl-helper"><span>${escapeHtml(byId.get(id)?.name || `#${id}`)}</span>
            <span class="cl-helper-ctl"><select class="input m-input" data-helper="${id}">${levelOpts(level)}</select>
            <button type="button" class="btn-icon" data-h-rm="${id}" title="${escapeHtml(t('checklist.removeItem'))}">${icons.x(14)}</button></span></div>`).join('');
        }
        function drawResults() {
          const q = searchEl.value.trim().toLowerCase();
          const hits = members.filter((m) => !helpers.has(m.id) && (!q || m.name.toLowerCase().includes(q)));
          resultsEl.innerHTML = hits.slice(0, MAX_SHOWN).map((m) => `<label class="cl-helper"><span>${escapeHtml(m.name)}</span>
            <input type="checkbox" data-pick="${m.id}"${picked.has(m.id) ? ' checked' : ''}></label>`).join('')
            + (hits.length > MAX_SHOWN ? `<div class="cl-helper-more">${t('checklist.helperMore', { n: hits.length - MAX_SHOWN })}</div>` : '')
            + (hits.length ? '' : `<div class="cl-helper-more">${t('checklist.helperNoMatch')}</div>`);
          addBtn.textContent = t('checklist.helperAddSelected', { n: picked.size });
          addBtn.disabled = picked.size === 0;
        }
        searchEl.addEventListener('input', drawResults);
        searchEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
        resultsEl.addEventListener('change', (e) => {
          const id = Number(e.target.dataset.pick);
          if (e.target.checked) picked.add(id); else picked.delete(id);
          addBtn.textContent = t('checklist.helperAddSelected', { n: picked.size });
          addBtn.disabled = picked.size === 0;
        });
        addBtn.addEventListener('click', () => {
          for (const id of picked) helpers.set(id, levelEl.value);
          picked.clear(); drawAdded(); drawResults();
        });
        addedEl.addEventListener('change', (e) => {
          if (e.target.dataset.helper) helpers.set(Number(e.target.dataset.helper), e.target.value);
        });
        addedEl.addEventListener('click', (e) => {
          const b = e.target.closest('[data-h-rm]');
          if (!b) return;
          helpers.delete(Number(b.dataset.hRm)); drawAdded(); drawResults();
        });
        drawAdded(); drawResults();
      }

      saveBtn.addEventListener('click', async () => {
        err.textContent = '';
        const clean = rows.map((r) => ({ ...r, text: r.text.trim() })).filter((r) => r.text);
        const newTitle = body.querySelector('#cl-title').value.trim();
        if (mode !== 'local' && !newTitle) { err.textContent = t('checklist.titleRequired'); return; }
        if (!clean.length) { err.textContent = t('checklist.needItem'); return; }
        saveBtn.disabled = true;
        try {
          const editors = [...helpers].map(([userId, level]) => ({ userId, level }));
          if (mode === 'local') {
            onSave(clean.map((r) => ({ id: r.id || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`, text: r.text, checked: !!r.checked })), newTitle);
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
