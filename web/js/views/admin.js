import { api } from '../api.js';
import { state } from '../state.js';
import { icons } from '../icons.js';
import { avatarHtml, escapeHtml, toast, apiErrorMessage, el, formatBytes, navScroll, restoreNavScroll } from '../utils.js';
import { passReauth } from '../reauth.js';
import { SITE_PERMISSION_INFO, has } from '../permissions.js';
import { confirmModal, confirmTypedModal, openContextMenu, openModal } from './modal.js';
import { nextZIndex } from '../zstack.js';
import { renderStickerEditor } from './stickerEditor.js';
import { renderSoundEditor } from './soundEditor.js';
import { renderFederationTab } from './federationAdmin.js';
import { renderCallsTab } from './adminCalls.js';
import { renderSecurityTab } from './adminSecurity.js';
import { renderAdminAi } from './adminAi.js';
import { t } from '../i18n.js';
import { splitCredential } from '../passport/flow.js';
import { MIN_PASSWORD_LENGTH } from '../e2ee/crypto.mjs';

const ROLE_COLORS = ['#f04747', '#faa61a', '#43b581', '#3b82f6', '#9b59b6', '#1abc9c', '#e91e63', '#607d8b'];

// Site admin panel — only ever invoked when user.isSiteAdmin === true (see userSettings.js).
export function openAdminPanel() {
  passReauth().then((ok) => { if (ok) buildAdminPanel(); });
}

