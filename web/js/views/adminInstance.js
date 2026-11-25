import { api } from '../api.js';
import { escapeHtml, toast, apiErrorMessage } from '../utils.js';
import { t } from '../i18n.js';

const ICON_MAX_BYTES = 16384;

// The tracker advert carries the icon inline, so it is shrunk here until it fits: 128px first, then smaller.
async function iconToPng(file) {
  const bitmap = await createImageBitmap(file);
  for (const size of [128, 96, 64, 48, 32]) {
    const scale = Math.min(size / bitmap.width, size / bitmap.height, 1);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    if (blob && blob.size <= ICON_MAX_BYTES) return blob;
  }
  throw new Error(t('admin.instance.iconTooComplex'));
}

// Admin Panel > Instance: what this server calls itself on the login page and in tracker adverts,
// and whether it advertises itself to MeshSwarm trackers.
export function renderInstanceTab(inner) {
  inner.innerHTML = `<h2>${t('admin.instance.title')}</h2><div id="inst-body"><div class="panel-loading" style="height:80px"><div class="spinner"></div></div></div>`;
  const body = inner.querySelector('#inst-body');
  let profile = null;
  let swarm = null;

  async function load() {
    try { [profile, swarm] = await Promise.all([api.instanceGet(), api.swarmAdminGet()]); draw(); }
    catch (err) { body.innerHTML = `<div class="empty-state"><p>${escapeHtml(apiErrorMessage(err, t('admin.instance.loadError')))}</p></div>`; }
  }

  const when = (ms) => (ms ? new Date(ms).toLocaleString() : t('admin.instance.never'));

  function trackerRows() {
    const status = new Map((swarm.status || []).map((s) => [s.url, s]));
    return swarm.trackers.map((url, i) => {
      const s = status.get(url);
      const state = !s ? ''
        : s.ok ? `<span class="hint" style="color:var(--green)">${escapeHtml(t('admin.instance.trackerOk', { when: when(s.lastSuccess) }))}</span>`
          : `<span class="hint" style="color:var(--danger)">${escapeHtml(s.lastError || '')}</span>`;
      return `<div style="display:flex;gap:8px;align-items:center;margin-bottom:6px"><code style="flex:1;overflow-wrap:anywhere">${escapeHtml(url)}</code>${state}<button class="btn btn-ghost btn-sm" data-rm="${i}">${t('common.remove')}</button></div>`;
    }).join('');
  }

  function draw() {
    body.innerHTML = `
      <div class="field"><label>${t('admin.instance.nameLabel')}</label>
        <input class="input" id="inst-name" maxlength="60" value="${escapeHtml(profile.name)}"></div>
      <div class="field"><label>${t('admin.instance.descLabel')}</label>
        <textarea class="input textarea" id="inst-desc" rows="3" maxlength="300">${escapeHtml(profile.description)}</textarea></div>
      <div class="error-text" id="inst-err"></div>
      <button class="btn btn-primary" id="inst-save">${t('common.save')}</button>
      <div class="divider"></div>
      <div class="field"><label>${t('admin.instance.logoLabel')}</label>
        ${profile.hasLogo ? `<img src="/instance/logo?t=${Date.now()}" style="max-height:64px;max-width:240px;width:auto;height:auto;object-fit:contain;display:block;margin:0 auto 8px 0">` : ''}
        <input type="file" id="inst-logo" accept="image/png,image/jpeg,image/webp,image/gif">
        ${profile.hasLogo ? `<button class="btn btn-ghost btn-sm" id="inst-logo-rm">${t('common.remove')}</button>` : ''}
        <div class="hint">${t('admin.instance.logoHint')}</div></div>
      <div class="field"><label>${t('admin.instance.iconLabel')}</label>
        ${profile.hasIcon ? `<img src="/instance/icon?t=${Date.now()}" style="width:64px;height:64px;display:block;margin-bottom:8px">` : ''}
        <input type="file" id="inst-icon" accept="image/*">
        ${profile.hasIcon ? `<button class="btn btn-ghost btn-sm" id="inst-icon-rm">${t('common.remove')}</button>` : ''}
        <div class="hint">${t('admin.instance.iconHint')}</div></div>
      <div class="divider"></div>
      <h2>${t('admin.instance.swarmTitle')}</h2>
      <label class="checkbox-row"><input type="checkbox" id="sw-adv" ${swarm.advertise ? 'checked' : ''}><span>${t('admin.instance.advertiseLabel')}</span></label>
      <div class="hint">${t('admin.instance.advertiseHint')}</div>
      ${swarm.problem ? `<div class="error-text">${escapeHtml(t('admin.instance.problemLabel'))} ${escapeHtml(swarm.problem)}</div>` : ''}
      <div class="field" style="margin-top:12px"><label>${t('admin.instance.trackersLabel')}</label>
        <div id="sw-trackers">${trackerRows()}</div>
        <div style="display:flex;gap:8px"><input class="input" id="sw-new" placeholder="https://tracker.example.com:19898"><button class="btn btn-secondary" id="sw-add">${t('admin.instance.addTracker')}</button></div>
        <div class="hint">${t('admin.instance.trackersHint')}</div></div>
      <div class="error-text" id="sw-err"></div>
      <button class="btn btn-secondary" id="sw-announce" ${swarm.advertise ? '' : 'disabled'}>${t('admin.instance.announceNow')}</button>`;

    const err = body.querySelector('#inst-err');
    const swErr = body.querySelector('#sw-err');
    const attempt = (errBox, fn) => async () => {
      errBox.textContent = '';
      try { await fn(); } catch (e) { errBox.textContent = apiErrorMessage(e, e && e.message ? e.message : t('admin.instance.saveFailed')); }
    };
    const saveSwarm = (payload) => attempt(swErr, async () => { swarm = await api.swarmAdminUpdate(payload); draw(); toast(t('admin.instance.saved')); });

    body.querySelector('#inst-save').addEventListener('click', attempt(err, async () => {
      profile = await api.instanceUpdate({ name: body.querySelector('#inst-name').value, description: body.querySelector('#inst-desc').value });
      toast(t('admin.instance.saved'));
    }));
    body.querySelector('#inst-logo').addEventListener('change', (e) => attempt(err, async () => {
      if (e.target.files[0]) { profile = await api.instanceUploadLogo(e.target.files[0]); draw(); }
    })());
    body.querySelector('#inst-icon').addEventListener('change', (e) => attempt(err, async () => {
      if (!e.target.files[0]) return;
      profile = await api.instanceUploadIcon(new File([await iconToPng(e.target.files[0])], 'icon.png', { type: 'image/png' }));
      draw();
    })());
    body.querySelector('#inst-logo-rm')?.addEventListener('click', attempt(err, async () => { profile = await api.instanceRemoveLogo(); draw(); }));
    body.querySelector('#inst-icon-rm')?.addEventListener('click', attempt(err, async () => { profile = await api.instanceRemoveIcon(); draw(); }));

    body.querySelector('#sw-adv').addEventListener('change', (e) => saveSwarm({ advertise: e.target.checked })());
    body.querySelector('#sw-add').addEventListener('click', () => {
      const url = body.querySelector('#sw-new').value.trim();
      if (url) saveSwarm({ trackers: [...swarm.trackers, url] })();
    });
    body.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => saveSwarm({ trackers: swarm.trackers.filter((_, i) => i !== Number(b.dataset.rm)) })()));
    body.querySelector('#sw-announce').addEventListener('click', attempt(swErr, async () => { await api.swarmAnnounce(); swarm = await api.swarmAdminGet(); draw(); }));
  }

  load();
}
