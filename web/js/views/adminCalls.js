import { api } from '../api.js';
import { escapeHtml, toast, apiErrorMessage } from '../utils.js';
import { t } from '../i18n.js';
import { resetIceServers } from './voice.js';

// Admin Panel > Calls: the built-in STUN/TURN server and any external ICE servers. Signaling
// always goes through this MeshCrowd server; only the audio and video between participants needs
// STUN/TURN, and only when two people cannot reach each other directly.
export function renderCallsTab(inner) {
  inner.innerHTML = `<h2>${t('admin.calls.title')}</h2><div id="calls-body"><div class="panel-loading" style="height:80px"><div class="spinner"></div></div></div>`;
  const body = inner.querySelector('#calls-body');
  let data = null;

  async function load() {
    try { data = await api.adminGetCalls(); draw(); }
    catch (err) { body.innerHTML = `<div class="empty-state"><p>${escapeHtml(apiErrorMessage(err, t('admin.calls.loadError')))}</p></div>`; }
  }

  const fmtBytes = (n) => (n > 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} kB`);

  function statusBlock() {
    const s = data.status;
    const dot = (color) => `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};margin-right:8px"></span>`;
    let line;
    if (!s.enabled) line = `${dot('var(--text-muted)')}${t('admin.calls.statusOff')}`;
    else if (s.running) line = `${dot('var(--green)')}${t('admin.calls.statusOn', { port: s.port })}`;
    else line = `${dot('var(--danger)')}${t('admin.calls.statusFailed')}${s.error ? `: ${escapeHtml(s.error)}` : ''}`;
    const warn = (key) => `<div class="hint" style="color:var(--danger);margin-top:6px">${t(`admin.calls.warn_${key}`)}</div>`;
    return `
      <div class="admin-stat-card" style="max-width:none;text-align:left;margin-bottom:16px">
        <div>${line}</div>
        ${s.running ? `<div class="hint" style="margin-top:6px">${t('admin.calls.statusDetail', { relays: s.allocations, total: s.allocationsTotal, data: fmtBytes(s.bytesRelayed) })}</div>` : ''}
        ${(s.warnings || []).map(warn).join('')}
      </div>`;
  }

  function draw() {
    const tn = data.turn;
    const ice = data.iceServers;
    body.innerHTML = `
      <p class="hint" style="margin:0 0 12px">${t('admin.calls.intro')}</p>
      ${statusBlock()}
      <h3 style="margin:0 0 8px">${t('admin.calls.builtInTitle')}</h3>
      <label class="check-row" style="display:flex;gap:8px;align-items:center;margin-bottom:12px"><input type="checkbox" id="tn-enabled" ${tn.enabled ? 'checked' : ''}> ${t('admin.calls.enable')}</label>
      <div class="field"><label>${t('admin.calls.externalIp')}</label>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><input class="input" id="tn-ip" value="${escapeHtml(tn.externalIp)}" placeholder="203.0.113.10" style="max-width:220px">
        <button class="btn btn-secondary" id="tn-detect" type="button">${t('admin.calls.detect')}</button></div>
        <div class="hint">${t('admin.calls.externalIpHint')}</div></div>
      <div class="field"><label>${t('admin.calls.port')}</label><input class="input" id="tn-port" type="number" min="1" max="65535" value="${tn.port}" style="max-width:140px">
        <label class="check-row" style="display:flex;gap:8px;align-items:center;margin-top:8px"><input type="checkbox" id="tn-tcp" ${tn.tcp ? 'checked' : ''}> ${t('admin.calls.tcp')}</label>
        <div class="hint">${t('admin.calls.portHint')}</div></div>
      <div class="field"><label>${t('admin.calls.relayRange')}</label>
        <div style="display:flex;gap:8px;align-items:center"><input class="input" id="tn-lo" type="number" min="1024" max="65535" value="${tn.relayPortMin}" style="max-width:120px"> – <input class="input" id="tn-hi" type="number" min="1024" max="65535" value="${tn.relayPortMax}" style="max-width:120px"></div>
        <div class="hint">${t('admin.calls.relayRangeHint')}</div></div>
      <details style="margin-bottom:12px"><summary style="cursor:pointer;margin-bottom:8px">${t('admin.calls.advanced')}</summary>
        <div class="field"><label>${t('admin.calls.advertisedHost')}</label><input class="input" id="tn-host" value="${escapeHtml(tn.advertisedHost)}" placeholder="${escapeHtml(data.publicHost || 'chat.example.com')}" style="max-width:320px"><div class="hint">${t('admin.calls.advertisedHostHint')}</div></div>
        <div class="field"><label>${t('admin.calls.perUser')}</label><input class="input" id="tn-peruser" type="number" min="1" value="${tn.maxAllocationsPerUser}" style="max-width:120px"></div>
        <div class="field"><label>${t('admin.calls.maxKbps')}</label><input class="input" id="tn-kbps" type="number" min="0" value="${tn.maxKbps}" style="max-width:160px"><div class="hint">${t('admin.calls.maxKbpsHint')}</div></div>
        <div class="field"><label>${t('admin.calls.ttlHours')}</label><input class="input" id="tn-ttl" type="number" min="1" max="168" value="${Math.round(tn.credentialTtlSeconds / 3600)}" style="max-width:120px"></div>
        <label class="check-row" style="display:flex;gap:8px;align-items:center;margin-bottom:6px"><input type="checkbox" id="tn-private" ${tn.allowPrivatePeers ? 'checked' : ''}> ${t('admin.calls.privatePeers')}</label>
        <div class="hint">${t('admin.calls.privatePeersHint')}</div>
        <button class="btn btn-secondary" id="tn-rotate" type="button" style="margin-top:10px">${t('admin.calls.rotate')}</button>
      </details>
      <div class="admin-stat-card" style="max-width:none;text-align:left;margin-bottom:12px">
        <b>${t('admin.calls.forwardTitle')}</b>
        <div class="hint" style="margin-top:6px">${t('admin.calls.forwardBody', { port: tn.port, lo: tn.relayPortMin, hi: tn.relayPortMax })}</div>
      </div>
      <div class="error-text" id="tn-err"></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-primary" id="tn-save">${t('common.save')}</button>
        <button class="btn btn-secondary" id="tn-test" type="button">${t('admin.calls.test')}</button>
      </div>
      <div id="tn-test-out" style="margin-top:12px"></div>
      <div class="divider"></div>
      <h3 style="margin:0 0 8px">${t('admin.calls.externalTitle')}</h3>
      <p class="hint" style="margin:0 0 12px">${t('admin.calls.externalHint')}</p>
      <div id="ice-list"></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
        <button class="btn btn-secondary" id="ice-add" type="button">${t('admin.calls.addServer')}</button>
        <button class="btn btn-primary" id="ice-save" type="button">${t('common.save')}</button>
      </div>
      <div class="error-text" id="ice-err"></div>`;

    const list = body.querySelector('#ice-list');
    const rows = ice.map((s) => ({ urls: (Array.isArray(s.urls) ? s.urls : [s.urls]).join(', '), username: s.username || '', credential: s.credential || '' }));
    function paintRows() {
      list.innerHTML = rows.map((r, i) => `
        <div class="field" style="border:1px solid var(--bg-active);border-radius:8px;padding:10px" data-row="${i}">
          <label>${t('admin.calls.urls')}</label><input class="input" data-k="urls" value="${escapeHtml(r.urls)}" placeholder="stun:stun.example.com:3478, turn:turn.example.com:3478">
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
            <input class="input" data-k="username" value="${escapeHtml(r.username)}" placeholder="${t('admin.calls.username')}" style="flex:1;min-width:140px">
            <input class="input" data-k="credential" value="${escapeHtml(r.credential)}" placeholder="${t('admin.calls.credential')}" style="flex:1;min-width:140px">
            <button class="btn btn-danger" data-del="${i}" type="button">${t('common.remove')}</button>
          </div>
        </div>`).join('') || `<div class="hint">${t('admin.calls.noExternal')}</div>`;
    }
    paintRows();
    list.addEventListener('input', (e) => {
      const row = e.target.closest('[data-row]');
      if (row && e.target.dataset.k) rows[Number(row.dataset.row)][e.target.dataset.k] = e.target.value;
    });
    list.addEventListener('click', (e) => {
      const del = e.target.closest('[data-del]');
      if (del) { rows.splice(Number(del.dataset.del), 1); paintRows(); }
    });
    body.querySelector('#ice-add').addEventListener('click', () => { rows.push({ urls: '', username: '', credential: '' }); paintRows(); });
    body.querySelector('#ice-save').addEventListener('click', async () => {
      const err = body.querySelector('#ice-err');
      err.textContent = '';
      const payload = rows.filter((r) => r.urls.trim()).map((r) => ({
        urls: r.urls.split(',').map((u) => u.trim()).filter(Boolean),
        ...(r.username ? { username: r.username } : {}), ...(r.credential ? { credential: r.credential } : {}),
      }));
      try { data = await api.adminUpdateCalls({ iceServers: payload }); resetIceServers(); toast(t('admin.calls.saved')); draw(); }
      catch (e2) { err.textContent = apiErrorMessage(e2, t('admin.couldNotSave')); }
    });

    const num = (id) => Number(body.querySelector(id).value);
    body.querySelector('#tn-detect').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try { body.querySelector('#tn-ip').value = (await api.adminDetectIp()).ip; }
      catch (err) { toast(apiErrorMessage(err, t('admin.calls.detectFailed')), { type: 'error' }); }
      btn.disabled = false;
    });
    const saveTurn = async (extra = {}) => {
      const err = body.querySelector('#tn-err');
      err.textContent = '';
      try {
        data = await api.adminUpdateCalls({
          turn: {
            enabled: body.querySelector('#tn-enabled').checked, externalIp: body.querySelector('#tn-ip').value.trim(),
            port: num('#tn-port'), tcp: body.querySelector('#tn-tcp').checked, relayPortMin: num('#tn-lo'), relayPortMax: num('#tn-hi'),
            advertisedHost: body.querySelector('#tn-host').value.trim(), maxAllocationsPerUser: num('#tn-peruser'), maxKbps: num('#tn-kbps'),
            credentialTtlSeconds: Math.round(num('#tn-ttl') * 3600), allowPrivatePeers: body.querySelector('#tn-private').checked, ...extra,
          },
        });
        resetIceServers();
        toast(t('admin.calls.saved'));
        draw();
      } catch (e2) { err.textContent = apiErrorMessage(e2, t('admin.couldNotSave')); }
    };
    body.querySelector('#tn-save').addEventListener('click', () => saveTurn());
    body.querySelector('#tn-rotate').addEventListener('click', () => saveTurn({ rotateSecret: true }));
    body.querySelector('#tn-test').addEventListener('click', async (e) => {
      const out = body.querySelector('#tn-test-out');
      const btn = e.currentTarget;
      btn.disabled = true;
      out.textContent = t('admin.calls.testing');
      try {
        const res = await api.adminTestCalls();
        out.innerHTML = res.checks.map((c) => `<div>${c.ok ? '✔' : '✖'} ${t(`admin.calls.check_${c.name}`)}${c.detail ? ` <span class="hint">${escapeHtml(c.detail)}</span>` : ''}</div>`).join('')
          + `<div class="hint" style="margin-top:6px">${t('admin.calls.testNote')}</div>`;
      } catch (err) { out.textContent = apiErrorMessage(err, t('admin.calls.testFailed')); }
      btn.disabled = false;
    });
  }

  load();
}
