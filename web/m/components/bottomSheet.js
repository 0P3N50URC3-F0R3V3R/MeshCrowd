import { escapeHtml } from '../../js/utils.js';
import { t } from '../../js/i18n.js';

let current = null; // { back, onClose }

export const hasOpenSheet = () => !!current;

function removeCurrent() {
  if (!current) return;
  const c = current;
  current = null;
  c.back.classList.remove('open');
  setTimeout(() => c.back.remove(), 200);
  c.onClose?.();
}

export function closeTopSheet() {
  if (!current) return false;
  removeCurrent();
  return true;
}

export function openSheet({ title = '', html = '', full = false, onMount, onClose } = {}) {
  removeCurrent();
  const back = document.createElement('div');
  back.className = `m-sheet-back${full ? ' full' : ''}`;
  back.innerHTML = `
    <div class="m-sheet" role="dialog">
      <div class="m-sheet-grip"></div>
      ${title ? `<div class="m-sheet-title">${escapeHtml(title)}</div>` : ''}
      <div class="m-sheet-body">${html}</div>
    </div>`;
  document.body.appendChild(back);
  requestAnimationFrame(() => back.classList.add('open'));
  current = { back, onClose };
  back.addEventListener('click', (e) => { if (e.target === back) closeTopSheet(); });
  const body = back.querySelector('.m-sheet-body');
  onMount?.(body, closeTopSheet);
  return { close: closeTopSheet, body };
}

// items: [{ id, icon?, label, sub?, danger? }] -> resolves with the chosen id, or null if dismissed.
// `header` is raw HTML shown above the items; any [data-id] inside it is selectable too.
export function actionSheet({ title = '', items, header = '' }) {
  return new Promise((resolve) => {
    let chosen = null;
    openSheet({
      title,
      html: header + items.map((it) => `
        <button class="m-sheet-item${it.danger ? ' danger' : ''}" data-id="${escapeHtml(it.id)}">
          ${it.icon ? `<span class="m-sheet-icon">${it.icon}</span>` : ''}
          <span class="m-sheet-label"><b>${escapeHtml(it.label)}</b>${it.sub ? `<small>${escapeHtml(it.sub)}</small>` : ''}</span>
        </button>`).join(''),
      onMount: (body, close) => body.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-id]');
        if (!btn) return;
        chosen = btn.dataset.id;
        close();
      }),
      onClose: () => resolve(chosen),
    });
  });
}

export function confirmSheet(message, { danger = true, okLabel } = {}) {
  return new Promise((resolve) => {
    let ok = false;
    openSheet({
      html: `<p class="m-confirm-text">${escapeHtml(message)}</p>
        <div class="m-confirm-row">
          <button class="btn btn-secondary" data-no>${t('m.cancel')}</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-yes>${escapeHtml(okLabel || t('m.delete'))}</button>
        </div>`,
      onMount: (body, close) => {
        body.querySelector('[data-no]').addEventListener('click', close);
        body.querySelector('[data-yes]').addEventListener('click', () => { ok = true; close(); });
      },
      onClose: () => resolve(ok),
    });
  });
}

export function promptSheet({ title = '', placeholder = '', okLabel, value = '', multiline = false, allowEmpty = false } = {}) {
  return new Promise((resolve) => {
    let result = null;
    const field = multiline
      ? `<textarea class="m-input" rows="3" placeholder="${escapeHtml(placeholder)}">${escapeHtml(value)}</textarea>`
      : `<input class="m-input" type="text" enterkeyhint="done" autocomplete="off" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(value)}">`;
    openSheet({
      title,
      html: `${field}<div class="m-confirm-row" style="margin-top:12px">
        <button class="btn btn-secondary" data-no>${t('m.cancel')}</button>
        <button class="btn btn-primary" data-yes>${escapeHtml(okLabel || t('m.save'))}</button></div>`,
      onMount: (body, close) => {
        const input = body.querySelector('.m-input');
        const submit = () => { result = input.value.trim(); close(); };
        body.querySelector('[data-no]').addEventListener('click', close);
        body.querySelector('[data-yes]').addEventListener('click', submit);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !multiline) { e.preventDefault(); submit(); } });
        setTimeout(() => input.focus(), 250);
      },
      onClose: () => resolve(result || (allowEmpty && result === '' ? '' : null)),
    });
  });
}

export function openImageViewer(url) {
  openSheet({ full: true, html: `<img class="m-viewer-img" src="${escapeHtml(url)}" alt="">` });
}
