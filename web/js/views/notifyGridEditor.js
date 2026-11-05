import { api } from '../api.js';
import { bus } from '../bus.js';
import { state } from '../state.js';
import { t } from '../i18n.js';
import { toast, apiErrorMessage } from '../utils.js';
import { STATUSES, EVENTS, SURFACES, isApplicable, defaultsGrid, isStatusModified, copyStatusPatch } from '../notifyGridModel.mjs';

const STATUS_LABEL = { online: 'common.statusOnline', idle: 'common.statusIdle', dnd: 'common.statusDnd', invisible: 'common.statusInvisible' };

// The per-status notification grid: pick a status tab, then switch each kind of event on or off for
// sound, pop-up, PC tray and Android. Every change is saved at once; the server answers with the
// full effective grid. Used by Settings on desktop/web and by the mobile "You" tab.
export function mountNotifyGridEditor(container) {
  let active = STATUSES.includes(state.me?.status) ? state.me.status : 'online';
  const grid = () => state.me.notifyGrid || defaultsGrid();

  async function save(body) {
    try {
      const res = await api.setNotifyGrid(body);
      state.me.notifyGrid = res.notifyGrid;
    } catch (err) { toast(apiErrorMessage(err), { type: 'error' }); }
    render();
  }

  function render() {
    const g = grid();
    const others = STATUSES.filter((s) => s !== active);
    container.innerHTML = `
      <div class="ng">
        <p class="ng-intro">${t('userSettings.notifyGridIntro')}</p>
        <div class="ng-tabs" role="tablist">
          ${STATUSES.map((s) => `<button type="button" role="tab" class="ng-tab ng-${s} ${s === active ? 'active' : ''}" data-status="${s}" aria-selected="${s === active}">${t(STATUS_LABEL[s])}${isStatusModified(g, s) ? '<span class="ng-dot" title="' + t('userSettings.notifyGridChanged') + '"></span>' : ''}</button>`).join('')}
        </div>
        ${active === 'online' && isStatusModified(g, 'online') ? `
          <div class="ng-warn" role="alert">
            <span>${t('userSettings.notifyGridOnlineWarning')}</span>
            <button type="button" class="btn btn-secondary" data-act="reset-online">${t('userSettings.notifyGridResetOnline')}</button>
          </div>` : ''}
        <div class="ng-scroll">
          <table class="ng-table">
            <thead><tr><th></th>${SURFACES.map((f) => `<th>${t('userSettings.notifyGridSurface_' + f)}</th>`).join('')}</tr></thead>
            <tbody>
              ${EVENTS.map((e) => `<tr><th scope="row">${t('userSettings.notifyGridEvent_' + e)}</th>${SURFACES.map((f) => {
                if (!isApplicable(e, f)) return `<td><span class="ng-cell na" title="${t('userSettings.notifyGridNotAvailable')}" aria-label="${t('userSettings.notifyGridNotAvailable')}">–</span></td>`;
                const on = !!g[active]?.[e]?.[f];
                return `<td><button type="button" class="ng-cell ${on ? 'on' : 'off'}" data-event="${e}" data-surface="${f}" role="switch" aria-checked="${on}" aria-label="${t('userSettings.notifyGridEvent_' + e)}, ${t('userSettings.notifyGridSurface_' + f)}">${on ? '✓' : '✕'}</button></td>`;
              }).join('')}</tr>`).join('')}
            </tbody>
          </table>
        </div>
        <div class="ng-actions">
          <label class="ng-copy">${t('userSettings.notifyGridCopyFrom')}
            <select class="input" id="ng-copy-from">${others.map((s) => `<option value="${s}">${t(STATUS_LABEL[s])}</option>`).join('')}</select>
          </label>
          <button type="button" class="btn btn-secondary" data-act="copy">${t('userSettings.notifyGridCopy')}</button>
          <span class="ng-spacer"></span>
          <button type="button" class="btn btn-secondary" data-act="reset-status">${t('userSettings.notifyGridResetStatus')}</button>
          <button type="button" class="btn btn-secondary" data-act="reset-all">${t('userSettings.notifyGridResetAll')}</button>
        </div>
      </div>`;
  }

  container.addEventListener('click', (ev) => {
    const tab = ev.target.closest('.ng-tab');
    if (tab) { active = tab.dataset.status; render(); return; }
    const cell = ev.target.closest('.ng-cell[data-event]');
    if (cell) {
      const { event, surface } = cell.dataset;
      save({ grid: { [active]: { [event]: { [surface]: !grid()[active]?.[event]?.[surface] } } } });
      return;
    }
    const act = ev.target.closest('[data-act]')?.dataset.act;
    if (act === 'reset-online') save({ reset: 'online' });
    else if (act === 'reset-status') save({ reset: active });
    else if (act === 'reset-all') save({ reset: 'all' });
    else if (act === 'copy') save({ grid: copyStatusPatch(grid(), container.querySelector('#ng-copy-from').value, active) });
  });

  // An edit made on another device arrives as a profile update; show it without a reload.
  const off = bus.on('state:me', () => { if (container.isConnected) render(); else off(); });
  render();
}
