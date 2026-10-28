import { bus } from '../bus.js';
import { api } from '../api.js';
import { state, setServerDetail, getServerDetail } from '../state.js';
import { icons } from '../icons.js';
import { avatarHtml, serverIconHtml, escapeHtml, toast, apiErrorMessage, el, formatBytes, navScroll, restoreNavScroll } from '../utils.js';
import { passReauth } from '../reauth.js';
import { PERMISSION_INFO, PERMISSIONS, has, memberPermissionBits } from '../permissions.js';
import { confirmModal, confirmTypedModal, openModal, promptModal } from './modal.js';
import { nextZIndex } from '../zstack.js';
import { openEmojiPicker } from './emojiPicker.js';
import { renderStickerEditor } from './stickerEditor.js';
import { renderSoundEditor } from './soundEditor.js';
import { renderBotEditor } from './botEditor.js';
import { renderServerInvites } from './serverInvites.js';
import { renderAutomod } from './automod.js';
import { renderOnboardingSettings } from './onboarding.js';
import { renderReactionRoles } from './reactionRoles.js';
import { renderServerTemplates } from './serverTemplates.js';
import { renderInsights } from './insights.js';
import { t } from '../i18n.js';
import { EVENT_GROUPS } from '../eventText.js';
import { VOICE_QUALITY_IDS, VOICE_QUALITY_PRESETS, DEFAULT_VOICE_QUALITY } from '../voiceQuality.js';

function channelTypes() {
  return [
    { value: 'public', title: t('serverSettings.channelTypePublicTitle'), desc: t('serverSettings.channelTypePublicDesc'), icon: icons.hash },
    { value: 'private', title: t('serverSettings.channelTypePrivateTitle'), desc: t('serverSettings.channelTypePrivateDesc'), icon: icons.lock },
    { value: 'announcement', title: t('serverSettings.channelTypeAnnouncementTitle'), desc: t('serverSettings.channelTypeAnnouncementDesc'), icon: icons.megaphone },
    { value: 'readonly', title: t('serverSettings.channelTypeReadonlyTitle'), desc: t('serverSettings.channelTypeReadonlyDesc'), icon: icons.eye },
    { value: 'voice', title: t('serverSettings.channelTypeVoiceTitle'), desc: t('serverSettings.channelTypeVoiceDesc'), icon: icons.headphones },
    { value: 'forum', title: t('serverSettings.channelTypeForumTitle'), desc: t('serverSettings.channelTypeForumDesc'), icon: icons.messageSquare },
    { value: 'stage', title: t('serverSettings.channelTypeStageTitle'), desc: t('serverSettings.channelTypeStageDesc'), icon: icons.stage },
    { value: 'notes', title: t('serverSettings.channelTypeNotesTitle'), desc: t('serverSettings.channelTypeNotesDesc'), icon: icons.book },
  ];
}

const ROLE_COLORS = ['#1abc9c', '#2ecc71', '#3498db', '#9b59b6', '#e91e63', '#f1c40f', '#e67e22', '#e74c3c', '#95a5a6', '#607d8b', '#99aab5'];

export function openServerSettings(serverId, opts = {}) {
  passReauth().then((ok) => { if (ok) buildServerSettings(serverId, opts); });
}

