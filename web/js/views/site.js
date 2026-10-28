import { bus } from '../bus.js';
import { api } from '../api.js';
import { icons } from '../icons.js';
import { state } from '../state.js';
import { escapeHtml, toast, apiErrorMessage } from '../utils.js';
import { confirmModal } from './modal.js';
import { openSiteSettings } from './siteSettings.js';
import { t } from '../i18n.js';

export const canEditSite = (server) => server.owner_id === state.me.id || !!state.me.canManageSites;

export function deleteSite(server) {
  confirmModal({
    title: t('sites.deleteConfirmTitle'),
    message: escapeHtml(t('sites.deleteConfirmMessage', { name: server.name })),
    confirmLabel: t('sites.deleteButton'),
    async onConfirm() {
      try {
        await api.siteDelete(server.id);
        bus.emit('ui:serverRemoved', server.id);
      } catch (err) {
        toast(apiErrorMessage(err, t('sites.couldNotDelete')), { type: 'error' });
      }
    },
  });
}

function openExternal(url) {
  let u;
  try { u = new URL(url); } catch { return; }
  if (!['http:', 'https:', 'mailto:'].includes(u.protocol)) return;
  if (window.dismeshClient?.openExternal) window.dismeshClient.openExternal(u.href);
  else window.open(u.href, '_blank', 'noopener,noreferrer');
}

export function mountSite(container, { server }) {
  const editable = canEditSite(server);
  container.innerHTML = `
    <div class="site-view">
      <div class="site-toolbar">
        <button class="btn-icon" data-act="back" title="${t('sites.toolbarBack')}">${icons.chevronsLeft(18)}</button>
        <button class="btn-icon" data-act="reload" title="${t('sites.toolbarReload')}">${icons.refresh(18)}</button>
        <div class="spacer"></div>
        <div class="site-php-status" id="site-php-status"></div>
        ${editable ? `
          <button class="btn btn-secondary" data-act="edit">${icons.edit(16)} ${t('sites.toolbarEdit')}</button>
          <button class="btn-icon" data-act="settings" title="${t('sites.toolbarSettings')}">${icons.gear(18)}</button>` : ''}
      </div>
      <div class="site-body" id="site-body"></div>
    </div>`;
  const body = container.querySelector('#site-body');
  let frame = null;
  let editor = null;
  let destroyed = false;

  function showFrame() {
    editor?.destroy?.();
    editor = null;
    body.innerHTML = `<iframe class="site-frame" referrerpolicy="no-referrer"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
      src="/site/${server.id}/"></iframe>`;
    frame = body.querySelector('iframe');
  }

  async function showEditor() {
    const { mountSiteEditor } = await import('./siteEditor.js');
    if (destroyed) return;
    frame = null;
    body.innerHTML = '';
    editor = mountSiteEditor(body, { server, onClose: showFrame });
  }

  function onMessage(e) {
    if (!frame || e.source !== frame.contentWindow || e.origin !== location.origin) return;
    const d = e.data;
    if (d && d.type === 'site-open-external' && typeof d.url === 'string') openExternal(d.url);
  }
  window.addEventListener('message', onMessage);

  container.querySelector('.site-toolbar').addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'back') { try { frame?.contentWindow.history.back(); } catch { /* cross-origin guard */ } }
    else if (act === 'reload') { if (frame) { try { frame.contentWindow.location.reload(); } catch { frame.src = frame.src; } } }
    else if (act === 'edit') showEditor();
    else if (act === 'settings') openSiteSettings(server);
  });

  const offAction = bus.on('ui:siteAction', ({ serverId, action }) => {
    if (serverId !== server.id) return;
    if (action === 'edit' && editable) showEditor();
    if (action === 'settings' && editable) openSiteSettings(server);
  });

  if (editable) {
    api.siteRuntime().then((s) => {
      if (destroyed || s.ok) return;
      container.querySelector('#site-php-status').textContent = t('sites.phpUnavailable', { reason: s.reason || 'unknown' });
    }).catch(() => { /* owners who are not site staff cannot read runtime status */ });
  }

  showFrame();
  return {
    destroy() {
      destroyed = true;
      window.removeEventListener('message', onMessage);
      offAction?.();
      editor?.destroy?.();
    },
  };
}

export function mountSiteSidebar(host, server) {
  const editable = canEditSite(server);
  host.innerHTML = `
    <div class="site-sidebar">
      <div class="site-sidebar-title">${escapeHtml(server.name)}</div>
      ${editable ? `
        <button class="btn btn-secondary" data-act="edit">${icons.edit(16)} ${t('sites.editButton')}</button>
        <button class="btn btn-secondary" data-act="settings">${icons.gear(16)} ${t('sites.settingsButton')}</button>
        <button class="btn btn-danger" data-act="delete">${icons.trash(16)} ${t('sites.deleteButton')}</button>` : ''}
    </div>`;
  host.querySelector('.site-sidebar').addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'delete') deleteSite(server);
    else if (act) bus.emit('ui:siteAction', { serverId: server.id, action: act });
  });
  return { destroy() { host.innerHTML = ''; } };
}
