import { t } from './i18n.js';
import { NAME_EFFECTS } from './nameStyle.js';

// A small color row: "no color", preset swatches and a free color picker. The chosen value lives in
// the wrapper's data-value ('' for none); read it with readNameColor(root).
export const NAME_COLOR_PRESETS = ['#f04747', '#faa61a', '#43b581', '#3b82f6', '#9b59b6', '#1abc9c', '#e91e63', '#607d8b'];

export function nameColorPickerHtml(current, currentEffect = '') {
  const cur = (current || '').toLowerCase();
  const isPreset = NAME_COLOR_PRESETS.includes(cur);
  return `<div class="name-color-picker" data-value="${cur}">
    <div class="color-swatch-row">
      <div class="color-swatch ${cur ? '' : 'selected'}" data-nc="" title="${t('userSettings.nameColorNone')}" style="background:transparent;border:1px dashed var(--border-subtle)"></div>
      ${NAME_COLOR_PRESETS.map((c) => `<div class="color-swatch ${cur === c ? 'selected' : ''}" data-nc="${c}" style="background:${c}"></div>`).join('')}
      <input type="color" class="nc-custom ${cur && !isPreset ? 'selected' : ''}" value="${cur || '#3b82f6'}" title="${t('userSettings.nameColorCustom')}">
    </div>
    <div style="margin-top:8px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <select class="select nc-effect" style="width:auto"><option value="">${t('userSettings.nameEffectNone')}</option>${NAME_EFFECTS.map((e) => `<option value="${e}" ${e === currentEffect ? 'selected' : ''}>${t(`userSettings.nameEffect_${e}`)}</option>`).join('')}</select>
      <span class="nc-preview" style="font-weight:700;font-size:16px">${t('userSettings.nameEffectPreview')}</span>
    </div>
  </div>`;
}

export function wireNameColorPicker(root, onChange) {
  const box = root.querySelector('.name-color-picker');
  if (!box) return;
  const select = (value) => {
    box.dataset.value = value;
    box.querySelectorAll('[data-nc]').forEach((s) => s.classList.toggle('selected', s.dataset.nc === value));
    box.querySelector('.nc-custom').classList.toggle('selected', !!value && !NAME_COLOR_PRESETS.includes(value));
    paintPreview();
    onChange?.(value);
  };
  const paintPreview = () => {
    const p = box.querySelector('.nc-preview');
    const fx = box.querySelector('.nc-effect').value;
    p.className = `nc-preview${fx ? ` name-fx name-fx-${fx}` : ''}`;
    const color = box.dataset.value;
    p.style.color = color || '';
    p.style.setProperty('--nc', color || 'currentColor');
  };
  box.querySelector('.nc-effect').addEventListener('change', paintPreview);
  paintPreview();
  box.addEventListener('click', (e) => {
    const sw = e.target.closest('[data-nc]');
    if (sw) select(sw.dataset.nc);
  });
  box.querySelector('.nc-custom').addEventListener('input', (e) => select(e.target.value.toLowerCase()));
}

export const readNameEffect = (root) => root.querySelector('.nc-effect')?.value || '';
export const readNameColor = (root) => root.querySelector('.name-color-picker')?.dataset.value || '';
