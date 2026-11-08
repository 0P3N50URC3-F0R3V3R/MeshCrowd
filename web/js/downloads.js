import { t } from './i18n.js';
import { escapeHtml, formatBytes } from './utils.js';

let host = null;
const rows = new Map();

function ensureHost() {
  if (host && host.isConnected) return host;
  host = document.createElement('div');
  host.className = 'dl-stack';
  document.body.appendChild(host);
  return host;
}

function button(label, action, id) {
  return `<button type="button" class="btn btn-ghost btn-sm" data-dl="${action}" data-id="${id}">${escapeHtml(label)}</button>`;
}

function render(d) {
  let row = rows.get(d.id);
  if (!row) {
    row = document.createElement('div');
    row.className = 'dl-row';
    row.addEventListener('click', (e) => {
      const b = e.target.closest('[data-dl]');
      if (!b) return;
      const id = Number(b.dataset.id);
      const client = window.dismeshClient;
      if (b.dataset.dl === 'open') client.openDownload(id);
      else if (b.dataset.dl === 'show') client.showDownload(id);
      else if (b.dataset.dl === 'cancel') client.cancelDownload(id);
      else if (b.dataset.dl === 'close') { row.remove(); rows.delete(id); }
    });
    ensureHost().appendChild(row);
    rows.set(d.id, row);
  }
  const known = d.total > 0;
  const pct = known ? Math.min(100, Math.round((d.received / d.total) * 100)) : 0;
  const active = d.state === 'progressing' || d.state === 'paused';
  const status = d.state === 'completed' ? t('userSettings.dlDone')
    : d.state === 'cancelled' ? t('userSettings.dlCancelled')
    : d.state === 'interrupted' ? t('userSettings.dlFailed')
    : known ? `${formatBytes(d.received)} / ${formatBytes(d.total)} (${pct}%)` : formatBytes(d.received);
  row.dataset.state = d.state;
  row.innerHTML = `
    <div class="dl-name" title="${escapeHtml(d.path || d.name)}">${escapeHtml(d.name)}</div>
    <div class="dl-bar ${active && !known ? 'indeterminate' : ''}"><div style="width:${d.state === 'completed' ? 100 : pct}%"></div></div>
    <div class="dl-meta"><span>${escapeHtml(status)}</span><span class="dl-actions">
      ${active ? button(t('userSettings.dlCancel'), 'cancel', d.id) : ''}
      ${d.state === 'completed' ? button(t('userSettings.dlOpen'), 'open', d.id) + button(t('userSettings.dlShow'), 'show', d.id) : ''}
      ${active ? '' : button(t('userSettings.dlClose'), 'close', d.id)}
    </span></div>`;
  if (d.state === 'completed') {
    setTimeout(() => { if (row.isConnected && row.dataset.state === 'completed') { row.remove(); rows.delete(d.id); } }, 15000);
  }
}

if (window.dismeshClient?.onDownloadEvent) window.dismeshClient.onDownloadEvent(render);
