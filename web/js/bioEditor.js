import { applyFormat } from './bioMarkup.mjs';
import { t } from './i18n.js';

const SWATCHES = ['#e74c3c', '#e67e22', '#f1c40f', '#2ecc71', '#1abc9c', '#3498db', '#9b59b6', '#e84393'];

export function bioToolbarHtml(cls = 'bio-toolbar') {
  return `<div class="${cls}">
    <button type="button" data-fmt="bold" title="${t('bioEditor.bold')}"><b>B</b></button>
    <button type="button" data-fmt="italic" title="${t('bioEditor.italic')}"><i>I</i></button>
    ${SWATCHES.map((c) => `<button type="button" class="bio-swatch" data-fmt="color" data-color="${c}" style="background:${c}" title="${t('bioEditor.color')}" aria-label="${t('bioEditor.color')} ${c}"></button>`).join('')}
    <input type="color" data-fmt-custom value="#3498db" title="${t('bioEditor.customColor')}">
  </div>`;
}

export function wireBioToolbar(root, textarea, onChange) {
  const apply = (kind, color) => {
    const r = applyFormat(textarea.value, textarea.selectionStart, textarea.selectionEnd, kind, color);
    textarea.value = r.value;
    textarea.focus();
    textarea.setSelectionRange(r.selStart, r.selEnd);
    onChange();
  };
  root.addEventListener('mousedown', (e) => { if (e.target.closest('[data-fmt]')) e.preventDefault(); });
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-fmt]');
    if (b) apply(b.dataset.fmt, b.dataset.color);
  });
  root.querySelector('[data-fmt-custom]')?.addEventListener('change', (e) => apply('color', e.target.value));
}
