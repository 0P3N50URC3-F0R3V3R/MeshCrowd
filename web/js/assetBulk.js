import { toast, escapeHtml } from './utils.js';
import { t } from './i18n.js';

// Shared by the emoji, sticker and sound editors: a multi-file "bulk upload" button and click-to-edit
// names. A file's name suggestion is its file name without extension, cleaned to the allowed
// characters (letters, numbers, underscore; 2-32 long).
export const ASSET_NAME_RE = /^[a-zA-Z0-9_]{2,32}$/;

export function suggestName(fileName) {
  const base = String(fileName || '').replace(/\.[^.]+$/, '');
  const clean = base.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);
  return clean.length >= 2 ? clean : `${clean || 'item'}_1`.slice(0, 32);
}

// Makes names unique against `taken` (lower-case names already on the server and earlier in this batch).
function uniqueName(name, taken) {
  let candidate = name;
  for (let i = 2; taken.has(candidate.toLowerCase()); i++) candidate = `${name.slice(0, 32 - String(i).length - 1)}_${i}`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

export function bulkUploadHtml(accept, id = 'bulk') {
  return `<div class="bulk-upload" style="margin-top:10px">
    <button type="button" class="btn btn-secondary" data-bulk-btn>${t('assetBulk.button')}</button>
    <input type="file" class="hidden" data-bulk-input multiple accept="${accept}">
    <div class="hint" data-bulk-status id="${id}-status" style="margin-top:6px"></div>
  </div>`;
}

// upload(name, file) -> Promise; existingNames: names already used; onDone(): refresh after the batch.
export function wireBulkUpload(root, { existingNames, upload, onDone }) {
  const btn = root.querySelector('[data-bulk-btn]');
  const input = root.querySelector('[data-bulk-input]');
  const status = root.querySelector('[data-bulk-status]');
  btn.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const files = [...input.files];
    input.value = '';
    if (!files.length) return;
    const taken = new Set(existingNames.map((n) => n.toLowerCase()));
    const failed = [];
    let done = 0;
    btn.disabled = true;
    for (const file of files) {
      const name = uniqueName(suggestName(file.name), taken);
      status.textContent = t('assetBulk.progress', { done, total: files.length, name });
      try { await upload(name, file); done += 1; } catch (err) { failed.push(`${file.name}: ${err?.message || ''}`); }
    }
    btn.disabled = false;
    status.innerHTML = failed.length ? `<span style="color:var(--danger)">${escapeHtml(t('assetBulk.failed', { n: failed.length }))}</span><br>${failed.map(escapeHtml).join('<br>')}` : '';
    toast(t('assetBulk.done', { done, total: files.length }), { type: failed.length ? 'error' : undefined });
    await onDone();
  });
}

// Turns every [data-rename-id] element into a text that becomes an input on click; Enter or blur saves.
export function wireInlineRename(root, { rename, onDone, prefix = '', suffix = '' }) {
  root.querySelectorAll('[data-rename-id]').forEach((el) => {
    el.style.cursor = 'text';
    el.title = t('assetBulk.renameHint');
    el.addEventListener('click', () => {
      if (el.querySelector('input')) return;
      const id = Number(el.dataset.renameId);
      const old = el.dataset.renameName;
      const input = document.createElement('input');
      input.className = 'input';
      input.value = old;
      input.maxLength = 32;
      input.style.cssText = 'width:100%;min-width:90px;padding:2px 6px;font-size:13px';
      el.textContent = '';
      el.appendChild(input);
      input.focus();
      input.select();
      let finished = false;
      const finish = async (save) => {
        if (finished) return;
        finished = true;
        const next = input.value.trim();
        if (!save || next === old) { el.textContent = `${prefix}${old}${suffix}`; return; }
        if (!ASSET_NAME_RE.test(next)) { toast(t('serverSettings.emojiNameValidationError'), { type: 'error' }); el.textContent = `${prefix}${old}${suffix}`; return; }
        try { await rename(id, next); await onDone(); } catch (err) { toast(err?.message || t('assetBulk.renameFailed'), { type: 'error' }); el.textContent = `${prefix}${old}${suffix}`; }
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); });
      input.addEventListener('blur', () => finish(true));
    });
  });
}