function buildServerSettings(serverId, opts) {
  let tab = opts.tab || 'overview';
  let selectedRoleId = null;
  let selectedChannelId = opts.focusChannelId || null;
  let editingRolePanel = false;
  let pruneChannels = null; // null = not loaded yet
  let pruneSelectedChannelIds = new Set();
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

  async function refresh() {
    try {
      const res = await api.getServer(serverId);
      setServerDetail(serverId, res);
      render();
    } catch (err) {
      toast(apiErrorMessage(err, t('serverSettings.couldNotLoadServerError')), { type: 'error' });
      close();
    }
  }

  function detail() { return getServerDetail(serverId); }

  function render() {
    const d = detail();
    if (!d) return;
    const isOwner = d.server.owner_id === state.me.id;
    const myMember = d.members.find((m) => m.user.id === state.me.id);
    const myBits = memberPermissionBits(d.server, d.roles, myMember, state.me.id);
    const canViewAuditLog = has(myBits, PERMISSIONS.VIEW_AUDIT_LOG);
    const canPrune = has(myBits, PERMISSIONS.PRUNE_CONTENT);
    const canManageBots = has(myBits, PERMISSIONS.MANAGE_BOTS) || state.me.isSiteAdmin;
    const canInvites = has(myBits, PERMISSIONS.CREATE_INVITE) || has(myBits, PERMISSIONS.MANAGE_SERVER);
    const canAutomod = has(myBits, PERMISSIONS.MANAGE_SERVER);
    const canReactionRoles = has(myBits, PERMISSIONS.MANAGE_ROLES);
    const navX = navScroll(overlay);
    overlay.innerHTML = `
      <div class="settings-nav">
        <div class="snav-inner">
          <div class="snav-label">${escapeHtml(d.server.name)}</div>
          <div class="snav-item ${tab === 'overview' ? 'active' : ''}" data-tab="overview">${t('admin.overviewTab')}</div>
          <div class="snav-item ${tab === 'welcome' ? 'active' : ''}" data-tab="welcome">${t('serverSettings.navWelcomeScreen')}</div>
          <div class="snav-item ${tab === 'emoji' ? 'active' : ''}" data-tab="emoji">${t('serverSettings.navEmoji')}</div>
          <div class="snav-item ${tab === 'stickers' ? 'active' : ''}" data-tab="stickers">${t('admin.stickersTab')}</div>
          <div class="snav-item ${tab === 'soundboard' ? 'active' : ''}" data-tab="soundboard">${t('admin.soundboardTab')}</div>
          ${canInvites ? `<div class="snav-item ${tab === 'invites' ? 'active' : ''}" data-tab="invites">${t('invites.navTitle')}</div>` : ''}
          ${canAutomod ? `<div class="snav-item ${tab === 'insights' ? 'active' : ''}" data-tab="insights">${t('insights.navTitle')}</div>` : ''}
          ${canAutomod ? `<div class="snav-item ${tab === 'templates' ? 'active' : ''}" data-tab="templates">${t('templates.navTitle')}</div>` : ''}
          ${canReactionRoles ? `<div class="snav-item ${tab === 'reactionroles' ? 'active' : ''}" data-tab="reactionroles">${t('reactionRoles.navTitle')}</div>` : ''}
          ${canAutomod ? `<div class="snav-item ${tab === 'onboarding' ? 'active' : ''}" data-tab="onboarding">${t('onboarding.navTitle')}</div>` : ''}
          ${canAutomod ? `<div class="snav-item ${tab === 'automod' ? 'active' : ''}" data-tab="automod">${t('automod.navTitle')}</div>` : ''}
          ${canManageBots ? `<div class="snav-item ${tab === 'bots' ? 'active' : ''}" data-tab="bots">${t('serverSettings.navBots')}</div>` : ''}
          <div class="snav-item ${tab === 'roles' ? 'active' : ''}" data-tab="roles">${t('admin.rolesColumn')}</div>
          <div class="snav-item ${tab === 'channels' ? 'active' : ''}" data-tab="channels">${t('admin.channelsLabel')}</div>
          <div class="snav-item ${tab === 'members' ? 'active' : ''}" data-tab="members">${t('memberList.heading')}</div>
          ${canViewAuditLog ? `<div class="snav-item ${tab === 'auditlog' ? 'active' : ''}" data-tab="auditlog">${t('serverSettings.auditLogLabel')}</div>` : ''}
          ${canPrune ? `<div class="snav-item ${tab === 'prune' ? 'active' : ''}" data-tab="prune">${t('admin.pruneDataTitle')}</div>` : ''}
          <div class="snav-label"></div>
          <div class="snav-item danger" data-leave>${isOwner ? t('serverSettings.deleteServerLabel') : t('serverSettings.leaveServerLabel')}</div>
        </div>
      </div>
      <div class="settings-content"><div class="sc-inner" id="sc-inner"></div></div>
      <button class="settings-close" id="sc-close">${icons.x(18)}</button>`;

    restoreNavScroll(overlay, navX);
    overlay.querySelectorAll('[data-tab]').forEach((n) => n.addEventListener('click', () => { tab = n.dataset.tab; render(); }));
    overlay.querySelector('#sc-close').addEventListener('click', close);
    overlay.querySelector('[data-leave]').addEventListener('click', () => {
      confirmModal({
        title: isOwner ? t('serverSettings.deleteServerLabel') : t('serverSettings.leaveServerLabel'),
        message: isOwner
          ? t('serverSettings.deleteServerConfirmMessage', { name: escapeHtml(d.server.name) })
          : t('serverSettings.leaveServerConfirmMessage', { name: escapeHtml(d.server.name) }),
        confirmLabel: isOwner ? t('serverSettings.deleteServerLabel') : t('serverSettings.leaveServerLabel'),
        async onConfirm() {
          try {
            if (isOwner) await api.deleteServer(serverId); else await api.leaveServer(serverId);
            bus.emit('ui:serverRemoved', serverId);
            close();
          } catch (err) { toast(apiErrorMessage(err, t('admin.actionFailed')), { type: 'error' }); }
        },
      });
    });

    const inner = overlay.querySelector('#sc-inner');
    if (tab === 'overview') renderOverview(inner, d, isOwner);
    else if (tab === 'welcome') renderWelcome(inner, d);
    else if (tab === 'emoji') renderEmoji(inner, d);
    else if (tab === 'stickers') renderStickers(inner, d);
    else if (tab === 'soundboard') renderSoundboard(inner, d);
    else if (tab === 'bots') renderBots(inner, d);
    else if (tab === 'invites') renderServerInvites(inner, { serverId });
    else if (tab === 'insights') renderInsights(inner, { serverId });
    else if (tab === 'templates') renderServerTemplates(inner, { serverId });
    else if (tab === 'reactionroles') renderReactionRoles(inner, { serverId, roles: d.roles, channels: d.channels });
    else if (tab === 'onboarding') renderOnboardingSettings(inner, { serverId, roles: d.roles });
    else if (tab === 'automod') renderAutomod(inner, { serverId, roles: d.roles, channels: d.channels.filter((c) => c.type !== 'notes') });
    else if (tab === 'roles') renderRoles(inner, d, isOwner);
    else if (tab === 'channels') renderChannels(inner, d, isOwner);
    else if (tab === 'members') renderMembers(inner, d, isOwner, myBits);
    else if (tab === 'auditlog') renderAuditLog(inner, d);
    else if (tab === 'prune') renderPrune(inner, d);
  }

  // ---------------- data pruning (PRUNE_CONTENT — this server's own channels only) ----------------
  function renderPrune(inner, d) {
    inner.innerHTML = `
      <h2>${t('admin.pruneDataTitle')}</h2>
      <p class="hint" style="margin:-8px 0 16px">${t('serverSettings.pruneHint')}</p>
      <div id="prune-body"></div>`;
    const body = inner.querySelector('#prune-body');

    if (pruneChannels === null) {
      body.innerHTML = `<div class="panel-loading" style="height:80px"><div class="spinner"></div></div>`;
      api.pruneChannelsList(serverId).then((res) => {
        pruneChannels = res.channels;
        if (tab === 'prune') renderPrune(inner, d);
      }).catch((err) => {
        body.innerHTML = `<div class="empty-state"><p>${escapeHtml(apiErrorMessage(err, t('admin.couldNotLoadChannels')))}</p></div>`;
      });
      return;
    }

    body.innerHTML = `
      <div class="field">
        <label>${t('admin.channelsLabel')}</label>
        ${pruneChannels.map((ch) => `
          <label class="checkbox-row">
            <input type="checkbox" data-prune-ch="${ch.id}" ${pruneSelectedChannelIds.has(ch.id) ? 'checked' : ''}>
            #${escapeHtml(ch.name)}
          </label>`).join('')}
      </div>
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
          <p>${t('admin.pruneSummary', { count: prunePreview.messageCount, attachmentClause: prunePurgeAttachments ? t('admin.pruneAttachmentClause', { count: prunePreview.attachmentCount, size: formatBytes(prunePreview.attachmentBytes) }) : '' })}</p>
        </div>` : ''}
      <div class="error-text" id="prune-err"></div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-secondary" id="prune-preview-btn">${t('admin.previewButton')}</button>
        <button class="btn btn-danger" id="prune-execute-btn" ${prunePreview ? '' : 'disabled'}>${t('admin.pruneNowButton')}</button>
      </div>`;

    body.querySelectorAll('[data-prune-ch]').forEach((cb) => {
      cb.addEventListener('change', () => {
        const id = Number(cb.dataset.pruneCh);
        if (cb.checked) pruneSelectedChannelIds.add(id); else pruneSelectedChannelIds.delete(id);
        prunePreview = null;
        renderPrune(inner, d);
      });
    });
    body.querySelectorAll('[data-notify]').forEach((btn) => {
      btn.addEventListener('click', () => { pruneNotify = btn.dataset.notify; renderPrune(inner, d); });
    });
    body.querySelector('#prune-attachments').addEventListener('change', (e) => {
      prunePurgeAttachments = e.target.checked;
      prunePreview = null;
      renderPrune(inner, d);
    });
    body.querySelector('#prune-cutoff').addEventListener('change', (e) => { pruneCutoff = e.target.value; prunePreview = null; });

    body.querySelector('#prune-preview-btn').addEventListener('click', async () => {
      const errEl = body.querySelector('#prune-err');
      errEl.textContent = '';
      if (pruneSelectedChannelIds.size === 0) { errEl.textContent = t('admin.selectAtLeastOneChannel'); return; }
      if (!pruneCutoff) { errEl.textContent = t('admin.pickCutoffDateError'); return; }
      try {
        prunePreview = await api.prunePreview(serverId, {
          channelIds: [...pruneSelectedChannelIds], cutoff: pruneCutoff, purgeAttachments: prunePurgeAttachments,
        });
        renderPrune(inner, d);
      } catch (err) { errEl.textContent = apiErrorMessage(err, t('admin.couldNotPreview')); }
    });

    body.querySelector('#prune-execute-btn').addEventListener('click', () => {
      const ids = [...pruneSelectedChannelIds];
      const selectedNames = pruneChannels.filter((c) => ids.includes(c.id)).map((c) => c.name);
      const expectedText = ids.length === 1 ? selectedNames[0] : d.server.name;
      const target = ids.length === 1 ? `#${escapeHtml(selectedNames[0])}` : t('serverSettings.pruneTargetChannelsCount', { count: ids.length });
      confirmTypedModal({
        title: t('serverSettings.pruneChannelDataTitle'),
        message: t('serverSettings.pruneChannelDataConfirmMessage', {
          messageCount: prunePreview.messageCount,
          attachmentClause: prunePurgeAttachments ? t('admin.pruneChannelsAttachmentClause', { count: prunePreview.attachmentCount }) : '',
          target,
          server: escapeHtml(d.server.name),
          graceNote: pruneNotify === 'grace' ? t('admin.graceNote') : '',
        }),
        expectedText,
        confirmLabel: t('admin.pruneForeverButton'),
        onConfirm: async () => {
          try {
            const res = await api.pruneExecute(serverId, {
              channelIds: ids, cutoff: pruneCutoff, purgeAttachments: prunePurgeAttachments, notify: pruneNotify,
            });
            prunePreview = null;
            pruneSelectedChannelIds = new Set();
            toast(res.status === 'scheduled' ? t('admin.pruneScheduledToast') : t('admin.prunedMessagesToast', { count: res.messageCount }));
            renderPrune(inner, d);
          } catch (err) { toast(apiErrorMessage(err, t('admin.couldNotPrune')), { type: 'error' }); }
        },
      });
    });
  }

  // ---------------- audit log ----------------
  function auditActionLabels() {
    return {
      server_update: t('serverSettings.auditActionServerUpdate'), server_icon_update: t('serverSettings.auditActionServerIconUpdate'),
      category_create: t('serverSettings.auditActionCategoryCreate'), category_update: t('serverSettings.auditActionCategoryUpdate'), category_delete: t('serverSettings.auditActionCategoryDelete'),
      channel_create: t('serverSettings.auditActionChannelCreate'), channel_update: t('serverSettings.auditActionChannelUpdate'), channel_delete: t('serverSettings.auditActionChannelDelete'),
      channel_overrides_update: t('serverSettings.auditActionChannelOverridesUpdate'),
      role_create: t('serverSettings.auditActionRoleCreate'), role_update: t('serverSettings.auditActionRoleUpdate'), role_delete: t('serverSettings.auditActionRoleDelete'),
      member_role_add: t('serverSettings.auditActionMemberRoleAdd'), member_role_remove: t('serverSettings.auditActionMemberRoleRemove'),
      member_nickname_update: t('serverSettings.auditActionMemberNicknameUpdate'), member_kick: t('serverSettings.auditActionMemberKick'), member_ban: t('serverSettings.auditActionMemberBan'),
      member_unban: t('serverSettings.auditActionMemberUnban'), invite_regenerate: t('serverSettings.auditActionInviteRegenerate'),
      welcome_channel_add: t('serverSettings.auditActionWelcomeChannelAdd'), welcome_channel_remove: t('serverSettings.auditActionWelcomeChannelRemove'),
      event_add: t('serverSettings.auditActionEventAdd'), event_update: t('serverSettings.auditActionEventUpdate'), event_remove: t('serverSettings.auditActionEventRemove'),
      notes_trim: t('serverSettings.auditActionNotesTrim'), thread_delete: t('serverSettings.auditActionThreadDelete'),
      data_prune: t('serverSettings.auditActionDataPrune'), data_prune_scheduled: t('serverSettings.auditActionDataPruneScheduled'),
      invite_create: t('serverSettings.auditActionInviteCreate'), invite_revoke: t('serverSettings.auditActionInviteRevoke'), vanity_set: t('serverSettings.auditActionVanitySet'),
      onboarding_update: t('serverSettings.auditActionOnboardingUpdate'),
      template_create: t('serverSettings.auditActionTemplateCreate'), template_sync: t('serverSettings.auditActionTemplateSync'), template_delete: t('serverSettings.auditActionTemplateDelete'),
      reaction_role_create: t('serverSettings.auditActionReactionRoleCreate'), reaction_role_delete: t('serverSettings.auditActionReactionRoleDelete'),
      automod_rule_create: t('serverSettings.auditActionAutomodCreate'), automod_rule_update: t('serverSettings.auditActionAutomodUpdate'), automod_rule_delete: t('serverSettings.auditActionAutomodDelete'),
      bot_create: t('serverSettings.auditActionBotCreate'), bot_update: t('serverSettings.auditActionBotUpdate'), bot_delete: t('serverSettings.auditActionBotDelete'),
      bot_token_issue: t('serverSettings.auditActionBotTokenIssue'), bot_token_revoke: t('serverSettings.auditActionBotTokenRevoke'), bot_webhook_secret_rotate: t('serverSettings.auditActionBotSecretRotate'),
    };
  }

  function auditEntryText(e) {
    const label = auditActionLabels()[e.action] || e.action;
    let extra = '';
    if (e.action === 'channel_create' || e.action === 'channel_update' || e.action === 'channel_delete') {
      extra = e.details?.name ? ` #${e.details.name}` : '';
    } else if (e.action === 'role_create' || e.action === 'role_update' || e.action === 'role_delete') {
      extra = e.details?.name ? ` "${e.details.name}"` : '';
    } else if (e.action === 'category_create' || e.action === 'category_update' || e.action === 'category_delete') {
      extra = e.details?.name ? ` "${e.details.name}"` : '';
    } else if (e.action === 'member_role_add' || e.action === 'member_role_remove') {
      extra = e.details?.roleName ? t('serverSettings.auditExtraRole', { roleName: e.details.roleName }) : '';
    }
    return `${label}${extra}`;
  }

  let auditEntries = null;
  function renderAuditLog(inner, d) {
    inner.innerHTML = `<h2>${t('serverSettings.auditLogLabel')}</h2><div id="al-list"></div>`;
    const listEl = inner.querySelector('#al-list');
    if (auditEntries === null) {
      listEl.innerHTML = `<div class="panel-loading" style="height:80px"><div class="spinner"></div></div>`;
      api.getAuditLog(serverId).then((res) => {
        auditEntries = res.entries;
        if (tab === 'auditlog') renderAuditLog(inner, d);
      }).catch((err) => {
        listEl.innerHTML = `<div class="empty-state"><p>${escapeHtml(apiErrorMessage(err, t('serverSettings.couldNotLoadAuditLogError')))}</p></div>`;
      });
      return;
    }
    if (auditEntries.length === 0) {
      listEl.innerHTML = `<div class="empty-state"><p>${t('serverSettings.noModerationActivityYet')}</p></div>`;
      return;
    }
    listEl.innerHTML = auditEntries.map((e) => `
      <div class="list-row">
        ${e.actor ? avatarHtml(e.actor, 32) : `<div style="width:32px;height:32px;border-radius:50%;background:var(--bg-active);flex-shrink:0"></div>`}
        <div class="lr-main">
          <div class="lr-title">${e.actor ? escapeHtml(e.actor.displayName) : t('serverSettings.formerMemberFallback')} ${escapeHtml(auditEntryText(e))}</div>
          <div class="lr-sub">${new Date(e.createdAt).toLocaleString()}</div>
        </div>
      </div>`).join('');
  }

  // ---------------- overview ----------------
  let pendingVisibility = null;
  function renderOverview(inner, d, isOwner) {
    if (pendingVisibility === null) pendingVisibility = d.server.visibility;
    const previewServer = { ...d.server, visibility: pendingVisibility };
    inner.innerHTML = `
      <h2>${t('serverSettings.serverOverviewTitle')}</h2>
      <div class="settings-avatar-row">
        <div class="avatar-edit" id="icon-edit" style="border-radius:50%;overflow:hidden;background:var(--bg-active);display:flex;align-items:center;justify-content:center;width:80px;height:80px">
          ${serverIconHtml(d.server, 80)}
          <div class="overlay-hint">${t('serverSettings.changeIconHint')}</div>
        </div>
        <input type="file" id="icon-input" class="hidden" accept="image/png,image/jpeg,image/gif,image/webp">
        <div style="font-weight:700;font-size:18px">${escapeHtml(d.server.name)}</div>
      </div>
      <div class="field">
        <label>${t('serverSettings.serverNameLabel')}</label>
        <input class="input" id="f-name" value="${escapeHtml(d.server.name)}">
      </div>
      <div class="field">
        <label>${t('serverSettings.descriptionLabel')}</label>
        <textarea class="input textarea" id="f-desc" rows="2" placeholder="${t('serverSettings.serverDescPlaceholder')}">${escapeHtml(d.server.description || '')}</textarea>
      </div>
      <div class="field">
        <label>${t('serverSettings.visibilityLabel')}</label>
        <div class="tabs-row">
          <button type="button" class="tab-btn ${previewServer.visibility !== 'public' ? 'active' : ''}" id="vis-private">${t('serverSettings.privateVisibilityOption')}</button>
          <button type="button" class="tab-btn ${previewServer.visibility === 'public' ? 'active' : ''}" id="vis-public">${t('serverSettings.publicVisibilityOption')}</button>
        </div>
      </div>
      ${previewServer.visibility === 'public' ? `
        <label class="checkbox-row">
          <input type="checkbox" id="f-autojoin" ${d.server.auto_join ? 'checked' : ''}>
          ${t('serverSettings.autoJoinCheckbox')}
        </label>` : ''}
      <div class="divider"></div>
      <div class="field">
        <label>${t('verification.label')}</label>
        <select class="input" id="f-verification" style="max-width:420px">
          ${[0, 1, 2, 3].map((n) => `<option value="${n}" ${(d.server.verification_level || 0) === n ? 'selected' : ''}>${t('verification.level' + n)}</option>`).join('')}
        </select>
        <div class="hint">${t('verification.hint')}</div>
      </div>
      <label class="checkbox-row">
        <input type="checkbox" id="f-raw-html" ${d.server.raw_html_enabled ? 'checked' : ''}>
        ${t('serverSettings.rawHtmlCheckbox')}
      </label>
      <p class="hint" style="color:var(--text-secondary);font-size:13px;margin:0 0 12px">${t('serverSettings.rawHtmlHint')}</p>
      <div class="error-text" id="ov-err"></div>
      <button class="btn btn-primary" id="ov-save">${t('admin.saveChangesButton')}</button>
      <div class="divider"></div>
      <div class="field">
        <label>${t('serverSettings.inviteCodeLabel')}</label>
        <div class="invite-box">
          <div class="invite-code">${escapeHtml(d.server.invite_code || '')}</div>
          <button class="btn btn-secondary" id="ov-copy">${t('sidebar.copyButton')}</button>
          <button class="btn btn-secondary" id="ov-regen">${icons.refresh(16)}</button>
        </div>
      </div>`;

    inner.querySelector('#icon-edit').addEventListener('click', () => inner.querySelector('#icon-input').click());
    inner.querySelector('#icon-input').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        await api.uploadServerIcon(serverId, file);
        await refresh();
      } catch (err) { toast(apiErrorMessage(err, t('serverSettings.couldNotUploadIconError')), { type: 'error' }); }
    });

    inner.querySelector('#vis-private').addEventListener('click', () => { pendingVisibility = 'private'; renderOverview(inner, d, isOwner); });
    inner.querySelector('#vis-public').addEventListener('click', () => { pendingVisibility = 'public'; renderOverview(inner, d, isOwner); });

    inner.querySelector('#ov-save').addEventListener('click', async () => {
      const name = inner.querySelector('#f-name').value.trim();
      if (!name) return;
      const description = inner.querySelector('#f-desc').value.trim();
      const autoJoin = pendingVisibility === 'public' && !!inner.querySelector('#f-autojoin')?.checked;
      const rawHtmlEnabled = inner.querySelector('#f-raw-html').checked;
      try {
        const verificationLevel = Number(inner.querySelector('#f-verification').value);
        await api.updateServer(serverId, { name, description, visibility: pendingVisibility, autoJoin, rawHtmlEnabled, verificationLevel });
        pendingVisibility = null;
        await refresh();
        toast(t('serverSettings.serverUpdatedToast'));
      } catch (err) { inner.querySelector('#ov-err').textContent = apiErrorMessage(err, t('serverSettings.couldNotUpdateServerError')); }
    });

    inner.querySelector('#ov-copy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(d.server.invite_code || ''); toast(t('serverSettings.inviteCodeCopiedToast')); }
      catch { toast(t('serverSettings.couldNotCopyManual')); }
    });
    inner.querySelector('#ov-regen').addEventListener('click', async () => {
      try { await api.regenerateInvite(serverId); await refresh(); toast(t('serverSettings.inviteCodeRegeneratedToast')); }
      catch (err) { toast(apiErrorMessage(err, t('serverSettings.missingPermissionError')), { type: 'error' }); }
    });
  }

  // ---------------- welcome screen ----------------
  let pendingAddChannelId = null;
  let pendingAddEmoji = '';
  function renderWelcome(inner, d) {
    const welcomeChannels = d.welcomeChannels || [];
    const availableChannels = d.channels.filter((ch) => !welcomeChannels.some((wc) => wc.channel_id === ch.id));
    if (pendingAddChannelId === null && availableChannels.length) pendingAddChannelId = availableChannels[0].id;

    inner.innerHTML = `
      <h2>${t('serverSettings.navWelcomeScreen')}</h2>
      <p class="hint" style="margin:-8px 0 16px">${t('serverSettings.welcomeHint')}</p>
      <label class="checkbox-row">
        <input type="checkbox" id="f-wl-enabled" ${d.server.welcome_enabled ? 'checked' : ''}>
        ${t('serverSettings.enableWelcomeScreenCheckbox')}
      </label>
      <div class="field">
        <label>${t('serverSettings.welcomeMessageLabel')}</label>
        <textarea class="input textarea" id="f-wl-message" rows="3" maxlength="300" placeholder="${t('serverSettings.welcomeMessagePlaceholder')}">${escapeHtml(d.server.welcome_message || '')}</textarea>
      </div>
      <div class="error-text" id="wl-err"></div>
      <button class="btn btn-primary" id="wl-save">${t('admin.saveChangesButton')}</button>
      <div class="divider"></div>
      <div class="field">
        <label>${t('serverSettings.highlightedChannelsLabel')}</label>
        <div id="wl-channel-list"></div>
      </div>
      ${availableChannels.length ? `
        <div class="field">
          <label>${t('serverSettings.addAChannelLabel')}</label>
          <div style="display:flex;gap:8px;align-items:flex-start">
            <button type="button" class="btn btn-secondary" id="wl-add-emoji" style="width:44px;flex-shrink:0;font-size:18px">${escapeHtml(pendingAddEmoji) || icons.smile(18)}</button>
            <select class="input" id="wl-add-channel" style="flex-shrink:0;width:160px">
              ${availableChannels.map((ch) => `<option value="${ch.id}" ${ch.id === pendingAddChannelId ? 'selected' : ''}>#${escapeHtml(ch.name)}</option>`).join('')}
            </select>
            <input class="input" id="wl-add-desc" placeholder="${t('serverSettings.shortDescriptionPlaceholder')}" maxlength="150" style="flex:1">
            <button type="button" class="btn btn-secondary" id="wl-add-btn">${t('serverSettings.addButton')}</button>
          </div>
        </div>` : ''}`;

    const listEl = inner.querySelector('#wl-channel-list');
    listEl.innerHTML = welcomeChannels.length
      ? welcomeChannels.map((wc) => {
          const ch = d.channels.find((c) => c.id === wc.channel_id);
          return `
            <div class="list-row" data-wl="${wc.id}">
              <button type="button" class="btn btn-secondary" data-wl-emoji="${wc.id}" style="width:36px;flex-shrink:0;font-size:16px">${escapeHtml(wc.emoji) || icons.smile(16)}</button>
              <div class="lr-main">
                <div class="lr-title">#${escapeHtml(ch ? ch.name : t('serverSettings.unknownChannelFallback'))}</div>
                <input class="input" data-wl-desc="${wc.id}" value="${escapeHtml(wc.description || '')}" maxlength="150" placeholder="${t('serverSettings.shortDescriptionPlaceholder')}" style="margin-top:4px">
              </div>
              <div class="lr-actions">
                <button class="btn-icon" data-wl-delete="${wc.id}" title="${t('stickerEditor.removeTitle')}">${icons.trash(16)}</button>
              </div>
            </div>`;
        }).join('')
      : `<div class="empty-state" style="height:auto;padding:16px 0"><p>${t('serverSettings.noChannelsHighlightedYet')}</p></div>`;

    inner.querySelector('#wl-save').addEventListener('click', async () => {
      const welcomeEnabled = inner.querySelector('#f-wl-enabled').checked;
      const welcomeMessage = inner.querySelector('#f-wl-message').value.trim();
      try {
        await api.updateServer(serverId, { welcomeEnabled, welcomeMessage });
        await refresh();
        toast(t('serverSettings.welcomeScreenUpdatedToast'));
      } catch (err) { inner.querySelector('#wl-err').textContent = apiErrorMessage(err, t('serverSettings.couldNotUpdateWelcomeScreenError')); }
    });

    listEl.querySelectorAll('[data-wl-emoji]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const wcId = Number(btn.dataset.wlEmoji);
        openEmojiPicker(btn, async (emoji) => {
          try { await api.updateWelcomeChannel(serverId, wcId, { emoji }); await refresh(); }
          catch (err) { toast(apiErrorMessage(err, t('serverSettings.couldNotUpdate')), { type: 'error' }); }
        });
      });
    });
    listEl.querySelectorAll('[data-wl-desc]').forEach((input) => {
      input.addEventListener('blur', async () => {
        const wcId = Number(input.dataset.wlDesc);
        const current = welcomeChannels.find((wc) => wc.id === wcId);
        if (!current || input.value.trim() === (current.description || '')) return;
        try { await api.updateWelcomeChannel(serverId, wcId, { description: input.value.trim() }); await refresh(); }
        catch (err) { toast(apiErrorMessage(err, t('serverSettings.couldNotUpdate')), { type: 'error' }); }
      });
    });
    listEl.querySelectorAll('[data-wl-delete]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try { await api.removeWelcomeChannel(serverId, Number(btn.dataset.wlDelete)); await refresh(); }
        catch (err) { toast(apiErrorMessage(err, t('stickerEditor.removeError')), { type: 'error' }); }
      });
    });

    const addEmojiBtn = inner.querySelector('#wl-add-emoji');
    addEmojiBtn?.addEventListener('click', () => {
      openEmojiPicker(addEmojiBtn, (emoji) => { pendingAddEmoji = emoji; renderWelcome(inner, d); });
    });
    inner.querySelector('#wl-add-channel')?.addEventListener('change', (e) => { pendingAddChannelId = Number(e.target.value); });
    inner.querySelector('#wl-add-btn')?.addEventListener('click', async () => {
      const channelId = pendingAddChannelId;
      const description = inner.querySelector('#wl-add-desc').value.trim();
      if (!channelId) return;
      try {
        await api.addWelcomeChannel(serverId, { channelId, emoji: pendingAddEmoji, description });
        pendingAddChannelId = null;
        pendingAddEmoji = '';
        await refresh();
      } catch (err) { toast(apiErrorMessage(err, t('serverSettings.couldNotAddChannelError')), { type: 'error' }); }
    });
  }

  // ---------------- custom emoji ----------------
  // Management gated on MANAGE_SERVER only — same permission as the rest of this settings dialog,
  // deliberately no separate emoji-specific permission or moderation queue.
  function renderEmoji(inner, d) {
    const emojiList = d.customEmoji || [];
    inner.innerHTML = `
      <h2>${t('serverSettings.customEmojiTitle')}</h2>
      <p class="hint" style="margin:-8px 0 16px">${t('serverSettings.emojiHint')}</p>
      <div class="field">
        <label>${t('serverSettings.uploadNewLabel')}</label>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <input class="input" id="em-name" placeholder="${t('serverSettings.emojiNamePlaceholder')}" maxlength="32" style="width:200px">
          <button type="button" class="btn btn-secondary" id="em-file-btn">${t('serverSettings.chooseImageButton')}</button>
          <input type="file" id="em-file-input" class="hidden" accept="image/png,image/jpeg,image/gif,image/webp">
          <span id="em-file-name" class="hint"></span>
        </div>
        <div class="error-text" id="em-err"></div>
        <button class="btn btn-primary" id="em-upload-btn" style="margin-top:10px">${t('admin.uploadButton')}</button>
      </div>
      <div class="divider"></div>
      <div class="field">
        <label>${t('serverSettings.emojiCountLabel', { count: emojiList.length })}</label>
        <div id="em-grid" style="display:flex;flex-wrap:wrap;gap:10px"></div>
      </div>`;

    const gridEl = inner.querySelector('#em-grid');
    gridEl.innerHTML = emojiList.length
      ? emojiList.map((e) => `
          <div style="width:88px;display:flex;flex-direction:column;align-items:center;gap:4px;padding:10px;text-align:center;border-radius:var(--radius-sm)" class="list-row">
            <img src="${escapeHtml(e.image_path)}" alt=":${escapeHtml(e.name)}:" style="width:40px;height:40px;object-fit:contain">
            <div style="font-size:12px;color:var(--text-muted);word-break:break-all">:${escapeHtml(e.name)}:</div>
            <button class="btn-icon" data-emoji-delete="${e.id}" title="${t('stickerEditor.removeTitle')}">${icons.trash(14)}</button>
          </div>`).join('')
      : `<div class="empty-state" style="height:auto;padding:16px 0"><p>${t('serverSettings.noCustomEmojiYet')}</p></div>`;

    gridEl.querySelectorAll('[data-emoji-delete]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try { await api.deleteCustomEmoji(serverId, Number(btn.dataset.emojiDelete)); await refresh(); }
        catch (err) { toast(apiErrorMessage(err, t('stickerEditor.removeError')), { type: 'error' }); }
      });
    });

    let chosenFile = null;
    const fileInput = inner.querySelector('#em-file-input');
    inner.querySelector('#em-file-btn').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      chosenFile = fileInput.files[0] || null;
      inner.querySelector('#em-file-name').textContent = chosenFile ? chosenFile.name : '';
    });

    inner.querySelector('#em-upload-btn').addEventListener('click', async () => {
      const name = inner.querySelector('#em-name').value.trim();
      const errEl = inner.querySelector('#em-err');
      if (!/^[a-zA-Z0-9_]{2,32}$/.test(name)) { errEl.textContent = t('serverSettings.emojiNameValidationError'); return; }
      if (!chosenFile) { errEl.textContent = t('serverSettings.chooseImageFirstError'); return; }
      try {
        await api.uploadCustomEmoji(serverId, name, chosenFile);
        await refresh();
        toast(t('serverSettings.emojiUploadedToast'));
      } catch (err) { errEl.textContent = apiErrorMessage(err, t('serverSettings.couldNotUploadEmojiError')); }
    });
  }

  // ---------------- AI bots (MANAGE_BOTS) ----------------
  function renderBots(inner, d) {
    inner.innerHTML = `<h2>${t('serverSettings.navBots')}</h2><div id="bots-body"><div class="panel-loading" style="height:80px"><div class="spinner"></div></div></div>`;
    const body = inner.querySelector('#bots-body');
    Promise.all([api.listServerBots(serverId), api.listServerAiProviders(serverId)]).then(([b, p]) => {
      renderBotEditor(body, {
        bots: b.bots,
        providers: p.providers,
        servers: null,
        create: (payload) => api.createServerBot(serverId, payload),
        update: (bot, payload) => api.updateServerBot(serverId, bot.id, payload),
        remove: (bot) => api.deleteServerBot(serverId, bot.id),
        uploadAvatar: (bot, file) => api.uploadServerBotAvatar(serverId, bot.id, file),
        credentials: {
          issueToken: (bot) => api.issueServerBotToken(serverId, bot.id),
          revokeToken: (bot) => api.revokeServerBotToken(serverId, bot.id),
          rotateSecret: (bot) => api.rotateServerBotSecret(serverId, bot.id),
          testWebhook: (bot) => api.testServerBotWebhook(serverId, bot.id),
        },
        onChange: () => { if (tab === 'bots') renderBots(inner, d); },
      });
    }).catch((err) => {
      body.innerHTML = `<div class="empty-state"><p>${escapeHtml(apiErrorMessage(err, t('bots.loadError')))}</p></div>`;
    });
  }

  // ---------------- stickers ----------------
  // Same MANAGE_SERVER gate, no separate moderation system — identical reasoning to the Emoji tab.
  function renderStickers(inner, d) {
    inner.innerHTML = `<h2>${t('admin.stickersTab')}</h2><div id="sticker-editor-root"></div>`;
    renderStickerEditor(inner.querySelector('#sticker-editor-root'), {
      stickers: d.stickers || [],
      upload: (name, description, file) => api.uploadSticker(serverId, name, description, file),
      remove: (stickerId) => api.deleteSticker(serverId, stickerId),
      onChange: refresh,
    });
  }

  // ---------------- soundboard ----------------
  // Same MANAGE_SERVER gate, no separate moderation system — identical reasoning to Emoji/Stickers.
  function renderSoundboard(inner, d) {
    inner.innerHTML = `<h2>${t('admin.soundboardTab')}</h2><div id="sound-editor-root"></div>`;
    renderSoundEditor(inner.querySelector('#sound-editor-root'), {
      sounds: d.sounds || [],
      upload: (name, emoji, file) => api.uploadSound(serverId, name, emoji, file),
      remove: (soundId) => api.deleteSound(serverId, soundId),
      onChange: refresh,
    });
  }

  // ---------------- roles ----------------
  function renderRoles(inner, d, isOwner) {
    if (!selectedRoleId && d.roles.length) selectedRoleId = d.roles[0].id;
    const role = d.roles.find((r) => r.id === selectedRoleId);
    inner.innerHTML = `
      <h2>${t('admin.rolesColumn')}</h2>
      <div class="ss-split" style="display:flex;gap:24px">
        <div class="ss-split-side" style="width:220px;flex-shrink:0">
          <button class="btn btn-secondary btn-block" id="role-new" style="margin-bottom:10px">${icons.plus(16)} ${t('admin.newRoleButton')}</button>
          <div id="role-list"></div>
        </div>
        <div style="flex:1;min-width:0" id="role-editor"></div>
      </div>`;

    const listEl = inner.querySelector('#role-list');
    listEl.innerHTML = [...d.roles].sort((a, b) => b.position - a.position).map((r) => {
      const count = d.members.filter((m) => (m.roleIds || []).includes(r.id) || (r.is_default)).length;
      return `<div class="list-row" data-role="${r.id}" style="cursor:pointer;${r.id === selectedRoleId ? 'background:var(--bg-active)' : ''}">
        <span class="dot" style="width:10px;height:10px;border-radius:50%;background:${escapeHtml(r.color)};flex-shrink:0"></span>
        <div class="lr-main"><div class="lr-title">${escapeHtml(r.name)}</div><div class="lr-sub">${count} ${count === 1 ? t('serverRail.memberSingular') : t('serverRail.memberPlural')}</div></div>
      </div>`;
    }).join('');
    listEl.querySelectorAll('[data-role]').forEach((n) => n.addEventListener('click', () => { selectedRoleId = Number(n.dataset.role); render(); }));
    inner.querySelector('#role-new').addEventListener('click', async () => {
      try {
        const res = await api.createRole(serverId, { name: 'new role' });
        selectedRoleId = res.role.id;
        await refresh();
      } catch (err) { toast(apiErrorMessage(err, t('admin.couldNotCreateRole')), { type: 'error' }); }
    });

    const editorEl = inner.querySelector('#role-editor');
    if (!role) { editorEl.innerHTML = `<div class="empty-state"><p>${t('serverSettings.noRolesYet')}</p></div>`; return; }
    renderRoleEditor(editorEl, d, role);
  }

  function renderRoleEditor(editorEl, d, role) {
    editorEl.innerHTML = `
      <div class="field">
        <label>${t('admin.roleNameLabel')}</label>
        <input class="input" id="r-name" value="${escapeHtml(role.name)}" ${role.is_default ? 'disabled' : ''}>
      </div>
      ${role.is_default ? '' : `<div class="field">
        <label>${t('roleIcons.label')} <span class="hint">${t('roleIcons.hint')}</span></label>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <button type="button" id="r-icon-preview" title="${t('roleIcons.pickEmoji')}" style="width:32px;height:32px;display:inline-flex;align-items:center;justify-content:center;font-size:22px;border-radius:8px;background:var(--bg-active);overflow:hidden;border:0;padding:0;cursor:pointer;color:inherit">${role.icon_path ? `<img src="${escapeHtml(role.icon_path)}" style="width:100%;height:100%;object-fit:cover">` : escapeHtml(role.icon_emoji || '') || '<span style="opacity:.35">🎮</span>'}</button>
          <input type="hidden" id="r-icon-emoji" value="${escapeHtml(role.icon_emoji || '')}">
          <button class="btn btn-secondary" id="r-icon-btn" type="button">${t('roleIcons.upload')}</button>
          <input type="file" id="r-icon-input" class="hidden" accept="image/png,image/jpeg,image/gif,image/webp">
          ${role.icon_path || role.icon_emoji ? `<button class="btn btn-secondary" id="r-icon-remove" type="button">${t('roleIcons.remove')}</button>` : ''}
        </div>
      </div>`}
      <div class="field">
        <label>${t('admin.roleColorLabel')}</label>
        <div class="color-swatch-row">
          ${ROLE_COLORS.map((c) => `<div class="color-swatch ${c.toLowerCase() === role.color.toLowerCase() ? 'selected' : ''}" data-color="${c}" style="background:${c}"></div>`).join('')}
          <label class="color-swatch color-swatch-custom ${ROLE_COLORS.some((c) => c.toLowerCase() === role.color.toLowerCase()) ? '' : 'selected'}" title="${t('admin.roleCustomColor')}" style="background:${ROLE_COLORS.some((c) => c.toLowerCase() === role.color.toLowerCase()) ? '' : escapeHtml(role.color)}">
            <input type="color" id="r-color-custom" value="${/^#[0-9a-f]{6}$/i.test(role.color) ? role.color : '#99aab5'}">
          </label>
        </div>
      </div>
      <div class="field">
        <label>${t('serverSettings.permissionsLabel')}</label>
        <div class="perm-grid" id="perm-grid">
          ${PERMISSION_INFO.map((p) => `
            <div class="perm-row">
              <div class="perm-meta">
                <div class="perm-name">${escapeHtml(t(`perms.server.${p.key}.name`))}</div>
                <div class="perm-desc">${escapeHtml(t(`perms.server.${p.key}.desc`))}</div>
              </div>
              <div class="switch ${has(role.permissions, p.flag) ? 'on' : ''}" data-flag="${p.flag}"></div>
            </div>`).join('')}
        </div>
      </div>
      <div class="error-text" id="r-err"></div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary" id="r-save">${t('admin.saveChangesButton')}</button>
        ${!role.is_default ? `<button class="btn btn-danger" id="r-delete">${t('admin.deleteRoleButton')}</button>` : ''}
      </div>`;

    let pendingColor = role.color;
    let pendingBits = role.permissions;

    editorEl.querySelectorAll('[data-color]').forEach((n) => n.addEventListener('click', () => {
      pendingColor = n.dataset.color;
      editorEl.querySelectorAll('[data-color]').forEach((x) => x.classList.toggle('selected', x === n));
      customSwatch.classList.remove('selected');
    }));
    const customSwatch = editorEl.querySelector('.color-swatch-custom');
    editorEl.querySelector('#r-color-custom').addEventListener('input', (e) => {
      pendingColor = e.target.value;
      editorEl.querySelectorAll('[data-color]').forEach((x) => x.classList.remove('selected'));
      customSwatch.classList.add('selected');
      customSwatch.style.background = pendingColor;
    });
    editorEl.querySelectorAll('[data-flag]').forEach((n) => n.addEventListener('click', () => {
      const flag = Number(n.dataset.flag);
      const on = n.classList.toggle('on');
      pendingBits = on ? (pendingBits | flag) : (pendingBits & ~flag);
    }));

    editorEl.querySelector('#r-icon-preview')?.addEventListener('click', (e) => {
      openEmojiPicker(e.currentTarget, (emoji) => {
        editorEl.querySelector('#r-icon-emoji').value = emoji;
        e.currentTarget.textContent = emoji;
      });
    });
    editorEl.querySelector('#r-icon-btn')?.addEventListener('click', () => editorEl.querySelector('#r-icon-input').click());
    editorEl.querySelector('#r-icon-input')?.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try { await api.uploadRoleIcon(serverId, role.id, file); await refresh(); }
      catch (err) { editorEl.querySelector('#r-err').textContent = apiErrorMessage(err, t('roleIcons.error')); }
    });
    editorEl.querySelector('#r-icon-remove')?.addEventListener('click', async () => {
      try { await api.deleteRoleIcon(serverId, role.id); await refresh(); }
      catch (err) { editorEl.querySelector('#r-err').textContent = apiErrorMessage(err, t('roleIcons.error')); }
    });

    editorEl.querySelector('#r-save').addEventListener('click', async () => {
      const payload = { color: pendingColor, permissions: pendingBits };
      if (!role.is_default) payload.name = editorEl.querySelector('#r-name').value.trim() || role.name;
      const emojiInput = editorEl.querySelector('#r-icon-emoji');
      if (emojiInput && emojiInput.value.trim() !== (role.icon_emoji || '')) payload.iconEmoji = emojiInput.value.trim();
      try {
        await api.updateRole(serverId, role.id, payload);
        await refresh();
        toast(t('admin.roleUpdatedToast'));
      } catch (err) { editorEl.querySelector('#r-err').textContent = apiErrorMessage(err, t('admin.couldNotSaveRole')); }
    });

    editorEl.querySelector('#r-delete')?.addEventListener('click', () => {
      confirmModal({
        title: t('admin.deleteRoleButton'),
        message: t('serverSettings.deleteRoleConfirmMessage', { name: escapeHtml(role.name) }),
        confirmLabel: t('admin.deleteRoleButton'),
        async onConfirm() {
          try {
            await api.deleteRole(serverId, role.id);
            selectedRoleId = null;
            await refresh();
          } catch (err) { toast(apiErrorMessage(err, t('admin.couldNotDeleteRole')), { type: 'error' }); }
        },
      });
    });
  }

  // ---------------- channels ----------------
  function renderChannels(inner, d, isOwner) {
    inner.innerHTML = `
      <h2>${t('admin.channelsLabel')}</h2>
      <div style="display:flex;gap:8px;margin-bottom:16px">
        <button class="btn btn-secondary" id="ch-new">${icons.plus(16)} ${t('serverSettings.createChannelButton')}</button>
        <button class="btn btn-secondary" id="ch-new-category">${icons.plus(16)} ${t('sidebar.createCategoryMenuItem')}</button>
      </div>
      <div id="ch-list"></div>`;

    const listEl = inner.querySelector('#ch-list');
    listEl.innerHTML = d.channels.map((ch) => `
      <div class="list-row">
        ${ch.icon_path
          ? `<img src="${escapeHtml(ch.icon_path)}" style="width:18px;height:18px;border-radius:5px;object-fit:cover;flex-shrink:0">`
          : `<span class="ch-icon" style="color:var(--text-muted)">${(iconFor(ch.type))(18)}</span>`}
        <div class="lr-main"><div class="lr-title">${escapeHtml(ch.name)}</div><div class="lr-sub">${ch.type}${ch.category_id ? ' · ' + escapeHtml(d.categories.find((c) => c.id === ch.category_id)?.name || '') : ''}${ch.topic ? ' · ' + escapeHtml(ch.topic) : ''}</div></div>
        <div class="lr-actions">
          <button class="btn btn-sm btn-secondary" data-edit="${ch.id}">${t('events.editTitle')}</button>
          <button class="btn btn-sm btn-secondary" data-perms="${ch.id}">${t('serverSettings.permissionsLabel')}</button>
          ${ch.type === 'private' ? `<button class="btn btn-sm btn-secondary" data-invite="${ch.id}">${t('shell.inviteButton')}</button>` : ''}
          <button class="btn btn-sm btn-danger" data-del="${ch.id}">${t('admin.deleteButton')}</button>
        </div>
      </div>`).join('') || `<div class="empty-state"><p>${t('serverSettings.noChannelsYet')}</p></div>`;

    listEl.querySelectorAll('[data-edit]').forEach((n) => n.addEventListener('click', () => openChannelEditor(d, d.channels.find((c) => c.id === Number(n.dataset.edit)))));
    listEl.querySelectorAll('[data-perms]').forEach((n) => n.addEventListener('click', () => openChannelOverrides(d, d.channels.find((c) => c.id === Number(n.dataset.perms)))));
    listEl.querySelectorAll('[data-invite]').forEach((n) => n.addEventListener('click', () => openChannelInviteManager(d.channels.find((c) => c.id === Number(n.dataset.invite)))));
    listEl.querySelectorAll('[data-del]').forEach((n) => n.addEventListener('click', () => {
      const ch = d.channels.find((c) => c.id === Number(n.dataset.del));
      confirmModal({
        title: t('serverSettings.deleteChannelLabel'),
        message: t('serverSettings.deleteChannelConfirmMessage', { channel: escapeHtml(ch.name) }),
        confirmLabel: t('serverSettings.deleteChannelLabel'),
        async onConfirm() {
          try { await api.deleteChannel(serverId, ch.id); await refresh(); }
          catch (err) { toast(apiErrorMessage(err, t('serverSettings.couldNotDeleteChannelError')), { type: 'error' }); }
        },
      });
    }));
    inner.querySelector('#ch-new').addEventListener('click', () => openChannelEditor(d, null));
    inner.querySelector('#ch-new-category').addEventListener('click', async () => {
      const name = await promptModal({ title: t('sidebar.createCategoryMenuItem'), label: t('sidebar.categoryNameLabel'), value: t('sidebar.newCategoryDefaultName'), confirmLabel: t('sidebar.createButton') });
      if (!name) return;
      try { await api.createCategory(serverId, { name }); await refresh(); }
      catch (err) { toast(apiErrorMessage(err, t('sidebar.couldNotCreateCategory')), { type: 'error' }); }
    });

    if (opts.createNew) { opts.createNew = false; openChannelEditor(d, null); }
    if (selectedChannelId) {
      const ch = d.channels.find((c) => c.id === selectedChannelId);
      selectedChannelId = null;
      if (ch) openChannelEditor(d, ch);
    }
  }

  function iconFor(type) {
    return { public: icons.hash, private: icons.lock, announcement: icons.megaphone, readonly: icons.eye, voice: icons.headphones, forum: icons.messageSquare, stage: icons.stage, notes: icons.book }[type] || icons.hash;
  }

  function openChannelEditor(d, channel) {
    let type = channel?.type || 'public';
    let disabledEvents;
    try { disabledEvents = new Set(JSON.parse(channel?.event_filter || '[]')); } catch { disabledEvents = new Set(); }
    const m = openModal({
      title: channel ? t('serverSettings.editChannelTitle', { channel: channel.name }) : t('serverSettings.createChannelButton'),
      render(body) {
        body.innerHTML = `
          ${channel ? `
          <div class="field">
            <label>${t('serverSettings.channelIconLabel')} <span class="hint">${t('auth.optional')}</span></label>
            <div style="display:flex;align-items:center;gap:12px">
              <div id="c-icon-preview" style="width:48px;height:48px;border-radius:12px;overflow:hidden;background:var(--bg-active);display:flex;align-items:center;justify-content:center;flex-shrink:0">
                ${channel.icon_path ? `<img src="${escapeHtml(channel.icon_path)}" style="width:100%;height:100%;object-fit:cover">` : iconFor(type)(22)}
              </div>
              <button class="btn btn-secondary" id="c-icon-btn" type="button">${t('serverSettings.uploadIconButton')}</button>
              <input type="file" id="c-icon-input" class="hidden" accept="image/png,image/jpeg,image/gif,image/webp">
            </div>
          </div>` : ''}
          <div class="field">
            <label>${t('serverSettings.channelTypeLabel')}</label>
            <div class="channel-type-picker" id="ctp"></div>
          </div>
          <div class="field">
            <label>${t('serverSettings.channelNameLabel')}</label>
            <input class="input" id="c-name" value="${escapeHtml(channel?.name || '')}" placeholder="${t('serverSettings.channelNamePlaceholder')}">
          </div>
          <div class="field">
            <label>${t('serverSettings.topicLabel')} <span class="hint">${t('auth.optional')}</span></label>
            <input class="input" id="c-topic" value="${escapeHtml(channel?.topic || '')}" maxlength="200">
          </div>
          <div class="field" id="c-events-field" ${type === 'announcement' ? '' : 'style="display:none"'}>
            <label>${t('serverLog.filterLabel')}</label>
            <div class="hint">${t('serverLog.filterHint')}</div>
            ${EVENT_GROUPS.map((g) => `
            <div style="margin-top:8px">
              <div class="hint" style="font-weight:600">${t(g.label)}</div>
              ${g.types.map((ty) => `<label class="checkbox-row"><input type="checkbox" data-event-type="${ty}" ${disabledEvents.has(ty) ? '' : 'checked'}> <span>${escapeHtml(t('serverLog.' + ty + 'Title'))}</span></label>`).join('')}
            </div>`).join('')}
          </div>
          <div class="field" id="c-nsfw-field" ${type === 'voice' || type === 'stage' || type === 'notes' ? 'style="display:none"' : ''}>
            <label class="checkbox-row"><input type="checkbox" id="c-nsfw" ${channel?.nsfw ? 'checked' : ''}> <span>${t('ageGate.channelLabel')}</span></label>
            <div class="hint">${t('ageGate.channelHint')}</div>
          </div>
          <div class="field" id="c-vq-field" ${type === 'voice' || type === 'stage' ? '' : 'style="display:none"'}>
            <label>${t('serverSettings.voiceQualityLabel')} <span class="hint">${t('serverSettings.voiceQualityHint')}</span></label>
            <select class="input" id="c-voice-quality" ${channel ? 'disabled' : ''}>
              ${VOICE_QUALITY_IDS.map((id) => { const p = VOICE_QUALITY_PRESETS[id]; return `<option value="${id}" ${(channel?.voice_quality || DEFAULT_VOICE_QUALITY) === id ? 'selected' : ''}>${t('serverSettings.voiceQuality_' + id)} (${p.khz} kHz, ${p.bitrate / 1000} kbps${p.stereo ? ', stereo' : ''})</option>`; }).join('')}
            </select>
          </div>
          ${channel && channel.type !== 'voice' && channel.type !== 'stage' && channel.type !== 'notes' ? `
          <div class="field">
            <label>${t('serverSettings.slowmodeLabel')} <span class="hint">${t('serverSettings.slowmodeHint')}</span></label>
            <input class="input" id="c-slowmode" type="number" min="0" max="21600" value="${channel.slowmode_seconds || 0}">
          </div>` : ''}
          ${d.categories.length ? `
          <div class="field">
            <label>${t('serverSettings.categoryLabel')}</label>
            <select class="input" id="c-category">
              <option value="">${t('serverSettings.noCategoryOption')}</option>
              ${d.categories.map((c) => `<option value="${c.id}" ${channel?.category_id === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
            </select>
          </div>` : ''}
          ${channel && channel.type !== 'voice' && channel.type !== 'stage' && channel.type !== 'notes' ? `
          <div class="divider"></div>
          <div class="field">
            <label>${t('serverSettings.webhooksLabel')} <span class="hint">${t('serverSettings.webhooksHint')}</span></label>
            <div id="wh-list"></div>
            <button class="btn btn-secondary" id="wh-new" type="button" style="margin-top:8px">${icons.plus(14)} ${t('serverSettings.createWebhookButton')}</button>
          </div>` : ''}
          <div class="error-text" id="c-err"></div>`;

        if (channel) {
          body.querySelector('#c-icon-btn').addEventListener('click', () => body.querySelector('#c-icon-input').click());
          body.querySelector('#c-icon-input').addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            try {
              const res = await api.uploadChannelIcon(serverId, channel.id, file);
              body.querySelector('#c-icon-preview').innerHTML = `<img src="${escapeHtml(res.iconPath)}" style="width:100%;height:100%;object-fit:cover">`;
              await refresh();
            } catch (err) { toast(apiErrorMessage(err, t('serverSettings.couldNotUploadIconError')), { type: 'error' }); }
          });
        }

        if (channel && channel.type !== 'voice' && channel.type !== 'stage' && channel.type !== 'notes') wireWebhookSection(body, channel);

        const ctp = body.querySelector('#ctp');
        function drawTypes() {
          ctp.innerHTML = channelTypes().map((ct) => `
            <div class="ctp-option ${type === ct.value ? 'selected' : ''}" data-type="${ct.value}">
              <span class="ctp-icon">${ct.icon(20)}</span>
              <div class="ctp-text"><div class="ctp-title">${ct.title}</div><div class="ctp-desc">${ct.desc}</div></div>
            </div>`).join('');
          ctp.querySelectorAll('[data-type]').forEach((n) => n.addEventListener('click', () => { type = n.dataset.type; body.querySelector('#c-vq-field').style.display = type === 'voice' || type === 'stage' ? '' : 'none'; body.querySelector('#c-nsfw-field').style.display = type === 'voice' || type === 'stage' || type === 'notes' ? 'none' : ''; body.querySelector('#c-events-field').style.display = type === 'announcement' ? '' : 'none'; drawTypes(); }));
        }
        drawTypes();
      },
    });
    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;width:100%';
    footer.innerHTML = `<button class="btn btn-ghost" data-cancel>${t('common.cancel')}</button><button class="btn btn-primary" data-save>${channel ? t('common.save') : t('serverSettings.createChannelButton')}</button>`;
    const footerHost = m.overlay.querySelector('.modal-footer');
    footerHost.classList.remove('hidden');
    footerHost.appendChild(footer);
    footer.querySelector('[data-cancel]').addEventListener('click', m.close);
    footer.querySelector('[data-save]').addEventListener('click', async () => {
      const name = m.body.querySelector('#c-name').value.trim();
      const topic = m.body.querySelector('#c-topic').value.trim();
      const categorySel = m.body.querySelector('#c-category');
      const categoryId = categorySel && categorySel.value ? Number(categorySel.value) : null;
      if (!name) { m.body.querySelector('#c-err').textContent = t('serverSettings.channelNameRequiredError'); return; }
      const voiceQuality = !channel && (type === 'voice' || type === 'stage') ? m.body.querySelector('#c-voice-quality').value : undefined;
      const nsfw = m.body.querySelector('#c-nsfw').checked && type !== 'voice' && type !== 'stage' && type !== 'notes';
      const eventFilter = [...m.body.querySelectorAll('[data-event-type]')].filter((cb) => !cb.checked).map((cb) => cb.dataset.eventType);
      try {
        if (channel) {
          await api.updateChannel(serverId, channel.id, { name, topic, type, categoryId, nsfw, eventFilter });
          const slowmodeInput = m.body.querySelector('#c-slowmode');
          if (slowmodeInput && Number(slowmodeInput.value) !== (channel.slowmode_seconds || 0)) {
            await api.setChannelSlowmode(serverId, channel.id, Number(slowmodeInput.value) || 0);
          }
        } else {
          await api.createChannel(serverId, { name, topic, type, categoryId, voiceQuality, nsfw, eventFilter });
        }
        await refresh();
        m.close();
      } catch (err) { m.body.querySelector('#c-err').textContent = apiErrorMessage(err, t('serverSettings.couldNotSaveChannelError')); }
    });
  }

  // Webhooks section inside the channel editor modal — fetched/rendered independently of the
  // rest of the modal (no full re-render needed) since it's the modal's only part with its own
  // async list, same "self-contained async chunk" shape the icon-upload handler above already uses.
  function wireWebhookSection(body, channel) {
    const listEl = body.querySelector('#wh-list');

    async function load() {
      listEl.innerHTML = `<div class="panel-loading" style="height:60px"><div class="spinner"></div></div>`;
      try {
        const res = await api.listWebhooks(serverId, channel.id);
        renderList(res.webhooks);
      } catch (err) {
        listEl.innerHTML = `<div class="empty-state" style="height:auto;padding:8px 0"><p>${escapeHtml(apiErrorMessage(err, t('serverSettings.couldNotLoadWebhooksError')))}</p></div>`;
      }
    }

    function renderList(webhooks) {
      listEl.innerHTML = webhooks.length ? webhooks.map((w) => `
        <div class="list-row" style="flex-wrap:wrap">
          <div style="width:32px;height:32px;border-radius:50%;overflow:hidden;background:var(--bg-active);display:flex;align-items:center;justify-content:center;flex-shrink:0">
            ${w.avatar_path ? `<img src="${escapeHtml(w.avatar_path)}" style="width:100%;height:100%;object-fit:cover">` : icons.zap(16)}
          </div>
          <div class="lr-main">
            <div class="lr-title">${escapeHtml(w.name)}</div>
            <div class="lr-sub" style="word-break:break-all">${escapeHtml(`${location.origin}/api/webhooks/${w.id}/${w.token}`)}</div>
          </div>
          <div class="lr-actions">
            <button class="btn btn-sm btn-secondary" data-wh-copy="${w.id}">${t('serverSettings.copyUrlButton')}</button>
            <button class="btn btn-sm btn-secondary" data-wh-icon="${w.id}">${t('serverSettings.iconButton')}</button>
            <button class="btn btn-sm btn-secondary" data-wh-regen="${w.id}">${t('serverSettings.regenerateButton')}</button>
            <button class="btn-icon" data-wh-delete="${w.id}" title="${t('admin.deleteButton')}">${icons.trash(14)}</button>
          </div>
        </div>`).join('') : `<div class="empty-state" style="height:auto;padding:8px 0"><p>${t('serverSettings.noWebhooksYet')}</p></div>`;

      listEl.querySelectorAll('[data-wh-copy]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const w = webhooks.find((x) => x.id === Number(btn.dataset.whCopy));
          try { await navigator.clipboard.writeText(`${location.origin}/api/webhooks/${w.id}/${w.token}`); toast(t('serverSettings.webhookUrlCopiedToast')); }
          catch { toast(t('serverSettings.couldNotCopyManual')); }
        });
      });
      listEl.querySelectorAll('[data-wh-icon]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = 'image/png,image/jpeg,image/gif,image/webp';
          input.addEventListener('change', async () => {
            const file = input.files[0];
            if (!file) return;
            try { await api.uploadWebhookIcon(serverId, channel.id, Number(btn.dataset.whIcon), file); await load(); }
            catch (err) { toast(apiErrorMessage(err, t('serverSettings.couldNotUploadIconError')), { type: 'error' }); }
          });
          input.click();
        });
      });
      listEl.querySelectorAll('[data-wh-regen]').forEach((btn) => {
        btn.addEventListener('click', () => {
          confirmModal({
            title: t('serverSettings.regenerateWebhookTokenTitle'),
            message: t('serverSettings.regenerateWebhookTokenMessage'),
            confirmLabel: t('serverSettings.regenerateButton'),
            async onConfirm() {
              try { await api.regenerateWebhookToken(serverId, channel.id, Number(btn.dataset.whRegen)); await load(); toast(t('serverSettings.tokenRegeneratedToast')); }
              catch (err) { toast(apiErrorMessage(err, t('serverSettings.couldNotRegenerateError')), { type: 'error' }); }
            },
          });
        });
      });
      listEl.querySelectorAll('[data-wh-delete]').forEach((btn) => {
        btn.addEventListener('click', () => {
          confirmModal({
            title: t('serverSettings.deleteWebhookTitle'),
            message: t('serverSettings.deleteWebhookMessage'),
            confirmLabel: t('admin.deleteButton'),
            async onConfirm() {
              try { await api.deleteWebhook(serverId, channel.id, Number(btn.dataset.whDelete)); await load(); }
              catch (err) { toast(apiErrorMessage(err, t('serverSettings.couldNotDeleteError')), { type: 'error' }); }
            },
          });
        });
      });
    }

    body.querySelector('#wh-new').addEventListener('click', async () => {
      const name = await promptModal({ title: t('serverSettings.createWebhookButton'), label: t('serverSettings.createWebhookNameLabel'), placeholder: t('serverSettings.createWebhookPlaceholder'), confirmLabel: t('serverRail.createButton') });
      if (!name || !name.trim()) return;
      try { await api.createWebhook(serverId, channel.id, name.trim()); await load(); }
      catch (err) { toast(apiErrorMessage(err, t('serverSettings.couldNotCreateWebhookError')), { type: 'error' }); }
    });

    load();
  }

  function openChannelOverrides(d, channel) {
    let roleId = d.roles[0]?.id;
    const overridesByRole = new Map((channel.overrides || []).map((o) => [o.role_id, o]));

    function syncFormToRole(body) {
      const current = overridesByRole.get(roleId) || { allow: 0, deny: 0 };
      body.querySelectorAll('[data-ov-flag]').forEach((sel) => {
        const flag = Number(sel.dataset.ovFlag);
        sel.value = (current.allow & flag) ? 'allow' : (current.deny & flag) ? 'deny' : 'neutral';
      });
    }

    const m = openModal({
      title: t('serverSettings.roleOverridesTitle', { channel: channel.name }),
      wide: true,
      render(body) {
        body.innerHTML = `
          <p style="color:var(--text-muted);font-size:13px;margin:0 0 12px">
            ${t('serverSettings.overridesHint')}
          </p>
          <div class="field">
            <label>${t('serverSettings.roleLabel')}</label>
            <select class="select" id="ov-role">
              ${d.roles.map((r) => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('')}
            </select>
          </div>
          <div class="perm-grid" id="ov-grid">
            ${PERMISSION_INFO.map((p) => `
              <div class="perm-row">
                <div class="perm-meta"><div class="perm-name">${escapeHtml(t(`perms.server.${p.key}.name`))}</div></div>
                <select class="select" style="width:110px" data-ov-flag="${p.flag}">
                  <option value="neutral">${t('serverSettings.neutralOption')}</option>
                  <option value="allow">${t('serverSettings.allowOption')}</option>
                  <option value="deny">${t('serverSettings.denyOption')}</option>
                </select>
              </div>`).join('')}
          </div>
          <div class="error-text" id="ov-err"></div>`;
        syncFormToRole(body);
        body.querySelector('#ov-role').addEventListener('change', (e) => {
          roleId = Number(e.target.value);
          syncFormToRole(body);
        });
      },
    });
    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;width:100%';
    footer.innerHTML = `<button class="btn btn-ghost" data-cancel>${t('common.cancel')}</button><button class="btn btn-primary" data-save>${t('serverSettings.saveOverridesButton')}</button>`;
    const footerHost = m.overlay.querySelector('.modal-footer');
    footerHost.classList.remove('hidden');
    footerHost.appendChild(footer);
    footer.querySelector('[data-cancel]').addEventListener('click', m.close);
    footer.querySelector('[data-save]').addEventListener('click', async () => {
      let allow = 0; let deny = 0;
      m.body.querySelectorAll('[data-ov-flag]').forEach((sel) => {
        const flag = Number(sel.dataset.ovFlag);
        if (sel.value === 'allow') allow |= flag;
        else if (sel.value === 'deny') deny |= flag;
      });
      try {
        await api.setChannelOverride(serverId, channel.id, roleId, { allow, deny });
        overridesByRole.set(roleId, { role_id: roleId, allow, deny });
        toast(t('serverSettings.channelOverridesSavedToast'));
        m.close();
      } catch (err) { m.body.querySelector('#ov-err').textContent = apiErrorMessage(err, t('serverSettings.couldNotSaveOverridesError')); }
    });
  }

  function openChannelInviteManager(channel) {
    let invites = null;
    const m = openModal({
      title: t('serverSettings.channelInvitesTitle', { channel: channel.name }),
      render(body) {
        draw();
        async function draw() {
          if (invites === null) {
            body.innerHTML = `<div class="panel-loading" style="height:80px"><div class="spinner"></div></div>`;
            try { invites = (await api.listChannelInvites(serverId, channel.id)).invites; }
            catch { invites = []; }
          }
          body.innerHTML = `
            <p style="color:var(--text-muted);font-size:13px;margin:0 0 12px">
              ${t('serverSettings.invitesHint')}
            </p>
            <div class="field">
              <label>${t('serverSettings.maxUsesLabel')} <span class="hint">${t('auth.optional')}</span></label>
              <input class="input" id="inv-max-uses" type="number" min="1" placeholder="${t('serverSettings.unlimitedPlaceholder')}">
            </div>
            <div class="field">
              <label>${t('serverSettings.expiresInLabel')} <span class="hint">${t('auth.optional')}</span></label>
              <input class="input" id="inv-expires" type="number" min="1" placeholder="${t('serverSettings.neverPlaceholder')}">
            </div>
            <button class="btn btn-primary" id="inv-create" style="margin-bottom:16px">${t('serverSettings.createInviteButton')}</button>
            <div id="inv-list">${renderList()}</div>`;
          body.querySelector('#inv-create').addEventListener('click', async () => {
            const maxUses = body.querySelector('#inv-max-uses').value.trim();
            const expiresInHours = body.querySelector('#inv-expires').value.trim();
            try {
              const res = await api.createChannelInvite(serverId, channel.id, {
                maxUses: maxUses ? Number(maxUses) : null,
                expiresInHours: expiresInHours ? Number(expiresInHours) : null,
              });
              invites.unshift(res.invite);
              draw();
            } catch (err) { toast(apiErrorMessage(err, t('serverSettings.couldNotCreateInviteError')), { type: 'error' }); }
          });
          body.querySelectorAll('[data-inv-copy]').forEach((n) => n.addEventListener('click', async () => {
            try { await navigator.clipboard.writeText(n.dataset.invCopy); toast(t('serverSettings.inviteCodeCopiedToast')); }
            catch { toast(t('serverSettings.couldNotCopyAutoManual')); }
          }));
          body.querySelectorAll('[data-inv-revoke]').forEach((n) => n.addEventListener('click', async () => {
            try {
              await api.revokeChannelInvite(serverId, channel.id, Number(n.dataset.invRevoke));
              invites = invites.filter((i) => i.id !== Number(n.dataset.invRevoke));
              draw();
            } catch (err) { toast(apiErrorMessage(err, t('serverSettings.couldNotRevokeInviteError')), { type: 'error' }); }
          }));
        }

        function renderList() {
          if (invites.length === 0) return `<div class="empty-state" style="padding:16px"><p>${t('serverSettings.noActiveInvitesYet')}</p></div>`;
          return invites.map((i) => `
            <div class="list-row">
              <div class="lr-main">
                <div class="lr-title" style="font-family:var(--font-mono, monospace)">${escapeHtml(i.code)}</div>
                <div class="lr-sub">${t('serverSettings.inviteUsesLine', { uses: i.uses, maxUsesClause: i.maxUses ? `/${i.maxUses}` : '', expiresClause: i.expiresAt ? t('serverSettings.inviteExpiresClause', { date: new Date(i.expiresAt).toLocaleString() }) : '' })}</div>
              </div>
              <button class="btn btn-sm btn-secondary" data-inv-copy="${escapeHtml(i.code)}">${t('sidebar.copyButton')}</button>
              <button class="btn btn-sm btn-danger" data-inv-revoke="${i.id}">${t('serverSettings.revokeButton')}</button>
            </div>`).join('');
        }
      },
    });
  }

  // ---------------- members ----------------
  function renderMembers(inner, d, isOwner, myBits) {
    inner.innerHTML = `<h2>${t('serverSettings.membersCountTitle', { count: d.members.length })}</h2><div id="mem-list"></div>`;
    const listEl = inner.querySelector('#mem-list');
    listEl.innerHTML = '';
    for (const m of d.members) {
      const memberRoles = d.roles.filter((r) => !r.is_default && (m.roleIds || []).includes(r.id));
      const isTimedOut = m.timeoutUntil && new Date(m.timeoutUntil) > new Date();
      const row = el(`
        <div class="list-row" data-uid="${m.user.id}">
          ${avatarHtml(m.user, 36)}
          <div class="lr-main">
            <div class="lr-title">${escapeHtml(m.nickname || m.user.displayName)} ${d.server.owner_id === m.user.id ? '👑' : ''}</div>
            <div class="lr-sub">${memberRoles.map((r) => `<span class="tag-role" style="margin-right:4px"><span class="dot" style="background:${escapeHtml(r.color)}"></span>${escapeHtml(r.name)}</span>`).join('') || '@everyone'}${isTimedOut ? `<span class="tag-role" style="margin-left:4px;color:var(--danger)">${t('serverSettings.timedOutUntil', { date: new Date(m.timeoutUntil).toLocaleString() })}</span>` : ''}</div>
          </div>
          <div class="lr-actions"><button class="btn-icon" data-menu>${icons.kebab(18)}</button></div>
        </div>`);
      row.querySelector('[data-menu]').addEventListener('click', (e) => openMemberMenu(e.currentTarget, d, m, isOwner, myBits));
      listEl.appendChild(row);
    }
  }

  function timeoutPresets() {
    return [
      { label: t('serverSettings.timeoutPreset60s'), minutes: 1 },
      { label: t('serverSettings.timeoutPreset5m'), minutes: 5 },
      { label: t('serverSettings.timeoutPreset10m'), minutes: 10 },
      { label: t('serverSettings.timeoutPreset1h'), minutes: 60 },
      { label: t('serverSettings.timeoutPreset1d'), minutes: 60 * 24 },
      { label: t('serverSettings.timeoutPreset1w'), minutes: 60 * 24 * 7 },
    ];
  }

  function openMemberMenu(anchor, d, member, isOwner, myBits) {
    import('./modal.js').then(({ openContextMenu }) => {
      const rect = anchor.getBoundingClientRect();
      const isTargetOwner = d.server.owner_id === member.user.id;
      const canModerate = has(myBits, PERMISSIONS.MODERATE_MEMBERS);
      const isTimedOut = member.timeoutUntil && new Date(member.timeoutUntil) > new Date();
      const items = [{ label: t('serverSettings.changeNicknameMenuItem'), icon: icons.edit, onClick: () => openNicknamePrompt(member) }, 'sep'];
      const assignableRoles = d.roles.filter((r) => !r.is_default);
      for (const r of assignableRoles) {
        const assigned = (member.roleIds || []).includes(r.id);
        items.push({
          label: `${assigned ? '✓ ' : ''}${r.name}`,
          onClick: async () => {
            try {
              if (assigned) await api.unassignRole(serverId, member.user.id, r.id);
              else await api.assignRole(serverId, member.user.id, r.id);
              await refresh();
            } catch (err) { toast(apiErrorMessage(err, t('admin.couldNotUpdateRole')), { type: 'error' }); }
          },
        });
      }
      if (assignableRoles.length) items.push('sep');
      if (!isTargetOwner && canModerate) {
        items.push('sep');
        for (const preset of timeoutPresets()) {
          items.push({
            label: t('serverSettings.timeOutMenuItem', { preset: preset.label }),
            onClick: async () => {
              try { await api.timeoutMember(serverId, member.user.id, preset.minutes); await refresh(); }
              catch (err) { toast(apiErrorMessage(err, t('serverSettings.couldNotTimeOutError')), { type: 'error' }); }
            },
          });
        }
        if (isTimedOut) {
          items.push({
            label: t('serverSettings.removeTimeoutMenuItem'), icon: icons.x,
            onClick: async () => {
              try { await api.clearMemberTimeout(serverId, member.user.id); await refresh(); }
              catch (err) { toast(apiErrorMessage(err, t('serverSettings.couldNotRemoveTimeoutError')), { type: 'error' }); }
            },
          });
        }
      }
      if (!isTargetOwner) {
        items.push('sep');
        items.push({ label: t('serverSettings.kickMemberTitle'), icon: icons.kick, danger: true, onClick: () => kickMember(member) });
        items.push({ label: t('profile.banMemberTitle'), icon: icons.ban, danger: true, onClick: () => banMember(member) });
      }
      openContextMenu(rect.left - 200, rect.bottom + 4, items.length ? items : [{ label: t('serverSettings.noActionsAvailable'), onClick: () => {} }]);
    });
  }

  function openNicknamePrompt(member) {
    const m = openModal({
      title: t('serverSettings.nicknameForTitle', { name: member.user.displayName }),
      render(body) {
        body.innerHTML = `
          <div class="field">
            <label>${t('serverSettings.nicknameFieldLabel')}</label>
            <input class="input" id="nick-input" maxlength="32" value="${escapeHtml(member.nickname || '')}">
          </div>
          <div class="error-text" id="nick-err"></div>`;
        body.querySelector('#nick-input').focus();
      },
    });
    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;width:100%';
    footer.innerHTML = `<button class="btn btn-ghost" data-cancel>${t('common.cancel')}</button><button class="btn btn-primary" data-save>${t('common.save')}</button>`;
    const footerHost = m.overlay.querySelector('.modal-footer');
    footerHost.classList.remove('hidden');
    footerHost.appendChild(footer);
    footer.querySelector('[data-cancel]').addEventListener('click', m.close);
    const save = async () => {
      const nickname = m.body.querySelector('#nick-input').value.trim();
      try {
        await api.setNickname(serverId, member.user.id, nickname || null);
        await refresh();
        m.close();
      } catch (err) { m.body.querySelector('#nick-err').textContent = apiErrorMessage(err, t('serverSettings.couldNotSetNicknameError')); }
    };
    footer.querySelector('[data-save]').addEventListener('click', save);
    m.body.querySelector('#nick-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  }

  function kickMember(member) {
    confirmModal({
      title: t('serverSettings.kickMemberTitle'),
      message: t('serverSettings.kickConfirmMessage', { name: escapeHtml(member.user.displayName) }),
      confirmLabel: t('serverSettings.kickButton'),
      async onConfirm() {
        try { await api.kickMember(serverId, member.user.id); await refresh(); }
        catch (err) { toast(apiErrorMessage(err, t('serverSettings.couldNotKickError')), { type: 'error' }); }
      },
    });
  }

  function banMember(member) {
    confirmModal({
      title: t('profile.banMemberTitle'),
      message: t('serverSettings.banMemberMessage', { name: escapeHtml(member.user.displayName) }),
      confirmLabel: t('profile.banButton'),
      async onConfirm() {
        try { await api.banMember(serverId, member.user.id); await refresh(); }
        catch (err) { toast(apiErrorMessage(err, t('serverSettings.couldNotBanError')), { type: 'error' }); }
      },
    });
  }

  refresh();
  return { close };
}
