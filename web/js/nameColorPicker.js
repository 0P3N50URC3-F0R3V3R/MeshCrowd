import { t } from './i18n.js';
import { NAME_EFFECTS, nameAttrs } from './nameStyle.js';

// Name color + text effect editing, shared by the profile editors (desktop and phone) and the role
// editor. The color row is optional (roles keep their own swatches); the effect controls are
// nameFxControlsHtml / wireNameFxControls / readNameFx.
export const NAME_COLOR_PRESETS = ['#f04747', '#faa61a', '#43b581', '#3b82f6', '#9b59b6', '#1abc9c', '#e91e63', '#607d8b'];
export const MAX_FX_COLORS = 5;

const HEX = /^#[0-9a-f]{6}$/i;

// ---- effect controls: effect type, own color stops, speed, live preview ----------------------------
export function nameFxControlsHtml(effect = '', fx = {}) {
  const colors = (fx.colors || []).filter((c) => HEX.test(c));
  const speed = Number(fx.speed) > 0 ? Number(fx.speed) : 4;
  return `<div class="name-fx-controls" data-colors='${JSON.stringify(colors)}'>
    <div style="margin-top:8px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <select class="select nc-effect" style="width:auto"><option value="">${t('userSettings.nameEffectNone')}</option>${NAME_EFFECTS.map((e) => `<option value="${e}" ${e === effect ? 'selected' : ''}>${t(`userSettings.nameEffect_${e}`)}</option>`).join('')}</select>
      <span class="nc-preview" style="font-weight:700;font-size:16px">${t('userSettings.nameEffectPreview')}</span>
    </div>
    <details class="nc-advanced" style="margin-top:8px" ${colors.length || (Number(fx.speed) && Number(fx.speed) !== 4) ? 'open' : ''}>
      <summary style="cursor:pointer;color:var(--text-secondary);font-size:13px">${t('userSettings.nameFxAdvanced')}</summary>
      <div class="hint" style="margin:6px 0">${t('userSettings.nameFxColorsHint')}</div>
      <div class="nc-stops" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap"></div>
      <label style="display:flex;align-items:center;gap:8px;margin-top:8px;font-size:13px">${t('userSettings.nameFxSpeed')}
        <input type="range" class="nc-speed" min="0.5" max="12" step="0.5" value="${speed}" style="width:160px"> <span class="nc-speed-val"></span></label>
    </details>
  </div>`;
}

export function wireNameFxControls(root, getBaseColor = () => '') {
  const box = root.querySelector('.name-fx-controls');
  if (!box) return () => {};
  let colors = JSON.parse(box.dataset.colors || '[]');
  const preview = box.querySelector('.nc-preview');
  const stopsEl = box.querySelector('.nc-stops');
  const effectEl = box.querySelector('.nc-effect');
  const speedEl = box.querySelector('.nc-speed');
  const paint = () => {
    const fx = effectEl.value;
    const speed = Number(speedEl.value);
    box.querySelector('.nc-speed-val').textContent = `${speed}s`;
    // The same attribute builder the real names use, applied to the preview element.
    const holder = document.createElement('span');
    holder.innerHTML = `<i${nameAttrs({ color: getBaseColor() || null, effect: fx, colors, speed }, 'nc-preview')}></i>`;
    const el = holder.firstChild;
    preview.className = el.className;
    preview.setAttribute('style', `font-weight:700;font-size:16px;${el.getAttribute('style') || ''}`);
    stopsEl.innerHTML = `${colors.map((c, i) => `<span style="display:inline-flex;align-items:center;gap:2px"><input type="color" value="${c}" data-stop="${i}" class="nc-custom"><button type="button" class="btn-icon" data-stop-del="${i}" title="${t('userSettings.nameFxRemoveColor')}">×</button></span>`).join('')}
      ${colors.length < MAX_FX_COLORS ? `<button type="button" class="btn btn-secondary" data-stop-add>${t('userSettings.nameFxAddColor')}</button>` : ''}
      ${colors.length ? `<button type="button" class="btn btn-ghost" data-stop-clear>${t('userSettings.nameFxDefaultColors')}</button>` : ''}`;
  };
  stopsEl.addEventListener('click', (e) => {
    if (e.target.closest('[data-stop-add]')) colors.push(colors.length ? colors[colors.length - 1] : (getBaseColor() || '#3b82f6'));
    else if (e.target.closest('[data-stop-clear]')) colors = [];
    else if (e.target.closest('[data-stop-del]')) colors.splice(Number(e.target.closest('[data-stop-del]').dataset.stopDel), 1);
    else return;
    paint();
  });
  stopsEl.addEventListener('input', (e) => {
    const i = e.target.dataset.stop;
    if (i === undefined) return;
    colors[Number(i)] = e.target.value.toLowerCase();
    const holder = document.createElement('span');
    holder.innerHTML = `<i${nameAttrs({ color: getBaseColor() || null, effect: effectEl.value, colors, speed: Number(speedEl.value) }, 'nc-preview')}></i>`;
    preview.setAttribute('style', `font-weight:700;font-size:16px;${holder.firstChild.getAttribute('style') || ''}`);
  });
  effectEl.addEventListener('change', paint);
  speedEl.addEventListener('input', paint);
  paint();
  box.__colors = () => colors;
  return paint;
}