function buildAdminPanel() {
  let tab = 'overview';
  let stats = null;
  let users = [];
  let siteRoles = [];
  let selectedRoleId = null;
  let settings = null;
  let reports = [];
  let reportsStatus = 'open';
  let allServers = null; // null = not yet loaded
  let languages = null; // null = not yet loaded
  let selectedServerId = null;
  let serverStickers = null; // null = not yet loaded for selectedServerId
  let serverSounds = null; // null = not yet loaded for selectedServerId

  // data pruning (instance-wide, PRUNE_DATA)
  let pruneSubTab = 'channels'; // 'channels' | 'dms'
  let prunePickServers = null; // null = not loaded
  let prunePickServerId = null;
  let prunePickChannels = null; // null = not loaded for prunePickServerId
  let pruneSelectedChannelIds = new Set();
  let pruneDms = null; // null = not loaded
  let pruneSelectedDmId = null;
  let pruneCutoff = '';
  let prunePurgeAttachments = false;
  let pruneNotify = 'immediate';
  let prunePreview = null;

  const overlay = document.createElement('div');
  overlay.className = 'settings-overlay';
  overlay.style.zIndex = nextZIndex();
  document.body.appendChild(overlay);

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });

  async function loadAll() {
    const results = await Promise.allSettled([api.adminStats(), api.adminUsers(), api.adminSiteRoles(), api.adminGetSettings(), api.adminReports(reportsStatus)]);
    if (results[0].status === 'fulfilled') stats = results[0].value;
    if (results[1].status === 'fulfilled') users = results[1].value.users;
    if (results[2].status === 'fulfilled') siteRoles = results[2].value.roles;
    if (results[3].status === 'fulfilled') settings = results[3].value;
    if (results[4].status === 'fulfilled') reports = results[4].value.reports;
    render();
  }

  async function loadReports() {
    try { reports = (await api.adminReports(reportsStatus)).reports; }
    catch (err) { toast(apiErrorMessage(err, t('admin.couldNotLoadReports')), { type: 'error' }); }
    render();
  }

  function render() {
    const navX = navScroll(overlay);
    overlay.innerHTML = `
      <div class="settings-nav">
        <div class="snav-inner">
          <div class="snav-label">${t('admin.navLabel')}</div>
          <div class="snav-item ${tab === 'overview' ? 'active' : ''}" data-tab="overview">${t('admin.overviewTab')}</div>
          <div class="snav-item ${tab === 'users' ? 'active' : ''}" data-tab="users">${t('admin.usersTab')}</div>
          <div class="snav-item ${tab === 'roles' ? 'active' : ''}" data-tab="roles">${t('admin.staffRolesTab')}</div>
          <div class="snav-item ${tab === 'reports' ? 'active' : ''}" data-tab="reports">${t('admin.reportsTab')}${reports.length && reportsStatus === 'open' ? ` (${reports.length})` : ''}</div>
          <div class="snav-item ${tab === 'stickers' ? 'active' : ''}" data-tab="stickers">${t('admin.stickersTab')}</div>
          <div class="snav-item ${tab === 'soundboard' ? 'active' : ''}" data-tab="soundboard">${t('admin.soundboardTab')}</div>
          <div class="snav-item ${tab === 'ai' ? 'active' : ''}" data-tab="ai">${t('admin.aiTab')}</div>
          <div class="snav-item ${tab === 'languages' ? 'active' : ''}" data-tab="languages">${t('admin.languagesTab')}</div>
          ${state.me.isSiteAdmin ? `<div class="snav-item ${tab === 'calls' ? 'active' : ''}" data-tab="calls">${t('admin.calls.tab')}</div>` : ''}
          ${state.me.isSiteAdmin ? `<div class="snav-item ${tab === 'security' ? 'active' : ''}" data-tab="security">${t('admin.security.tab')}</div>` : ''}
          <div class="snav-item ${tab === 'prune' ? 'active' : ''}" data-tab="prune">${t('admin.dataPruningTab')}</div>
          ${state.config.federationEnabled ? `<div class="snav-item ${tab === 'federation' ? 'active' : ''}" data-tab="federation">${t('admin.federationTab')}</div>` : ''}
        </div>
      </div>
      <div class="settings-content"><div class="sc-inner" id="sc-inner"></div></div>
      <button class="settings-close" id="sc-close">${icons.x(18)}</button>`;

    restoreNavScroll(overlay, navX);
    overlay.querySelectorAll('[data-tab]').forEach((n) => n.addEventListener('click', () => { tab = n.dataset.tab; render(); }));
    overlay.querySelector('#sc-close').addEventListener('click', close);

    const inner = overlay.querySelector('#sc-inner');
    if (tab === 'overview') renderOverview(inner);
    else if (tab === 'users') renderUsers(inner);
    else if (tab === 'roles') renderRoles(inner);
    else if (tab === 'reports') renderReports(inner);
    else if (tab === 'stickers') renderStickersTab(inner);
    else if (tab === 'soundboard') renderSoundboardTab(inner);
    else if (tab === 'ai') renderAdminAi(inner);
    else if (tab === 'languages') renderLanguagesTab(inner);
    else if (tab === 'calls') renderCallsTab(inner);
    else if (tab === 'security') renderSecurityTab(inner);
    else if (tab === 'prune') renderPruneTab(inner);
    else if (tab === 'federation') renderFederationTab(inner);
  }

  // ---------------- stickers (any server, MANAGE_ANY_SERVER — not just servers you're in) ----------------
  function renderStickersTab(inner) {
    inner.innerHTML = `<h2>${t('admin.stickersTab')}</h2><div id="admin-stickers-body"></div>`;
    const body = inner.querySelector('#admin-stickers-body');

    if (allServers === null) {
      body.innerHTML = `<div class="panel-loading" style="height:80px"><div class="spinner"></div></div>`;
      api.adminListServers().then((res) => {
        allServers = res.servers;
        if (allServers.length && selectedServerId === null) selectedServerId = allServers[0].id;
        if (tab === 'stickers') renderStickersTab(inner);
      }).catch((err) => {
        body.innerHTML = `<div class="empty-state"><p>${escapeHtml(apiErrorMessage(err, t('admin.couldNotLoadServers')))}</p></div>`;
      });
      return;
    }

    if (allServers.length === 0) {
      body.innerHTML = `<div class="empty-state"><p>${t('admin.noServersExist')}</p></div>`;
      return;
    }

    body.innerHTML = `
      <div class="field">
        <label>${t('admin.serverLabel')}</label>
        <select class="input" id="admin-st-server" style="max-width:280px">
          ${allServers.map((s) => `<option value="${s.id}" ${s.id === selectedServerId ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
        </select>
      </div>
      <div id="admin-st-editor"></div>`;

    body.querySelector('#admin-st-server').addEventListener('change', (e) => {
      selectedServerId = Number(e.target.value);
      serverStickers = null;
      renderStickersTab(inner);
    });

    const editorEl = body.querySelector('#admin-st-editor');
    if (serverStickers === null) {
      editorEl.innerHTML = `<div class="panel-loading" style="height:80px"><div class="spinner"></div></div>`;
      api.adminListStickers(selectedServerId).then((res) => {
        serverStickers = res.stickers;
        if (tab === 'stickers') renderStickersTab(inner);
      }).catch((err) => {
        editorEl.innerHTML = `<div class="empty-state"><p>${escapeHtml(apiErrorMessage(err, t('admin.couldNotLoadStickers')))}</p></div>`;
      });
      return;
    }

    renderStickerEditor(editorEl, {
      stickers: serverStickers,
      upload: (name, description, file) => api.adminUploadSticker(selectedServerId, name, description, file),
      remove: (stickerId) => api.adminDeleteSticker(selectedServerId, stickerId),
      onChange: () => { serverStickers = null; renderStickersTab(inner); },
    });
  }

  // ---------------- soundboard (any server, MANAGE_ANY_SERVER) ----------------
  function renderSoundboardTab(inner) {
    inner.innerHTML = `<h2>${t('admin.soundboardTab')}</h2><div id="admin-sounds-body"></div>`;
    const body = inner.querySelector('#admin-sounds-body');

    if (allServers === null) {
      body.innerHTML = `<div class="panel-loading" style="height:80px"><div class="spinner"></div></div>`;
      api.adminListServers().then((res) => {
        allServers = res.servers;
        if (allServers.length && selectedServerId === null) selectedServerId = allServers[0].id;
        if (tab === 'soundboard') renderSoundboardTab(inner);
      }).catch((err) => {
        body.innerHTML = `<div class="empty-state"><p>${escapeHtml(apiErrorMessage(err, t('admin.couldNotLoadServers')))}</p></div>`;
      });
      return;
    }

    if (allServers.length === 0) {
      body.innerHTML = `<div class="empty-state"><p>${t('admin.noServersExist')}</p></div>`;
      return;
    }

    body.innerHTML = `
      <div class="field">
        <label>${t('admin.serverLabel')}</label>
        <select class="input" id="admin-sn-server" style="max-width:280px">
          ${allServers.map((s) => `<option value="${s.id}" ${s.id === selectedServerId ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
        </select>
      </div>
      <div id="admin-sn-editor"></div>`;

    body.querySelector('#admin-sn-server').addEventListener('change', (e) => {
      selectedServerId = Number(e.target.value);
      serverSounds = null;
      renderSoundboardTab(inner);
    });

    const editorEl = body.querySelector('#admin-sn-editor');
    if (serverSounds === null) {
      editorEl.innerHTML = `<div class="panel-loading" style="height:80px"><div class="spinner"></div></div>`;
      api.adminListSounds(selectedServerId).then((res) => {
        serverSounds = res.sounds;
        if (tab === 'soundboard') renderSoundboardTab(inner);
      }).catch((err) => {
        editorEl.innerHTML = `<div class="empty-state"><p>${escapeHtml(apiErrorMessage(err, t('admin.couldNotLoadSounds')))}</p></div>`;
      });
      return;
    }

    renderSoundEditor(editorEl, {
      sounds: serverSounds,
      upload: (name, emoji, file) => api.adminUploadSound(selectedServerId, name, emoji, file),
      remove: (soundId) => api.adminDeleteSound(selectedServerId, soundId),
      onChange: () => { serverSounds = null; renderSoundboardTab(inner); },
    });
  }

  // ---------------- languages (instance-wide, SITE_ADMINISTRATOR) ----------------
  function renderLanguagesTab(inner) {
    inner.innerHTML = `<h2>${t('admin.languagesHeading')}</h2><div id="admin-lang-body"></div>`;
    const body = inner.querySelector('#admin-lang-body');

    if (languages === null) {
      body.innerHTML = `<div class="panel-loading" style="height:80px"><div class="spinner"></div></div>`;
      api.adminListLanguages().then((res) => {
        languages = res.languages;
        if (tab === 'languages') renderLanguagesTab(inner);
      }).catch((err) => {
        body.innerHTML = `<div class="empty-state"><p>${escapeHtml(apiErrorMessage(err, 'Could not load languages.'))}</p></div>`;
      });
      return;
    }

    body.innerHTML = `
      <table class="admin-table">
        <thead><tr><th>${t('admin.codeLabel')}</th><th>${t('admin.nameLabel')}</th><th>${t('admin.enabledLabel')}</th><th></th></tr></thead>
        <tbody>
          ${languages.map((l) => `
            <tr>
              <td>${escapeHtml(l.code)}</td>
              <td>${escapeHtml(l.name)}${l.builtin ? ` <span class="badge">${t('admin.builtinBadge')}</span>` : ''}</td>
              <td><input type="checkbox" data-toggle="${l.code}" ${l.enabled ? 'checked' : ''} ${l.code === 'en' ? 'disabled' : ''}></td>
              <td>${!l.builtin ? `<button type="button" class="btn-icon" data-delete="${l.code}" title="${t('admin.deleteButton')}">${icons.x(16)}</button>` : ''}</td>
            </tr>`).join('')}
        </tbody>
      </table>
      <div class="divider"></div>
      <h3>${t('admin.uploadHeading')}</h3>
      <form id="admin-lang-upload">
        <div class="field">
          <label>${t('admin.codeLabel')}</label>
          <input class="input" id="lang-code" type="text" style="max-width:200px" required>
        </div>
        <div class="field">
          <label>${t('admin.nameLabel')}</label>
          <input class="input" id="lang-name" type="text" style="max-width:280px" required>
        </div>
        <div class="field">
          <label>${t('admin.fileLabel')}</label>
          <input class="input" id="lang-file" type="file" accept="application/json,.json" required>
        </div>
        <button type="submit" class="btn btn-primary">${t('admin.uploadButton')}</button>
      </form>`;

    body.querySelectorAll('[data-toggle]').forEach((cb) => {
      cb.addEventListener('change', async (e) => {
        const code = cb.dataset.toggle;
        try {
          await api.adminSetLanguageEnabled(code, e.target.checked);
          languages = null;
          renderLanguagesTab(inner);
        } catch (err) { toast(apiErrorMessage(err), { type: 'error' }); e.target.checked = !e.target.checked; }
      });
    });

    body.querySelectorAll('[data-delete]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const code = btn.dataset.delete;
        confirmModal({
          title: t('admin.confirmDeleteTitle'),
          message: t('admin.confirmDeleteMessage'),
          onConfirm: async () => {
            try {
              await api.adminDeleteLanguage(code);
              languages = null;
              renderLanguagesTab(inner);
            } catch (err) { toast(apiErrorMessage(err), { type: 'error' }); }
          },
        });
      });
    });

    body.querySelector('#admin-lang-upload').addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = body.querySelector('#lang-code').value.trim();
      const name = body.querySelector('#lang-name').value.trim();
      const file = body.querySelector('#lang-file').files[0];
      if (!file) return;
      try {
        const res = await api.adminUploadLanguage(code, name, file);
        toast(res.warnings?.length ? `${t('admin.uploadWarningsPrefix')}${res.warnings.join('; ')}` : t('admin.uploadSuccess'));
        languages = null;
        renderLanguagesTab(inner);
      } catch (err) { toast(apiErrorMessage(err), { type: 'error' }); }
    });
  }

  // ---------------- data pruning (instance-wide, PRUNE_DATA) ----------------
  function renderPruneTab(inner) {
    inner.innerHTML = `
      <h2>${t('admin.dataPruningTab')}</h2>
      <p class="hint" style="margin:-8px 0 16px">${t('admin.pruneIntro')}</p>
      <div class="tabs-row">
        <button type="button" class="tab-btn ${pruneSubTab === 'channels' ? 'active' : ''}" data-prune-subtab="channels">${t('admin.pruneServersChannelsTab')}</button>
        <button type="button" class="tab-btn ${pruneSubTab === 'dms' ? 'active' : ''}" data-prune-subtab="dms">${t('admin.pruneDmsGroupsTab')}</button>
      </div>
      <div id="prune-subtab-body" style="margin-top:16px"></div>`;

    inner.querySelectorAll('[data-prune-subtab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        pruneSubTab = btn.dataset.pruneSubtab;
        prunePreview = null;
        renderPruneTab(inner);
      });
    });

    const body = inner.querySelector('#prune-subtab-body');
    if (pruneSubTab === 'channels') renderPruneChannelsSub(inner, body);
    else renderPruneDmsSub(inner, body);
  }

  function pruneGraceNote() {
    return pruneNotify === 'grace' ? t('admin.graceNote') : '';
  }

  function pruneControlsHtml() {
    const attachmentClause = prunePurgeAttachments ? t('admin.pruneAttachmentClause', { count: prunePreview?.attachmentCount, size: prunePreview ? formatBytes(prunePreview.attachmentBytes) : '' }) : '';
    return `
      <div class="field">
        <label>${t('admin.deleteMessagesBeforeLabel')}</label>
        <input class="input" type="date" id="prune-cutoff" value="${escapeHtml(pruneCutoff)}" style="max-width:200px">
      </div>
      <label class="checkbox-row">
        <input type="checkbox" id="prune-attachments" ${prunePurgeAttachments ? 'checked' : ''}>
        ${t('admin.alsoDeleteAttachmentsCheckbox')}
      </label>
      <div class="field">
        <label>${t('admin.whenToDeleteLabel')}</label>
        <div class="tabs-row">
          <button type="button" class="tab-btn ${pruneNotify === 'immediate' ? 'active' : ''}" data-notify="immediate">${t('admin.immediatelyOption')}</button>
          <button type="button" class="tab-btn ${pruneNotify === 'grace' ? 'active' : ''}" data-notify="grace">${t('admin.after24hOption')}</button>
        </div>
      </div>
      ${prunePreview ? `
        <div class="empty-state" style="height:auto;padding:12px;border:1px solid var(--border);border-radius:var(--radius-sm);margin-bottom:12px;text-align:left">
          <p>${t('admin.pruneSummary', { count: prunePreview.messageCount, attachmentClause })}</p>
        </div>` : ''}
      <div class="error-text" id="prune-err"></div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-secondary" id="prune-preview-btn">${t('admin.previewButton')}</button>
        <button class="btn btn-danger" id="prune-execute-btn" ${prunePreview ? '' : 'disabled'}>${t('admin.pruneNowButton')}</button>
      </div>`;
  }

  function wirePruneControls(body, { getPreviewPayload, getExecutePayload, expectedText, confirmMessage, onDone, validate }) {
    body.querySelectorAll('[data-notify]').forEach((btn) => {
      btn.addEventListener('click', () => { pruneNotify = btn.dataset.notify; onDone(false); });
    });
    body.querySelector('#prune-attachments').addEventListener('change', (e) => {
      prunePurgeAttachments = e.target.checked;
      prunePreview = null;
      onDone(false);
    });
    body.querySelector('#prune-cutoff').addEventListener('change', (e) => { pruneCutoff = e.target.value; prunePreview = null; });

    body.querySelector('#prune-preview-btn').addEventListener('click', async () => {
      const errEl = body.querySelector('#prune-err');
      errEl.textContent = '';
      if (!pruneCutoff) { errEl.textContent = t('admin.pickCutoffDateError'); return; }
      const validationError = validate?.();
      if (validationError) { errEl.textContent = validationError; return; }
      try {
        prunePreview = await api.adminPrunePreview(getPreviewPayload());
        onDone(false);
      } catch (err) { errEl.textContent = apiErrorMessage(err, t('admin.couldNotPreview')); }
    });

    body.querySelector('#prune-execute-btn').addEventListener('click', () => {
      confirmTypedModal({
        title: t('admin.pruneDataTitle'),
        message: confirmMessage(),
        expectedText: expectedText(),
        confirmLabel: t('admin.pruneForeverButton'),
        onConfirm: async () => {
          try {
            const res = await api.adminPruneExecute(getExecutePayload());
            prunePreview = null;
            toast(res.status === 'scheduled' ? t('admin.pruneScheduledToast') : t('admin.prunedMessagesToast', { count: res.messageCount }));
            onDone(true);
          } catch (err) { toast(apiErrorMessage(err, t('admin.couldNotPrune')), { type: 'error' }); }
        },
      });
    });
  }

  function renderPruneChannelsSub(inner, body) {
    if (prunePickServers === null) {
      body.innerHTML = `<div class="panel-loading" style="height:80px"><div class="spinner"></div></div>`;
      api.adminPruneServers().then((res) => {
        prunePickServers = res.servers;
        if (prunePickServers.length && prunePickServerId === null) prunePickServerId = prunePickServers[0].id;
        if (tab === 'prune') renderPruneChannelsSub(inner, body);
      }).catch((err) => {
        body.innerHTML = `<div class="empty-state"><p>${escapeHtml(apiErrorMessage(err, t('admin.couldNotLoadServers')))}</p></div>`;
      });
      return;
    }
    if (prunePickServers.length === 0) {
      body.innerHTML = `<div class="empty-state"><p>${t('admin.noServersExist')}</p></div>`;
      return;
    }
    if (prunePickChannels === null) {
      body.innerHTML = `<div class="panel-loading" style="height:80px"><div class="spinner"></div></div>`;
      api.adminPruneServerChannels(prunePickServerId).then((res) => {
        prunePickChannels = res.channels;
        if (tab === 'prune') renderPruneChannelsSub(inner, body);
      }).catch((err) => {
        body.innerHTML = `<div class="empty-state"><p>${escapeHtml(apiErrorMessage(err, t('admin.couldNotLoadChannels')))}</p></div>`;
      });
      return;
    }

    body.innerHTML = `
      <div class="field">
        <label>${t('admin.serverLabel')}</label>
        <select class="input" id="prune-server" style="max-width:280px">
          ${prunePickServers.map((s) => `<option value="${s.id}" ${s.id === prunePickServerId ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>${t('admin.channelsLabel')}</label>
        ${prunePickChannels.map((ch) => `
          <label class="checkbox-row">
            <input type="checkbox" data-prune-ch="${ch.id}" ${pruneSelectedChannelIds.has(ch.id) ? 'checked' : ''}>
            #${escapeHtml(ch.name)}
          </label>`).join('')}
      </div>
      ${pruneControlsHtml()}`;

    body.querySelector('#prune-server').addEventListener('change', (e) => {
      prunePickServerId = Number(e.target.value);
      prunePickChannels = null;
      pruneSelectedChannelIds = new Set();
      prunePreview = null;
      renderPruneChannelsSub(inner, body);
    });
    body.querySelectorAll('[data-prune-ch]').forEach((cb) => {
      cb.addEventListener('change', () => {
        const id = Number(cb.dataset.pruneCh);
        if (cb.checked) pruneSelectedChannelIds.add(id); else pruneSelectedChannelIds.delete(id);
        prunePreview = null;
        renderPruneChannelsSub(inner, body);
      });
    });

    const ids = [...pruneSelectedChannelIds];
    wirePruneControls(body, {
      validate: () => (ids.length === 0 ? t('admin.selectAtLeastOneChannel') : null),
      getPreviewPayload: () => ({ scopeKind: 'channels', channelIds: ids, cutoff: pruneCutoff, purgeAttachments: prunePurgeAttachments }),
      getExecutePayload: () => ({ scopeKind: 'channels', channelIds: ids, cutoff: pruneCutoff, purgeAttachments: prunePurgeAttachments, notify: pruneNotify }),
      expectedText: () => {
        const names = prunePickChannels.filter((c) => ids.includes(c.id)).map((c) => c.name);
        return ids.length === 1 ? names[0] : prunePickServers.find((s) => s.id === prunePickServerId)?.name || '';
      },
      confirmMessage: () => {
        const server = prunePickServers.find((s) => s.id === prunePickServerId);
        const attachmentClause = prunePurgeAttachments ? t('admin.pruneChannelsAttachmentClause', { count: prunePreview.attachmentCount }) : '';
        return t('admin.pruneChannelsConfirmMessage', {
          messageCount: prunePreview.messageCount, attachmentClause, channelCount: ids.length,
          server: escapeHtml(server?.name || ''), graceNote: pruneGraceNote(),
        });
      },
      onDone: (reset) => {
        if (reset) pruneSelectedChannelIds = new Set();
        renderPruneChannelsSub(inner, body);
      },
    });
  }

  function renderPruneDmsSub(inner, body) {
    if (pruneDms === null) {
      body.innerHTML = `<div class="panel-loading" style="height:80px"><div class="spinner"></div></div>`;
      api.adminPruneDms().then((res) => {
        pruneDms = res.conversations;
        if (tab === 'prune') renderPruneDmsSub(inner, body);
      }).catch((err) => {
        body.innerHTML = `<div class="empty-state"><p>${escapeHtml(apiErrorMessage(err, t('admin.couldNotLoadConversations')))}</p></div>`;
      });
      return;
    }
    if (pruneDms.length === 0) {
      body.innerHTML = `<div class="empty-state"><p>${t('admin.noDmsExist')}</p></div>`;
      return;
    }

    const selected = pruneDms.find((c) => c.id === pruneSelectedDmId) || null;
    body.innerHTML = `
      <p class="hint" style="margin-top:0">${t('admin.sortedBySpaceHint')}</p>
      <div id="prune-dm-list">
        ${pruneDms.map((c) => `
          <div class="list-row" data-prune-dm="${c.id}" style="cursor:pointer${c.id === pruneSelectedDmId ? ';background:var(--bg-active)' : ''}">
            <div class="lr-main">
              <div class="lr-title">${c.isGroup ? `${t('admin.groupPrefix')} ` : ''}${escapeHtml((c.name && c.isGroup ? c.name + ' — ' : '') + c.participants.map((p) => p.displayName).join(', '))}</div>
              <div class="lr-sub">${t('admin.dmMessageCount', { count: c.messageCount })} · ${formatBytes(c.sizeBytes)}${c.lastActivity ? t('admin.lastActivitySuffix', { date: new Date(c.lastActivity).toLocaleDateString() }) : ''}</div>
            </div>
          </div>`).join('')}
      </div>
      ${selected ? `<div class="divider"></div>${pruneControlsHtml()}` : ''}`;

    body.querySelectorAll('[data-prune-dm]').forEach((row) => {
      row.addEventListener('click', () => {
        pruneSelectedDmId = Number(row.dataset.pruneDm);
        prunePreview = null;
        renderPruneDmsSub(inner, body);
      });
    });

    if (!selected) return;

    wirePruneControls(body, {
      getPreviewPayload: () => ({ scopeKind: 'dm', dmChannelId: selected.id, cutoff: pruneCutoff, purgeAttachments: prunePurgeAttachments }),
      getExecutePayload: () => ({ scopeKind: 'dm', dmChannelId: selected.id, cutoff: pruneCutoff, purgeAttachments: prunePurgeAttachments, notify: pruneNotify }),
      expectedText: () => (selected.isGroup && selected.name) || selected.participants.map((p) => p.displayName).join(', '),
      confirmMessage: () => {
        const attachmentClause = prunePurgeAttachments ? t('admin.pruneChannelsAttachmentClause', { count: prunePreview.attachmentCount }) : '';
        return t('admin.pruneDmConfirmMessage', { messageCount: prunePreview.messageCount, attachmentClause, graceNote: pruneGraceNote() });
      },
      onDone: (reset) => {
        if (reset) { pruneDms = null; pruneSelectedDmId = null; }
        renderPruneDmsSub(inner, body);
      },
    });
  }

  function renderOverview(inner) {
    const regMode = settings?.registrationMode ?? 'open';
    const ttl = settings?.sessionTtlDays ?? 30;
    const maxUploadMb = settings?.maxUploadMb ?? 25;
    const allowedExt = (settings?.allowedAttachmentExtensions || []).join(', ');
    inner.innerHTML = `
      <h2>${t('admin.instanceOverviewHeading')}</h2>
      <div class="admin-stats-row">
        <div class="admin-stat-card"><div class="num">${stats?.users ?? '—'}</div><div class="lbl">${t('admin.usersStatLabel')}</div></div>
        <div class="admin-stat-card"><div class="num">${stats?.servers ?? '—'}</div><div class="lbl">${t('admin.serversStatLabel')}</div></div>
        <div class="admin-stat-card"><div class="num">${stats?.messages ?? '—'}</div><div class="lbl">${t('admin.messagesStatLabel')}</div></div>
      </div>
      <div class="divider"></div>
      <h2>${t('admin.registration.heading')}</h2>
      <div class="field">
        ${['open', 'invite', 'closed'].map((m) => `
          <label class="check-row" style="display:flex;gap:8px;align-items:flex-start;margin-bottom:8px">
            <input type="radio" name="ov-reg" value="${m}" ${regMode === m ? 'checked' : ''} ${state.me.isSiteAdmin ? '' : 'disabled'} style="margin-top:3px">
            <span>${t(`admin.registration.${m}`)}<span class="hint" style="display:block">${t(`admin.registration.${m}Hint`)}</span></span>
          </label>`).join('')}
      </div>
      <div class="error-text" id="ov-reg-err"></div>
      ${state.me.isSiteAdmin ? `<button class="btn btn-primary" id="ov-reg-save">${t('common.save')}</button>` : ''}
      <div class="divider"></div>
      <h2>${t('admin.sessionSettingsHeading')}</h2>
      <div class="field">
        <label>${t('admin.loginSessionLengthLabel')}</label>
        <input class="input" id="ov-ttl" type="number" min="0" value="${ttl}" style="max-width:160px">
        <div class="hint">${t('admin.sessionLengthHint')}</div>
      </div>
      <div class="error-text" id="ov-ttl-err"></div>
      <button class="btn btn-primary" id="ov-ttl-save">${t('common.save')}</button>
      <div class="divider"></div>
      <h2>${t('admin.attachmentSettingsHeading')}</h2>
      <div class="field">
        <label>${t('admin.maxAttachmentSizeLabel')}</label>
        <input class="input" id="ov-max-mb" type="number" min="1" value="${maxUploadMb}" style="max-width:160px">
        <div class="hint">${t('admin.maxAttachmentSizeHint')}</div>
      </div>
      <div class="field">
        <label>${t('admin.allowedExtensionsLabel')}</label>
        <input class="input" id="ov-allowed-ext" placeholder="${t('admin.allowedExtensionsPlaceholder')}" value="${escapeHtml(allowedExt)}">
        <div class="hint">${t('admin.allowedExtensionsHint')}</div>
      </div>
      <div class="error-text" id="ov-attach-err"></div>
      <button class="btn btn-primary" id="ov-attach-save">${t('common.save')}</button>`;

    inner.querySelector('#ov-reg-save')?.addEventListener('click', async () => {
      const mode = inner.querySelector('input[name="ov-reg"]:checked')?.value;
      try {
        settings = { ...settings, registrationMode: (await api.adminSetRegistration(mode)).mode };
        toast(t('admin.registration.saved'));
      } catch (err) { inner.querySelector('#ov-reg-err').textContent = apiErrorMessage(err, t('admin.couldNotSave')); }
    });

    inner.querySelector('#ov-ttl-save').addEventListener('click', async () => {
      const days = Number(inner.querySelector('#ov-ttl').value);
      try {
        const res = await api.adminUpdateSettings({ sessionTtlDays: days });
        settings = res;
        toast(t('admin.sessionSettingsSaved'));
      } catch (err) { inner.querySelector('#ov-ttl-err').textContent = apiErrorMessage(err, t('admin.couldNotSave')); }
    });

    inner.querySelector('#ov-attach-save').addEventListener('click', async () => {
      const mb = Number(inner.querySelector('#ov-max-mb').value);
      const extensions = inner.querySelector('#ov-allowed-ext').value.split(',').map((s) => s.trim()).filter(Boolean);
      try {
        const res = await api.adminUpdateSettings({ maxUploadMb: mb, allowedAttachmentExtensions: extensions });
        settings = res;
        toast(t('admin.attachmentSettingsSaved'));
      } catch (err) { inner.querySelector('#ov-attach-err').textContent = apiErrorMessage(err, t('admin.couldNotSave')); }
    });
  }

  function renderUsers(inner) {
    inner.innerHTML = `
      <h2>${t('admin.usersHeading', { count: users.length })}</h2>
      <table class="data-table">
        <thead><tr><th></th><th>${t('admin.userColumn')}</th><th>${t('admin.rolesColumn')}</th><th>${t('admin.statusColumn')}</th><th></th></tr></thead>
        <tbody id="u-body"></tbody>
      </table>`;
    const body = inner.querySelector('#u-body');
    for (const u of users) {
      const roleNames = siteRoles.filter((r) => (u.siteRoleIds || []).includes(r.id));
      const tr = el(`
        <tr>
          <td>${avatarHtml(u, 28)}</td>
          <td>${escapeHtml(u.displayName)}<br><span style="color:var(--text-muted);font-size:12px">@${escapeHtml(u.username)}</span></td>
          <td>${roleNames.map((r) => `<span class="pill-static" style="margin-right:4px"><span class="dot" style="width:8px;height:8px;border-radius:50%;background:${escapeHtml(r.color)};display:inline-block"></span>${escapeHtml(r.name)}</span>`).join('') || '<span style="color:var(--text-muted)">—</span>'}</td>
          <td>${u.isDisabled ? `<span style="color:var(--danger)">${t('admin.disabledStatus')}</span>` : `<span style="color:var(--green)">${t('admin.activeStatus')}</span>`}</td>
          <td style="text-align:right"><button class="btn-icon" data-menu="${u.id}">${icons.kebab(18)}</button></td>
        </tr>`);
      tr.querySelector('[data-menu]').addEventListener('click', (e) => openUserMenu(e.currentTarget, u));
      body.appendChild(tr);
    }
  }

  function openUserMenu(anchor, u) {
    const rect = anchor.getBoundingClientRect();
    const items = [];
    for (const r of siteRoles) {
      const assigned = (u.siteRoleIds || []).includes(r.id);
      items.push({
        label: `${assigned ? '✓ ' : ''}${r.name}`,
        onClick: async () => {
          try {
            if (assigned) await api.adminUnassignSiteRole(u.id, r.id);
            else await api.adminAssignSiteRole(u.id, r.id);
            await loadAll();
          } catch (err) { toast(apiErrorMessage(err, t('admin.couldNotUpdateRole')), { type: 'error' }); }
        },
      });
    }
    if (siteRoles.length) items.push('sep');
    items.push({
      label: t('admin.editUserMenuItem'),
      onClick: () => openEditUserModal(u),
    });
    items.push({
      label: u.isDisabled ? t('admin.enableAccountMenuItem') : t('admin.disableAccountMenuItem'),
      danger: !u.isDisabled,
      onClick: () => {
        confirmModal({
          title: u.isDisabled ? t('admin.enableAccountMenuItem') : t('admin.disableAccountMenuItem'),
          message: t('admin.accountConfirmMessage', { verb: u.isDisabled ? t('admin.reEnableVerb') : t('admin.disableVerb'), username: escapeHtml(u.username) }),
          confirmLabel: u.isDisabled ? t('admin.enableButton') : t('admin.disableButton'),
          async onConfirm() {
            try { await api.adminSetDisabled(u.id, !u.isDisabled); await loadAll(); }
            catch (err) { toast(apiErrorMessage(err, t('admin.actionFailed')), { type: 'error' }); }
          },
        });
      },
    });
    openContextMenu(rect.left - 180, rect.bottom + 4, items);
  }

  function openEditUserModal(u) {
    let avatarFile = null;
    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;width:100%';
    footer.innerHTML = `<button class="btn btn-ghost" id="eu-cancel">${t('common.cancel')}</button><button class="btn btn-primary" id="eu-save">${t('admin.saveChangesButton')}</button>`;

    const m = openModal({
      title: t('admin.editUserTitle', { username: u.username }),
      footer,
      render(body) {
        body.innerHTML = `
          <div class="field" style="display:flex;align-items:center;gap:12px">
            ${avatarHtml(u, 56)}
            <div>
              <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" id="eu-avatar-file" hidden>
              <button class="btn btn-secondary" id="eu-avatar-btn" type="button">${t('admin.changeAvatarButton')}</button>
            </div>
          </div>
          <div class="field"><label>${t('admin.displayNameLabel')}</label><input class="input" id="eu-name" value="${escapeHtml(u.displayName)}"></div>
          <div class="field"><label>${t('admin.emailLabel')}</label><input class="input" id="eu-email" type="email" value="${escapeHtml(u.email || '')}"></div>
          <div class="field"><label>${t('admin.newPasswordLabel')} <span class="hint">${t('admin.leaveBlankHint')}</span></label><input class="input" id="eu-password" type="password" autocomplete="new-password"><div class="hint">${t('admin.passportResetWarning')}</div>${u.authMode === 'split' ? `<div class="hint">${t('admin.splitResetNote')}</div>` : ''}</div>
          <div class="error-text" id="eu-err"></div>`;

        body.querySelector('#eu-avatar-btn').addEventListener('click', () => body.querySelector('#eu-avatar-file').click());
        body.querySelector('#eu-avatar-file').addEventListener('change', (e) => { avatarFile = e.target.files[0] || null; });
      },
    });

    footer.querySelector('#eu-cancel').addEventListener('click', m.close);
    const saveBtn = footer.querySelector('#eu-save');
    saveBtn.addEventListener('click', async () => {
      const errEl = m.body.querySelector('#eu-err');
      const name = m.body.querySelector('#eu-name').value.trim();
      const email = m.body.querySelector('#eu-email').value.trim();
      const password = m.body.querySelector('#eu-password').value;
      const payload = {};
      if (name && name !== u.displayName) payload.displayName = name;
      if (email && email !== u.email) payload.email = email;
      if (password && password.length < MIN_PASSWORD_LENGTH) { errEl.textContent = t('auth.passwordTooShort'); return; }
      const label = saveBtn.textContent;
      saveBtn.disabled = true;
      saveBtn.textContent = t('auth.working');
      await new Promise((r) => setTimeout(r, 0));
      try {
        const authMode = password ? ((await api.adminUsers()).users.find((x) => x.id === u.id)?.authMode ?? u.authMode) : u.authMode;
        if (password && authMode === 'split') {
          const cred = await splitCredential(password);
          payload.authKey = cred.authKey;
          payload.authSalt = cred.authSalt;
        } else if (password) {
          payload.password = password;
        }
        if (avatarFile) await api.adminUploadUserAvatar(u.id, avatarFile);
        if (Object.keys(payload).length) await api.adminUpdateUser(u.id, payload);
        await loadAll();
        toast(t('admin.userUpdatedToast'));
        m.close();
      } catch (err) { errEl.textContent = apiErrorMessage(err, t('admin.couldNotSaveChanges')); } finally { saveBtn.disabled = false; saveBtn.textContent = label; }
    });
  }

  // Byte-identical to profile.js's report-reason labels — reuse those keys rather than duplicate.
  const REPORT_REASON_LABELS = { spam: t('profile.reportReasonSpam'), harassment: t('profile.reportReasonHarassment'), other: t('profile.reportReasonOther') };

  function renderReports(inner) {
    inner.innerHTML = `
      <h2>${t('admin.reportsTab')}</h2>
      <div class="tabs-row" style="margin-bottom:16px">
        <button class="tab-btn ${reportsStatus === 'open' ? 'active' : ''}" data-rstatus="open">${t('admin.openTab')}</button>
        <button class="tab-btn ${reportsStatus === 'resolved' ? 'active' : ''}" data-rstatus="resolved">${t('admin.resolvedTab')}</button>
        <button class="tab-btn ${reportsStatus === 'dismissed' ? 'active' : ''}" data-rstatus="dismissed">${t('admin.dismissedTab')}</button>
      </div>
      <div id="rp-list"></div>`;

    inner.querySelectorAll('[data-rstatus]').forEach((btn) => btn.addEventListener('click', () => {
      reportsStatus = btn.dataset.rstatus;
      loadReports();
    }));

    const list = inner.querySelector('#rp-list');
    if (reports.length === 0) {
      const statusLabel = { open: t('admin.openTab'), resolved: t('admin.resolvedTab'), dismissed: t('admin.dismissedTab') }[reportsStatus].toLowerCase();
      list.innerHTML = `<div class="empty-state" style="padding:20px 0"><p>${t('admin.noReportsOfStatus', { status: statusLabel })}</p></div>`;
      return;
    }
    for (const r of reports) {
      const row = el(`
        <div class="list-row" style="align-items:flex-start;flex-direction:column;gap:8px;padding:12px 0;border-bottom:1px solid var(--border-subtle)">
          <div style="display:flex;align-items:center;gap:8px;width:100%">
            ${avatarHtml(r.reportedUser, 28)}
            <div style="flex:1">
              <div><strong>${escapeHtml(r.reportedUser.displayName)}</strong> <span style="color:var(--text-muted);font-size:12px">@${escapeHtml(r.reportedUser.username)}</span></div>
              <div style="color:var(--text-muted);font-size:12px">
                ${t('admin.reportedByPrefix')} ${r.reporter ? `@${escapeHtml(r.reporter.username)}` : t('admin.deletedAccountFallback')} · ${REPORT_REASON_LABELS[r.reason] || r.reason} · ${new Date(r.createdAt).toLocaleString()}
              </div>
            </div>
            ${reportsStatus === 'open' ? `
              <button class="btn btn-secondary" data-dismiss="${r.id}">${t('admin.dismissButton')}</button>
              <button class="btn btn-danger" data-resolve="${r.id}">${t('admin.resolveButton')}</button>` : ''}
          </div>
          ${r.details ? `<div style="color:var(--text-secondary);font-size:13px;white-space:pre-wrap">${escapeHtml(r.details)}</div>` : ''}
          ${r.message ? `<div class="reply-preview" style="max-width:100%"><em>${r.message.encrypted ? t(r.message.hasEvidence ? 'dmEncryption.reportEncryptedEvidence' : 'dmEncryption.reportEncryptedNoEvidence') : t('admin.reportedMessageLabel')}</em> ${escapeHtml(r.message.content).slice(0, 4000)}</div>` : ''}
        </div>`);
      row.querySelector('[data-resolve]')?.addEventListener('click', () => resolveReport(r.id, 'resolved'));
      row.querySelector('[data-dismiss]')?.addEventListener('click', () => resolveReport(r.id, 'dismissed'));
      list.appendChild(row);
    }
  }

  async function resolveReport(id, status) {
    try {
      await api.adminResolveReport(id, status);
      await loadReports();
      toast(status === 'resolved' ? t('admin.reportResolvedToast') : t('admin.reportDismissedToast'));
    } catch (err) { toast(apiErrorMessage(err, t('admin.couldNotUpdateReport')), { type: 'error' }); }
  }

  function renderRoles(inner) {
    if (!selectedRoleId && siteRoles.length) selectedRoleId = siteRoles[0].id;
    const role = siteRoles.find((r) => r.id === selectedRoleId);
    inner.innerHTML = `
      <h2>${t('admin.staffRolesTab')}</h2>
      <div class="ss-split" style="display:flex;gap:24px">
        <div class="ss-split-side" style="width:220px;flex-shrink:0">
          <button class="btn btn-secondary btn-block" id="sr-new" style="margin-bottom:10px">${icons.plus(16)} ${t('admin.newRoleButton')}</button>
          <div id="sr-list"></div>
        </div>
        <div style="flex:1;min-width:0" id="sr-editor"></div>
      </div>`;

    const listEl = inner.querySelector('#sr-list');
    listEl.innerHTML = [...siteRoles].sort((a, b) => b.position - a.position).map((r) => `
      <div class="list-row" data-role="${r.id}" style="cursor:pointer;${r.id === selectedRoleId ? 'background:var(--bg-active)' : ''}">
        <span class="dot" style="width:10px;height:10px;border-radius:50%;background:${escapeHtml(r.color)};flex-shrink:0"></span>
        <div class="lr-main"><div class="lr-title">${escapeHtml(r.name)}</div></div>
      </div>`).join('');
    listEl.querySelectorAll('[data-role]').forEach((n) => n.addEventListener('click', () => { selectedRoleId = Number(n.dataset.role); render(); }));

    inner.querySelector('#sr-new').addEventListener('click', async () => {
      try {
        const res = await api.adminCreateSiteRole({ name: t('admin.newRoleDefaultName') });
        selectedRoleId = res.role.id;
        await loadAll();
      } catch (err) { toast(apiErrorMessage(err, t('admin.couldNotCreateRole')), { type: 'error' }); }
    });

    const editorEl = inner.querySelector('#sr-editor');
    if (!role) { editorEl.innerHTML = `<div class="empty-state"><p>${t('admin.noStaffRolesYet')}</p></div>`; return; }

    editorEl.innerHTML = `
      <div class="field"><label>${t('admin.roleNameLabel')}</label><input class="input" id="sr-name" value="${escapeHtml(role.name)}"></div>
      <div class="field">
        <label>${t('admin.roleColorLabel')}</label>
        <div class="color-swatch-row">
          ${ROLE_COLORS.map((c) => `<div class="color-swatch ${c.toLowerCase() === role.color.toLowerCase() ? 'selected' : ''}" data-color="${c}" style="background:${c}"></div>`).join('')}
        </div>
      </div>
      <div class="field">
        <label>${t('admin.sitePermissionsLabel')}</label>
        <div class="perm-grid">
          ${SITE_PERMISSION_INFO.map((p) => `
            <div class="perm-row">
              <div class="perm-meta"><div class="perm-name">${escapeHtml(t(`perms.site.${p.key}.name`))}</div><div class="perm-desc">${escapeHtml(t(`perms.site.${p.key}.desc`))}</div></div>
              <div class="switch ${has(role.permissions, p.flag) ? 'on' : ''}" data-flag="${p.flag}"></div>
            </div>`).join('')}
        </div>
      </div>
      <div class="error-text" id="sr-err"></div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary" id="sr-save">${t('admin.saveChangesButton')}</button>
        <button class="btn btn-danger" id="sr-delete">${t('admin.deleteRoleButton')}</button>
      </div>`;

    let pendingColor = role.color;
    let pendingBits = role.permissions;
    editorEl.querySelectorAll('[data-color]').forEach((n) => n.addEventListener('click', () => {
      pendingColor = n.dataset.color;
      editorEl.querySelectorAll('[data-color]').forEach((x) => x.classList.toggle('selected', x === n));
    }));
    editorEl.querySelectorAll('[data-flag]').forEach((n) => n.addEventListener('click', () => {
      const flag = Number(n.dataset.flag);
      const on = n.classList.toggle('on');
      pendingBits = on ? (pendingBits | flag) : (pendingBits & ~flag);
    }));

    editorEl.querySelector('#sr-save').addEventListener('click', async () => {
      const name = editorEl.querySelector('#sr-name').value.trim() || role.name;
      try {
        await api.adminUpdateSiteRole(role.id, { name, color: pendingColor, permissions: pendingBits });
        await loadAll();
        toast(t('admin.roleUpdatedToast'));
      } catch (err) { editorEl.querySelector('#sr-err').textContent = apiErrorMessage(err, t('admin.couldNotSaveRole')); }
    });
    editorEl.querySelector('#sr-delete').addEventListener('click', () => {
      confirmModal({
        title: t('admin.deleteRoleButton'),
        message: t('admin.deleteRoleConfirmMessage', { name: escapeHtml(role.name) }),
        confirmLabel: t('admin.deleteRoleButton'),
        async onConfirm() {
          try { await api.adminDeleteSiteRole(role.id); selectedRoleId = null; await loadAll(); }
          catch (err) { toast(apiErrorMessage(err, t('admin.couldNotDeleteRole')), { type: 'error' }); }
        },
      });
    });
  }

  loadAll();
  return { close };
}
