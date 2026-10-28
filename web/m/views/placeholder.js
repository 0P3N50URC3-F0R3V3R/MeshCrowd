import { icons } from '../../js/icons.js';
import { t } from '../../js/i18n.js';
import { escapeHtml } from '../../js/utils.js';
import { nav } from '../router.js';

export function placeholderCardHtml() {
  return `<div class="m-empty m-placeholder"><h2>${t('m.desktopOnlyTitle')}</h2><p>${t('m.desktopOnlyBody')}</p>
    <a class="btn btn-primary" href="/?ui=desktop">${t('m.openDesktop')}</a></div>`;
}

export function mountPlaceholder(el, params) {
  el.innerHTML = `<div class="m-header"><button class="m-icon-btn" id="m-back">${icons.arrowLeft(22)}</button>
    <h1>${escapeHtml(params.name || '')}</h1></div>${placeholderCardHtml()}`;
  el.querySelector('#m-back').addEventListener('click', () => nav.back());
}