export const readNameEffect = (root) => root.querySelector('.name-fx-controls .nc-effect')?.value || '';
export function readNameFx(root) {
  const box = root.querySelector('.name-fx-controls');
  if (!box) return { colors: [], speed: 4 };
  const colors = (box.__colors ? box.__colors() : []).filter((c) => HEX.test(c)).slice(0, MAX_FX_COLORS);
  return { colors, speed: Number(box.querySelector('.nc-speed').value) || 4 };
}

// ---- own color row (profile editors) ---------------------------------------------------------------
export function nameColorPickerHtml(current, currentEffect = '', fx = {}) {
  const cur = (current || '').toLowerCase();
  const isPreset = NAME_COLOR_PRESETS.includes(cur);
  return `<div class="name-color-picker" data-value="${cur}">
    <div class="color-swatch-row">
      <div class="color-swatch ${cur ? '' : 'selected'}" data-nc="" title="${t('userSettings.nameColorNone')}" style="background:transparent;border:1px dashed var(--border-subtle)"></div>
      ${NAME_COLOR_PRESETS.map((c) => `<div class="color-swatch ${cur === c ? 'selected' : ''}" data-nc="${c}" style="background:${c}"></div>`).join('')}
      <input type="color" class="nc-custom ${cur && !isPreset ? 'selected' : ''}" value="${cur || '#3b82f6'}" title="${t('userSettings.nameColorCustom')}">
    </div>
    ${nameFxControlsHtml(currentEffect, fx)}
  </div>`;
}

export function wireNameColorPicker(root, onChange) {
  const box = root.querySelector('.name-color-picker');
  if (!box) return;
  const repaint = wireNameFxControls(box, () => box.dataset.value);
  const select = (value) => {
    box.dataset.value = value;
    box.querySelectorAll('[data-nc]').forEach((s) => s.classList.toggle('selected', s.dataset.nc === value));
    box.querySelector(':scope > .color-swatch-row .nc-custom').classList.toggle('selected', !!value && !NAME_COLOR_PRESETS.includes(value));
    repaint();
    onChange?.(value);
  };
  box.addEventListener('click', (e) => {
    const sw = e.target.closest('[data-nc]');
    if (sw) select(sw.dataset.nc);
  });
  box.querySelector(':scope > .color-swatch-row .nc-custom').addEventListener('input', (e) => select(e.target.value.toLowerCase()));
}

export const readNameColor = (root) => root.querySelector('.name-color-picker')?.dataset.value || '';
