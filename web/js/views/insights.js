import { api } from '../api.js';
import { escapeHtml, apiErrorMessage } from '../utils.js';
import { t } from '../i18n.js';

const RANGES = [7, 14, 30, 90];

// Bars as inline SVG (no chart library): one rect per value, the tallest fills the height.
function bars(values, { height = 90, labelFor }) {
  const max = Math.max(1, ...values.map((v) => v.count));
  const w = 100 / values.length;
  return `<svg viewBox="0 0 100 ${height}" preserveAspectRatio="none" style="width:100%;height:${height}px;display:block">
    ${values.map((v, i) => {
      const h = Math.round((v.count / max) * (height - 4));
      return `<rect x="${(i * w + w * 0.12).toFixed(2)}" y="${height - h}" width="${(w * 0.76).toFixed(2)}" height="${h}" rx="0.6" fill="var(--brand)"><title>${escapeHtml(labelFor(v))}</title></rect>`;
    }).join('')}
  </svg>`;
}

// Server Settings > Insights (Manage Server): activity and growth read from existing data.
export function renderInsights(inner, { serverId }) {
  inner.innerHTML = `<h2>${t('insights.title')}</h2><div id="in-body"><div class="panel-loading" style="height:80px"><div class="spinner"></div></div></div>`;
  const body = inner.querySelector('#in-body');
  let days = 30;

  async function load() {
    try { draw((await api.getServerInsights(serverId, days)).insights); }
    catch (err) { body.innerHTML = `<div class="empty-state"><p>${escapeHtml(apiErrorMessage(err, t('insights.loadError')))}</p></div>`; }
  }

  function card(label, value) {
    return `<div style="flex:1;min-width:130px;padding:12px;border:1px solid var(--border-subtle);border-radius:8px"><div class="hint">${escapeHtml(label)}</div><div style="font-size:24px;font-weight:700">${escapeHtml(String(value))}</div></div>`;
  }

  function list(items, render) {
    return items.length ? items.map(render).join('') : `<div class="hint">${t('insights.noData')}</div>`;
  }

  function draw(d) {
    body.innerHTML = `
      <p class="hint" style="margin:0 0 12px">${t('insights.hint')}</p>
      <div class="field"><select class="input" id="in-range" style="max-width:200px">${RANGES.map((r) => `<option value="${r}" ${r === days ? 'selected' : ''}>${t('insights.lastDays', { n: r })}</option>`).join('')}</select></div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px">
        ${card(t('insights.members'), d.members.total)}
        ${card(t('insights.online'), d.members.online)}
        ${card(t('insights.newMembers'), d.members.joinedInRange)}
        ${card(t('insights.messages'), d.messages.total)}
        ${card(t('insights.activeWeek'), d.activeMembers.last7)}
        ${card(t('insights.activeRange'), d.activeMembers.inRange)}
      </div>
      <h4 style="margin:0 0 6px">${t('insights.messagesPerDay')}</h4>
      ${bars(d.messages.byDay, { labelFor: (v) => `${v.day}: ${v.count}` })}
      <h4 style="margin:16px 0 6px">${t('insights.newMembersPerDay')}</h4>
      ${bars(d.members.joinedByDay, { labelFor: (v) => `${v.day}: ${v.count}` })}
      <h4 style="margin:16px 0 6px">${t('insights.byHour')}</h4>
      ${bars(d.messages.byHour.map((count, h) => ({ count, h })), { labelFor: (v) => `${String(v.h).padStart(2, '0')}:00 UTC: ${v.count}` })}
      <div style="display:flex;gap:24px;flex-wrap:wrap;margin-top:16px">
        <div style="flex:1;min-width:220px"><h4 style="margin:0 0 6px">${t('insights.topChannels')}</h4>
          ${list(d.topChannels, (c) => `<div class="list-row" style="display:flex;justify-content:space-between;padding:4px 8px"><span>#${escapeHtml(c.name)}</span><b>${c.count}</b></div>`)}</div>
        <div style="flex:1;min-width:220px"><h4 style="margin:0 0 6px">${t('insights.topMembers')}</h4>
          ${list(d.topMembers, (m) => `<div class="list-row" style="display:flex;justify-content:space-between;padding:4px 8px"><span>${escapeHtml(m.displayName)}</span><b>${m.count}</b></div>`)}</div>
      </div>
      <p class="hint" style="margin-top:12px">${t('insights.footnote')}</p>`;
    body.querySelector('#in-range').addEventListener('change', (e) => { days = Number(e.target.value); load(); });
  }

  load();
}
