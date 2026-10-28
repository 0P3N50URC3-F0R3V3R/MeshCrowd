import { bus } from '../bus.js';
import { api } from '../api.js';
import { state } from '../state.js';
import { clearCachedIdentity, getVerifiedSeed, cacheSeed, seedMatchesAccount } from '../e2ee/identity.js';
import { generateSeed, deriveKeys, formatPassportId, MIN_PASSPHRASE_LENGTH, MIN_PASSWORD_LENGTH } from '../e2ee/crypto.mjs';
import {
  downloadPassportFile, readFileWithPassphrase, markExported, lastExportedAt, passportBundle, proveWith,
  currentCredential, currentCredentialField, splitCredential, legacyCredential, wrapFor,
} from '../passport/flow.js';
import { icons } from '../icons.js';
import { avatarHtml, escapeHtml, toast, apiErrorMessage, bannerStyle, cardStyle, navScroll, restoreNavScroll } from '../utils.js';
import { openAdminPanel } from './admin.js';
import { nextZIndex } from '../zstack.js';
import { voicePrefs, keyLabel } from '../voicePrefs.js';
import { statusEmojiFieldHtml, bindStatusEmojiField } from './statusEmojiField.js';
import { startMicMeter } from '../micMeter.js';
import { notifySound, CUSTOM_MAX_BYTES, CUSTOM_MAX_SECONDS } from '../notifySound.js';
import { COLOR_FIELDS, GRADIENT_FIELDS, FONT_LABELS, PRESETS, DEFAULT_THEME, generateCss, parseCss, applyTheme } from '../theme.js';
import { t } from '../i18n.js';
import { unreadPrefs as unreadPrefsOf } from '../unreadLine.mjs';

// A function (not a module-level constant) so the labels re-evaluate against the current
// language — see userBar.js's statusOptions() for why a plain top-level array would freeze.
// Reuses the common.status* keys userBar.js already established for this exact vocabulary.
function statusOptions() {
  return [
    { value: 'online', label: t('common.statusOnline'), color: 'var(--green)' },
    { value: 'idle', label: t('common.statusIdle'), color: 'var(--yellow)' },
    { value: 'dnd', label: t('common.statusDnd'), color: 'var(--red)' },
    { value: 'invisible', label: t('common.statusInvisible'), color: 'var(--grey-status)' },
  ];
}

export function openUserSettings(initialTab = 'account') {
  let tab = initialTab;
  let totpStep = 'idle'; // idle | setup (QR shown, awaiting code) | recovery (codes shown once)
  let totpSetupData = null; // { secret, qrDataUrl } while step === 'setup'
  let totpRecoveryCodes = null; // while step === 'recovery'
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

  function render() {
    const me = state.me;
    const navX = navScroll(overlay);
    overlay.innerHTML = `
      <div class="settings-nav">
        <div class="snav-inner">
          <div class="snav-label">${t('userSettings.navLabel')}</div>
          <div class="snav-item ${tab === 'account' ? 'active' : ''}" data-tab="account">${t('userSettings.myAccountTab')}</div>
          <div class="snav-item ${tab === 'status' ? 'active' : ''}" data-tab="status">${t('userSettings.statusTab')}</div>
          <div class="snav-item ${tab === 'notifications' ? 'active' : ''}" data-tab="notifications">${t('userSettings.notificationsTab')}</div>
          <div class="snav-item ${tab === 'voice' ? 'active' : ''}" data-tab="voice">${t('userSettings.voiceVideoTab')}</div>
          <div class="snav-item ${tab === 'appearance' ? 'active' : ''}" data-tab="appearance">${t('userSettings.appearanceTab')}</div>
          <div class="snav-item ${tab === 'privacy' ? 'active' : ''}" data-tab="privacy">${t('userSettings.privacySafetyTab')}</div>
          <div class="snav-item ${tab === 'passport' ? 'active' : ''}" data-tab="passport">${t('passport.tab')}</div>
          ${window.dismeshClient && !window.dismeshClient.isAndroidWebView ? `<div class="snav-item ${tab === 'app' ? 'active' : ''}" data-tab="app">${t('userSettings.desktopAppTab')}</div>` : ''}
          ${me.isSiteAdmin ? `<div class="snav-label">${t('userSettings.instanceLabel')}</div><div class="snav-item" data-admin>${t('userSettings.adminPanelNav')}</div>` : ''}
          <div class="snav-label"></div>
          <div class="snav-item danger" data-logout>${t('userSettings.logOut')}</div>
        </div>
      </div>
      <div class="settings-content"><div class="sc-inner" id="sc-inner"></div></div>
      <button class="settings-close" id="sc-close">${icons.x(18)}</button>`;

    restoreNavScroll(overlay, navX);
    overlay.querySelectorAll('[data-tab]').forEach((n) => n.addEventListener('click', () => { tab = n.dataset.tab; render(); }));
    overlay.querySelector('[data-admin]')?.addEventListener('click', () => { close(); openAdminPanel(); });
    overlay.querySelector('[data-logout]').addEventListener('click', doLogout);
    overlay.querySelector('#sc-close').addEventListener('click', close);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });

    const inner = overlay.querySelector('#sc-inner');
    if (tab === 'account') renderAccount(inner);
    else if (tab === 'status') renderStatus(inner);
    else if (tab === 'notifications') renderNotifications(inner);
    else if (tab === 'voice') renderVoice(inner);
    else if (tab === 'appearance') renderAppearance(inner);
    else if (tab === 'privacy') renderPrivacy(inner);
    else if (tab === 'passport') renderPassport(inner);
    else if (tab === 'app') renderApp(inner);
  }

  let bannerColorTouched = false;
  let cardColorTouched = false;
  let pendingBannerColor = '';
  let pendingCardColor = '';

  function renderAccount(inner) {
    const me = state.me;
    if (!bannerColorTouched) pendingBannerColor = me.bannerColor || '';
    if (!cardColorTouched) pendingCardColor = me.cardColor || '';
    const previewUser = { ...me, bannerColor: pendingBannerColor, cardColor: pendingCardColor };
    inner.innerHTML = `
      <h2>${t('userSettings.myAccountTab')}</h2>
      <div class="settings-avatar-row">
        <div class="avatar-edit" id="avatar-edit">
          ${avatarHtml(me, 80)}
          <div class="overlay-hint">${t('userSettings.changeAvatar')}</div>
        </div>
        <input type="file" id="avatar-input" class="hidden" accept="image/png,image/jpeg,image/gif,image/webp">
        <div>
          <div style="font-weight:700;font-size:18px">${escapeHtml(me.displayName)}</div>
          <div style="color:var(--text-muted);font-size:14px">@${escapeHtml(me.username)}</div>
        </div>
      </div>
      <div class="field">
        <label>${t('userSettings.displayNameLabel')}</label>
        <input class="input" id="f-display" value="${escapeHtml(me.displayName)}">
      </div>
      <div class="field">
        <label>${t('userSettings.bioLabel')}</label>
        <textarea class="textarea" id="f-bio" maxlength="500" placeholder="${t('userSettings.bioPlaceholder')}">${escapeHtml(me.bio || '')}</textarea>
      </div>
      <div class="field"><label>${t('userSettings.usernameLabel')}</label><input class="input" value="${escapeHtml(me.username)}" disabled></div>
      <div class="field"><label>${t('userSettings.emailLabel')}</label><input class="input" value="${escapeHtml(me.email || '')}" disabled></div>
      <div class="divider"></div>
      <h2>${t('userSettings.profileCardHeading')}</h2>
      <div class="field">
        <label>${t('userSettings.bannerLabel')}</label>
        <div style="display:flex;align-items:center;gap:8px">
          <input type="color" class="theme-color-input" id="f-banner-color" value="${pendingBannerColor || '#0d9488'}">
          <button class="btn btn-secondary" id="banner-upload-btn" type="button">${t('userSettings.uploadImageButton')}</button>
          <input type="file" id="banner-input" class="hidden" accept="image/png,image/jpeg,image/gif,image/webp">
          ${me.bannerPath ? `<button class="btn btn-ghost" id="banner-remove-btn" type="button">${t('userSettings.removeImageButton')}</button>` : ''}
        </div>
      </div>
      <div class="field">
        <label>${t('userSettings.cardBackgroundLabel')}</label>
        <div style="display:flex;align-items:center;gap:8px">
          <input type="color" class="theme-color-input" id="f-card-color" value="${pendingCardColor || '#2b2d31'}">
          <button class="btn btn-secondary" id="card-upload-btn" type="button">${t('userSettings.uploadImageButton')}</button>
          <input type="file" id="card-input" class="hidden" accept="image/png,image/jpeg,image/gif,image/webp">
          ${me.cardPath ? `<button class="btn btn-ghost" id="card-remove-btn" type="button">${t('userSettings.removeImageButton')}</button>` : ''}
        </div>
      </div>
      <div class="error-text" id="acc-err"></div>
      <button class="btn btn-primary" id="acc-save">${t('userSettings.saveChangesButton')}</button>

      <div class="profile-preview" id="acc-preview">
        <div class="pp-banner" id="pp-banner-preview" style="${bannerStyle(previewUser)}"></div>
        <div class="pp-body" id="pp-body-preview" style="${cardStyle(previewUser)}">
          ${avatarHtml(me, 68).replace('class="avatar', 'class="avatar pp-avatar').replace('avatar-fallback', 'avatar-fallback pp-avatar')}
          <div class="pp-name">${escapeHtml(me.displayName)}</div>
          <div class="pp-username">@${escapeHtml(me.username)}</div>
          <div class="pp-bio" id="pp-bio-preview">${escapeHtml(me.bio || '')}</div>
        </div>
      </div>`;

    inner.querySelector('#avatar-edit').addEventListener('click', () => inner.querySelector('#avatar-input').click());
    inner.querySelector('#avatar-input').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const res = await api.uploadAvatar(file);
        state.me.avatarPath = res.avatarPath;
        bus.emit('state:me');
        render();
      } catch (err) {
        toast(apiErrorMessage(err, t('userSettings.couldNotUploadAvatar')), { type: 'error' });
      }
    });

    const bioInput = inner.querySelector('#f-bio');
    bioInput.addEventListener('input', () => { inner.querySelector('#pp-bio-preview').textContent = bioInput.value; });

    inner.querySelector('#f-banner-color').addEventListener('input', (e) => {
      bannerColorTouched = true;
      pendingBannerColor = e.target.value;
      inner.querySelector('#pp-banner-preview').setAttribute('style', bannerStyle({ ...me, bannerColor: pendingBannerColor }));
    });
    inner.querySelector('#f-card-color').addEventListener('input', (e) => {
      cardColorTouched = true;
      pendingCardColor = e.target.value;
      inner.querySelector('#pp-body-preview').setAttribute('style', cardStyle({ ...me, cardColor: pendingCardColor }));
    });

    inner.querySelector('#banner-upload-btn').addEventListener('click', () => inner.querySelector('#banner-input').click());
    inner.querySelector('#banner-input').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const res = await api.uploadBanner(file);
        state.me.bannerPath = res.bannerPath;
        bus.emit('state:me');
        render();
      } catch (err) { toast(apiErrorMessage(err, t('userSettings.couldNotUploadBanner')), { type: 'error' }); }
    });
    inner.querySelector('#banner-remove-btn')?.addEventListener('click', async () => {
      try {
        await api.deleteBanner();
        state.me.bannerPath = null;
        bus.emit('state:me');
        render();
      } catch (err) { toast(apiErrorMessage(err, t('userSettings.couldNotRemoveBanner')), { type: 'error' }); }
    });

    inner.querySelector('#card-upload-btn').addEventListener('click', () => inner.querySelector('#card-input').click());
    inner.querySelector('#card-input').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const res = await api.uploadCard(file);
        state.me.cardPath = res.cardPath;
        bus.emit('state:me');
        render();
      } catch (err) { toast(apiErrorMessage(err, t('userSettings.couldNotUploadCard')), { type: 'error' }); }
    });
    inner.querySelector('#card-remove-btn')?.addEventListener('click', async () => {
      try {
        await api.deleteCard();
        state.me.cardPath = null;
        bus.emit('state:me');
        render();
      } catch (err) { toast(apiErrorMessage(err, t('userSettings.couldNotRemoveCard')), { type: 'error' }); }
    });

    inner.querySelector('#acc-save').addEventListener('click', async () => {
      const displayName = inner.querySelector('#f-display').value.trim();
      const bio = bioInput.value;
      const errBox = inner.querySelector('#acc-err');
      errBox.textContent = '';
      const payload = { displayName, bio };
      if (bannerColorTouched) payload.bannerColor = pendingBannerColor;
      if (cardColorTouched) payload.cardColor = pendingCardColor;
      try {
        const res = await api.updateMe(payload);
        Object.assign(state.me, res.user);
        bannerColorTouched = false;
        cardColorTouched = false;
        bus.emit('state:me');
        toast(t('userSettings.profileUpdated'));
      } catch (err) {
        errBox.textContent = apiErrorMessage(err, t('userSettings.couldNotSaveChanges'));
      }
    });
  }

  function renderStatus(inner) {
    const me = state.me;
    inner.innerHTML = `
      <h2>${t('userSettings.statusTab')}</h2>
      <div class="field">
        <label>${t('userSettings.onlineStatusLabel')}</label>
        <div class="status-picker" id="status-picker">
          ${statusOptions().map((opt) => `
            <div class="status-option ${me.status === opt.value ? 'selected' : ''}" data-status="${opt.value}">
              <span class="dot-lg" style="background:${opt.color}"></span>
              <span class="label">${opt.label}</span>
              <span class="check">${icons.check(16)}</span>
            </div>`).join('')}
        </div>
      </div>
      <div class="divider"></div>
      <div class="field">
        <label>${t('userSettings.customStatusLabel')}</label>
        <div style="display:flex;gap:8px;align-items:center">
          ${statusEmojiFieldHtml('f-emoji', me.customStatusEmoji)}
          <input class="input" id="f-status-text" placeholder="${t('userBar.customStatusTextPlaceholder')}" maxlength="128" value="${escapeHtml(me.customStatusText || '')}">
        </div>
        <div class="hint" style="margin-top:8px">${t('userBar.quickPicks')} ${['🎮','💻','🎧','☕','😴','🚀'].map((e) => `<button type="button" class="quick-emoji" data-e="${e}" style="font-size:18px;margin-right:6px">${e}</button>`).join('')}</div>
      </div>
      <button class="btn btn-primary" id="status-save">${t('common.save')}</button>`;

    const setStatusEmoji = bindStatusEmojiField(inner, 'f-emoji');
    inner.querySelectorAll('.quick-emoji').forEach((b) => b.addEventListener('click', () => setStatusEmoji(b.dataset.e)));

    inner.querySelectorAll('[data-status]').forEach((node) => {
      node.addEventListener('click', async () => {
        try {
          await api.setStatus({ status: node.dataset.status });
          state.me.status = node.dataset.status;
          bus.emit('state:me');
          render();
        } catch (err) { toast(apiErrorMessage(err), { type: 'error' }); }
      });
    });

    inner.querySelector('#status-save').addEventListener('click', async () => {
      const customStatusEmoji = inner.querySelector('#f-emoji').value.trim();
      const customStatusText = inner.querySelector('#f-status-text').value.trim();
      try {
        await api.setStatus({ customStatusEmoji, customStatusText });
        state.me.customStatusEmoji = customStatusEmoji;
        state.me.customStatusText = customStatusText;
        bus.emit('state:me');
        toast(t('userBar.statusUpdated'));
      } catch (err) { toast(apiErrorMessage(err), { type: 'error' }); }
    });
  }

  function renderNotifications(inner) {
    const me = state.me;
    const supported = typeof Notification !== 'undefined';
    const perm = supported ? Notification.permission : 'unsupported';
    const statusLabel = {
      granted: t('userSettings.notifStatusEnabled'),
      denied: t('userSettings.notifStatusBlocked'),
      default: t('userSettings.notifStatusDefault'),
      unsupported: t('userSettings.notifStatusUnsupported'),
    }[perm];
    const sound = notifySound.get();
    inner.innerHTML = `
      <h2>${t('userSettings.notificationsTab')}</h2>
      <p style="color:var(--text-secondary);font-size:14px;margin:0 0 12px">
        ${t('userSettings.desktopNotificationsIntro')}
      </p>
      <div class="field">
        <label>${t('userSettings.desktopNotificationsLabel')}</label>
        <div style="display:flex;align-items:center;gap:12px">
          <span style="color:var(--text-muted);font-size:14px">${statusLabel}</span>
          ${perm === 'default' ? `<button class="btn btn-primary" id="notif-enable">${t('userSettings.enableButton')}</button>` : ''}
        </div>
      </div>
      <div class="divider"></div>
      <div class="field">
        <label>${t('userSettings.notificationSoundStatusLabel')}</label>
        <select class="input" id="f-sound-mode">
          <option value="auto" ${me.notifySoundMode === 'auto' || !me.notifySoundMode ? 'selected' : ''}>${t('userSettings.soundModeAuto')}</option>
          <option value="always" ${me.notifySoundMode === 'always' ? 'selected' : ''}>${t('userSettings.soundModeAlways')}</option>
          <option value="never" ${me.notifySoundMode === 'never' ? 'selected' : ''}>${t('userBar.soundNever')}</option>
        </select>
      </div>
      <label class="checkbox-row">
        <input type="checkbox" id="f-sound-enabled" ${sound.enabled ? 'checked' : ''}>
        <span>${t('userSettings.playSoundCheckbox')}</span>
      </label>
      ${sound.enabled ? `
      <div class="field">
        <label>${t('userSettings.soundVolumeLabel')} <span id="sound-vol-val">${Math.round(sound.volume * 100)}</span>%</label>
        <input type="range" id="f-sound-volume" min="0" max="100" value="${Math.round(sound.volume * 100)}" style="accent-color:var(--brand)">
      </div>
      <label class="checkbox-row">
        <input type="checkbox" id="f-sound-focused" ${sound.playWhenFocused ? 'checked' : ''}>
        <span>${t('userSettings.alsoPlayWhenFocusedCheckbox')}</span>
      </label>
      <div class="field">
        <label>${t('userSettings.soundSourceLabel')}</label>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span style="color:var(--text-secondary);font-size:14px" id="sound-source-name">${sound.useCustom && sound.customName ? escapeHtml(sound.customName) : t('userSettings.soundDefaultName')}</span>
          <button type="button" class="btn btn-secondary" id="f-sound-choose">${t('userSettings.chooseSoundButton')}</button>
          ${sound.useCustom ? `<button type="button" class="btn btn-secondary" id="f-sound-reset">${t('userSettings.resetSoundButton')}</button>` : ''}
          <input type="file" id="f-sound-file" class="hidden" accept="audio/*,.ogg,.oga,.wav,.mp3,.m4a,.mp4,.webm,.flac,.aac">
        </div>
        <div class="hint" style="margin-top:6px">${t('userSettings.soundFormatsHint')}</div>
        <div class="hint" style="margin-top:2px"><strong>${t('userSettings.soundLimitsHint', { mb: CUSTOM_MAX_BYTES / 1048576, sec: CUSTOM_MAX_SECONDS })}</strong></div>
      </div>
      <button type="button" class="btn btn-secondary" id="f-sound-test" style="margin-top:8px">${t('userSettings.testSoundButton')}</button>` : ''}`;

    inner.querySelector('#notif-enable')?.addEventListener('click', async () => {
      try { await Notification.requestPermission(); } catch { /* ignore */ }
      renderNotifications(inner);
    });
    inner.querySelector('#f-sound-mode').addEventListener('change', async (e) => {
      const notifySoundMode = e.target.value;
      try {
        await api.setStatus({ notifySoundMode });
        state.me.notifySoundMode = notifySoundMode;
        bus.emit('state:me');
      } catch (err) { toast(apiErrorMessage(err), { type: 'error' }); renderNotifications(inner); }
    });
    inner.querySelector('#f-sound-enabled').addEventListener('change', (e) => {
      notifySound.set({ enabled: e.target.checked });
      renderNotifications(inner);
    });
    inner.querySelector('#f-sound-volume')?.addEventListener('input', (e) => {
      inner.querySelector('#sound-vol-val').textContent = e.target.value;
      notifySound.set({ volume: Number(e.target.value) / 100 });
    });
    inner.querySelector('#f-sound-focused')?.addEventListener('change', (e) => notifySound.set({ playWhenFocused: e.target.checked }));
    inner.querySelector('#f-sound-test')?.addEventListener('click', () => notifySound.play());
    const soundFile = inner.querySelector('#f-sound-file');
    inner.querySelector('#f-sound-choose')?.addEventListener('click', () => soundFile.click());
    soundFile?.addEventListener('change', async () => {
      const file = soundFile.files[0];
      if (!file) return;
      try {
        await notifySound.setCustom(file);
        toast(t('userSettings.soundSaved'));
        notifySound.play();
      } catch (err) {
        const key = { tooLarge: 'soundErrTooLarge', tooLong: 'soundErrTooLong', storage: 'soundErrStorage' }[err.message] || 'soundErrUndecodable';
        toast(t('userSettings.' + key, { mb: CUSTOM_MAX_BYTES / 1048576, sec: CUSTOM_MAX_SECONDS }), { type: 'error' });
      }
      renderNotifications(inner);
    });
    inner.querySelector('#f-sound-reset')?.addEventListener('click', async () => {
      await notifySound.clearCustom();
      renderNotifications(inner);
    });
  }

  let stopVadMeter = null;

  async function renderVoice(inner) {
    stopVadMeter?.();
    stopVadMeter = null;
    let devices = [];
    try { devices = await navigator.mediaDevices.enumerateDevices(); } catch { /* enumerateDevices unsupported — pickers fall back to defaults */ }
    const inputs = devices.filter((d) => d.kind === 'audioinput');
    const outputs = devices.filter((d) => d.kind === 'audiooutput');
    const prefs = voicePrefs.get();
    let capturingKey = false;

    inner.innerHTML = `
      <h2>${t('userSettings.voiceVideoTab')}</h2>
      <p style="color:var(--text-secondary);font-size:14px;margin:0 0 12px">
        ${t('userSettings.voiceVideoIntro')}
      </p>
      <div class="field">
        <label>${t('userSettings.inputDeviceLabel')}</label>
        <select class="select" id="f-input-device">
          <option value="">${t('userSettings.defaultMicrophone')}</option>
          ${inputs.map((d, i) => `<option value="${escapeHtml(d.deviceId)}" ${d.deviceId === prefs.inputDeviceId ? 'selected' : ''}>${escapeHtml(d.label || t('userSettings.microphoneFallback', { n: i + 1 }))}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>${t('userSettings.outputDeviceLabel')}</label>
        <select class="select" id="f-output-device">
          <option value="">${t('userSettings.defaultSpeaker')}</option>
          ${outputs.map((d, i) => `<option value="${escapeHtml(d.deviceId)}" ${d.deviceId === prefs.outputDeviceId ? 'selected' : ''}>${escapeHtml(d.label || t('userSettings.speakerFallback', { n: i + 1 }))}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>${t('userSettings.inputVolumeLabel')} <span id="input-vol-val">${Math.round(prefs.inputVolume * 100)}</span>%</label>
        <input type="range" id="f-input-volume" min="0" max="200" value="${Math.round(prefs.inputVolume * 100)}" style="accent-color:var(--brand)">
      </div>
      <div class="field">
        <label>${t('userSettings.outputVolumeLabel')} <span id="output-vol-val">${Math.round(prefs.outputVolume * 100)}</span>%</label>
        <input type="range" id="f-output-volume" min="0" max="200" value="${Math.round(prefs.outputVolume * 100)}" style="accent-color:var(--brand)">
      </div>
      <div class="field">
        <label class="checkbox-row"><input type="checkbox" id="f-noise-suppression" ${prefs.noiseSuppression ? 'checked' : ''}><span>${t('userSettings.noiseSuppressionLabel')}</span></label>
        <div class="hint">${t('userSettings.noiseSuppressionHint')}</div>
      </div>
      <div class="divider"></div>
      <div class="field">
        <label>${t('userSettings.inputModeLabel')}</label>
        <label class="checkbox-row"><input type="radio" name="f-input-mode" value="always" ${!prefs.pttEnabled && !prefs.vadEnabled ? 'checked' : ''}><span>${t('userSettings.alwaysOnOption')}</span></label>
        <label class="checkbox-row"><input type="radio" name="f-input-mode" value="vad" ${prefs.vadEnabled ? 'checked' : ''}><span>${t('userSettings.voiceActivityOption')}</span></label>
        <label class="checkbox-row"><input type="radio" name="f-input-mode" value="ptt" ${prefs.pttEnabled ? 'checked' : ''}><span>${t('userSettings.pushToTalkOption')}</span></label>
      </div>
      ${prefs.vadEnabled ? `
      <div class="field">
        <label>${t('userSettings.sensitivityLabelPrefix')}<span id="vad-threshold-val">${prefs.vadThreshold}</span>${t('userSettings.sensitivityLabelSuffix')}</label>
        <div class="vad-meter"><div class="vad-track"></div><div class="vad-fill" id="vad-fill"></div>
          <input type="range" id="f-vad-threshold" min="1" max="80" value="${prefs.vadThreshold}"></div>
        <div class="hint" id="vad-meter-hint">${t('userSettings.micLevelHint')}</div>
      </div>` : ''}
      ${prefs.pttEnabled ? `
      <div class="field">
        <label>${t('userSettings.pushToTalkKeyLabel')}</label>
        <button type="button" class="btn btn-secondary" id="f-ptt-key" style="width:160px">${keyLabel(prefs.pttKey)}</button>
      </div>` : ''}`;

    inner.querySelector('#f-input-device').addEventListener('change', (e) => {
      voicePrefs.set({ inputDeviceId: e.target.value || null });
      renderVoice(inner);
    });
    const vadFill = inner.querySelector('#vad-fill');
    if (vadFill) {
      const slider = inner.querySelector('#f-vad-threshold');
      let cancelled = false;
      let stop = null;
      stopVadMeter = () => { cancelled = true; stop?.(); };
      startMicMeter(prefs.inputDeviceId, (level) => {
        if (!vadFill.isConnected) { stopVadMeter(); return; }
        vadFill.style.width = `${Math.min(100, (level / Number(slider.max)) * 100)}%`;
        vadFill.classList.toggle('open', level > Number(slider.value));
      }).then((s) => { if (cancelled) s(); else stop = s; })
        .catch(() => { inner.querySelector('#vad-meter-hint').textContent = t('userSettings.micLevelUnavailable'); });
    }
    inner.querySelector('#f-noise-suppression').addEventListener('change', (e) => voicePrefs.set({ noiseSuppression: e.target.checked }));
    inner.querySelector('#f-output-device').addEventListener('change', (e) => voicePrefs.set({ outputDeviceId: e.target.value || null }));
    inner.querySelector('#f-input-volume').addEventListener('input', (e) => {
      inner.querySelector('#input-vol-val').textContent = e.target.value;
      voicePrefs.set({ inputVolume: Number(e.target.value) / 100 });
    });
    inner.querySelector('#f-output-volume').addEventListener('input', (e) => {
      inner.querySelector('#output-vol-val').textContent = e.target.value;
      voicePrefs.set({ outputVolume: Number(e.target.value) / 100 });
    });
    inner.querySelectorAll('input[name="f-input-mode"]').forEach((r) => r.addEventListener('change', (e) => {
      voicePrefs.set({ vadEnabled: e.target.value === 'vad', pttEnabled: e.target.value === 'ptt' });
      renderVoice(inner);
    }));
    inner.querySelector('#f-vad-threshold')?.addEventListener('input', (e) => {
      inner.querySelector('#vad-threshold-val').textContent = e.target.value;
      voicePrefs.set({ vadThreshold: Number(e.target.value) });
    });

    const keyBtn = inner.querySelector('#f-ptt-key');
    keyBtn?.addEventListener('click', () => {
      if (capturingKey) return;
      capturingKey = true;
      keyBtn.textContent = t('userSettings.pressAnyKey');
      const onKey = (e) => {
        e.preventDefault();
        voicePrefs.set({ pttKey: e.code });
        keyBtn.textContent = keyLabel(e.code);
        capturingKey = false;
        document.removeEventListener('keydown', onKey, true);
      };
      document.addEventListener('keydown', onKey, true);
    });
  }

  // Mirrors electron/trayIcon.js's built-in BRAND/STATUS_COLORS - shown as each color input's
  // value whenever the user hasn't overridden that one, so the swatch always reflects what the
  // actual tray icon looks like right now, not just an empty/unset-looking input.
  const TRAY_DEFAULTS = { base: '#0d9488', online: '#23a55a', idle: '#f0b232', dnd: '#f23f43', offline: '#80848e' };

  async function renderApp(inner) {
    inner.innerHTML = `<h2>${t('userSettings.desktopAppTab')}</h2><div class="panel-loading" style="height:80px"><div class="spinner"></div></div>`;
    const settings = await window.dismeshClient.getAppSettings();
    const badgeColors = settings.trayBadgeColors || {};
    const badgeLabels = { online: t('common.statusOnline'), idle: t('common.statusIdle'), dnd: t('common.statusDnd'), offline: t('userSettings.trayStatusOffline') };
    inner.innerHTML = `
      <h2>${t('userSettings.desktopAppTab')}</h2>
      <label class="checkbox-row">
        <input type="checkbox" id="f-close-tray" ${settings.closeToTray ? 'checked' : ''}>
        <span>${t('userSettings.closeToTrayCheckbox')}</span>
      </label>
      <label class="checkbox-row">
        <input type="checkbox" id="f-start-windows" ${settings.startWithWindows ? 'checked' : ''}>
        <span>${t('userSettings.startWithWindowsCheckbox')}</span>
      </label>
      <label class="checkbox-row">
        <input type="checkbox" id="f-invite-links" ${settings.handleInviteLinks ? 'checked' : ''}>
        <span>${t('userSettings.handleInviteLinksCheckbox')}</span>
      </label>
      <div class="hint" style="margin-top:8px">${t('userSettings.trayRightClickHint')}</div>
      <div class="divider"></div>
      <h2>${t('userSettings.trayIconHeading')}</h2>
      <p class="hint" style="margin:-8px 0 16px">${t('userSettings.trayIconHint')}</p>
      <div class="field">
        <label>${t('userSettings.baseIconColorLabel')}</label>
        <div style="display:flex;align-items:center;gap:8px">
          <input type="color" class="theme-color-input" id="f-tray-base" value="${settings.trayIconColor || TRAY_DEFAULTS.base}">
          <button class="btn btn-ghost btn-sm" id="f-tray-base-reset">${t('userSettings.resetButton')}</button>
        </div>
      </div>
      <div class="field">
        <label>${t('userSettings.unreadBadgeColorsLabel')}</label>
        <div style="display:flex;flex-wrap:wrap;gap:16px">
          ${['online', 'idle', 'dnd', 'offline'].map((s) => `
            <div style="display:flex;align-items:center;gap:6px">
              <input type="color" class="theme-color-input" data-badge="${s}" value="${badgeColors[s] || TRAY_DEFAULTS[s]}">
              <span style="font-size:13px">${escapeHtml(badgeLabels[s])}</span>
            </div>`).join('')}
        </div>
        <button class="btn btn-ghost btn-sm" id="f-tray-badges-reset" style="margin-top:8px">${t('userSettings.resetAllButton')}</button>
      </div>`;

    inner.querySelector('#f-close-tray').addEventListener('change', async (e) => {
      await window.dismeshClient.setAppSettings({ closeToTray: e.target.checked });
      toast(e.target.checked ? t('userSettings.minimizeToTrayToast') : t('userSettings.quitOnCloseToast'));
    });
    inner.querySelector('#f-start-windows').addEventListener('change', async (e) => {
      await window.dismeshClient.setAppSettings({ startWithWindows: e.target.checked });
      toast(e.target.checked ? t('userSettings.startsWithWindowsToast') : t('userSettings.noLongerStartsWithWindowsToast'));
    });
    inner.querySelector('#f-invite-links').addEventListener('change', async (e) => {
      await window.dismeshClient.setAppSettings({ handleInviteLinks: e.target.checked });
      toast(e.target.checked ? t('userSettings.inviteLinksOnToast') : t('userSettings.inviteLinksOffToast'));
    });
    inner.querySelector('#f-tray-base').addEventListener('change', async (e) => {
      await window.dismeshClient.setAppSettings({ trayIconColor: e.target.value });
      toast(t('userSettings.trayColorUpdatedToast'));
    });
    inner.querySelector('#f-tray-base-reset').addEventListener('click', async () => {
      await window.dismeshClient.setAppSettings({ trayIconColor: null });
      renderApp(inner);
    });
    inner.querySelectorAll('[data-badge]').forEach((input) => {
      input.addEventListener('change', async (e) => {
        await window.dismeshClient.setAppSettings({ trayBadgeColors: { [e.target.dataset.badge]: e.target.value } });
        toast(t('userSettings.trayBadgeUpdatedToast'));
      });
    });
    inner.querySelector('#f-tray-badges-reset').addEventListener('click', async () => {
      await window.dismeshClient.setAppSettings({ trayBadgeColors: { online: null, idle: null, dnd: null, offline: null } });
      renderApp(inner);
    });
  }

  // Per-user CSS-variable theme: colors + font only, no free-form CSS (see server/lib/theme.js
  // sanitizeTheme for why) — this is the picker UI plus the export/import "share it as text" box.
  async function renderAppearance(inner) {
    const me = state.me;
    let pending;
    try { pending = (await api.getTheme()).theme; } catch { pending = { ...DEFAULT_THEME }; }
    let languageOptions = [];
    let currentLanguageCode = me.language || 'en';
    try { languageOptions = (await api.getLanguages()).languages; } catch { /* leave empty; select just won't render usefully */ }
    let landingView = 'home';
    try { landingView = (await api.getUiPrefs()).uiPrefs.landingView || 'home'; } catch { /* leave default */ }
    const unreadPrefs = unreadPrefsOf(state.uiPrefs);

    function paint() {
      inner.innerHTML = `
        <h2>${t('userSettings.appearanceTab')}</h2>
        <p class="hint" style="color:var(--text-secondary);font-size:14px;margin:0 0 12px">
          ${t('userSettings.appearanceHint')}
        </p>
        <div class="field">
          <label>${t('userSettings.languageLabel')}</label>
          <select class="input" id="f-language" style="max-width:280px">
            ${languageOptions.map((l) => `<option value="${l.code}" ${l.code === currentLanguageCode ? 'selected' : ''}>${l.name}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label>${t('userSettings.landingViewLabel')}</label>
          <select class="input" id="f-landing-view" style="max-width:280px">
            <option value="home" ${landingView === 'home' ? 'selected' : ''}>${t('userSettings.landingViewHome')}</option>
            <option value="lastLocation" ${landingView === 'lastLocation' ? 'selected' : ''}>${t('userSettings.landingViewLastLocation')}</option>
          </select>
        </div>
        <div class="field">
          <label>${t('userSettings.unreadLineLabel')}</label>
          <select class="input" id="f-unread-line" style="max-width:280px">
            <option value="on" ${unreadPrefs.unreadLine === 'on' ? 'selected' : ''}>${t('userSettings.unreadLineOn')}</option>
            <option value="off" ${unreadPrefs.unreadLine === 'off' ? 'selected' : ''}>${t('userSettings.unreadLineOff')}</option>
          </select>
        </div>
        <div class="field">
          <label>${t('userSettings.unreadJumpLabel')}</label>
          <select class="input" id="f-unread-jump" style="max-width:280px">
            <option value="firstUnread" ${unreadPrefs.unreadJump === 'firstUnread' ? 'selected' : ''}>${t('userSettings.unreadJumpFirst')}</option>
            <option value="bottom" ${unreadPrefs.unreadJump === 'bottom' ? 'selected' : ''}>${t('userSettings.unreadJumpBottom')}</option>
          </select>
        </div>
        <div class="field">
          <label>${t('userSettings.unreadContextLabel')}</label>
          <input type="number" class="input" id="f-unread-context" min="0" max="50" value="${unreadPrefs.unreadContext}" style="max-width:120px">
        </div>
        <div class="field">
          <label>${t('userSettings.initialMessagesLabel')}</label>
          <input type="number" class="input" id="f-initial-messages" min="20" max="100" value="${unreadPrefs.initialMessages}" style="max-width:120px">
        </div>
        <div class="divider"></div>
        <div class="field">
          <label>${t('userSettings.presetsLabel')}</label>
          <div class="theme-preset-grid">
            ${PRESETS.map((p) => `
              <button type="button" class="theme-preset-btn" data-preset="${escapeHtml(p.name)}">
                <span class="theme-preset-swatch" style="background:${p.theme.brand || '#0d9488'}"></span>${escapeHtml(p.name)}
              </button>`).join('')}
          </div>
        </div>
        <div class="divider"></div>
        ${COLOR_FIELDS.map((f) => `
          <div class="field theme-color-row">
            <label>${escapeHtml(f.label)}</label>
            <div style="display:flex;align-items:center;gap:8px">
              <input type="color" class="theme-color-input" id="f-color-${f.key}" value="${pending[f.key] || f.default}">
              <button type="button" class="btn-icon" data-clear="${f.key}" title="${t('userSettings.resetToDefaultTitle')}">${icons.x(14)}</button>
            </div>
          </div>`).join('')}
        <div class="divider"></div>
        <div class="field"><label>${t('userSettings.gradientHeading')}</label><div style="color:var(--text-muted);font-size:13px">${t('userSettings.gradientHint')}</div></div>
        ${GRADIENT_FIELDS.map((f) => `
          <div class="field theme-color-row">
            <label>${t(f.key === 'gradFrom' ? 'userSettings.gradientStartLabel' : 'userSettings.gradientEndLabel')}</label>
            <div style="display:flex;align-items:center;gap:8px">
              <input type="color" class="theme-color-input" id="f-color-${f.key}" value="${pending[f.key] || f.default}">
              <button type="button" class="btn-icon" data-clear="${f.key}" title="${t('userSettings.resetToDefaultTitle')}">${icons.x(14)}</button>
            </div>
          </div>`).join('')}
        <div class="field theme-color-row">
          <label>${t('userSettings.gradientAngleLabel')}</label>
          <div style="display:flex;align-items:center;gap:8px">
            <input type="range" min="0" max="360" step="5" id="f-grad-angle" value="${Number.isInteger(pending.gradAngle) ? pending.gradAngle : 135}">
            <span id="f-grad-angle-val">${Number.isInteger(pending.gradAngle) ? pending.gradAngle : 135}°</span>
          </div>
        </div>
        <div class="divider"></div>
        <div class="field">
          <label>${t('userSettings.fontLabel')}</label>
          <select class="select" id="f-font">
            ${Object.entries(FONT_LABELS).map(([k, label]) => `<option value="${k}" ${pending.font === k ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}
          </select>
        </div>
        <div class="divider"></div>
        <div class="field">
          <label>${t('userSettings.exportLabel')}</label>
          <textarea class="textarea" id="f-export" readonly rows="5">${escapeHtml(generateCss(pending) || t('userSettings.defaultThemeComment'))}</textarea>
          <button type="button" class="btn btn-secondary" id="f-copy" style="align-self:flex-start">${t('userSettings.copyCssButton')}</button>
        </div>
        <div class="field">
          <label>${t('userSettings.importLabel')}</label>
          <textarea class="textarea" id="f-import" rows="5" placeholder=":root { --brand: #0d9488; }"></textarea>
          <button type="button" class="btn btn-secondary" id="f-import-btn" style="align-self:flex-start">${t('userSettings.applyPastedCssButton')}</button>
        </div>
        <div class="divider"></div>
        <button type="button" class="btn btn-danger" id="f-reset">${t('userSettings.resetToDefaultButton')}</button>`;

      for (const f of COLOR_FIELDS) {
        const colorInput = inner.querySelector(`#f-color-${f.key}`);
        colorInput.addEventListener('input', () => { pending[f.key] = colorInput.value; preview(); });
        colorInput.addEventListener('change', () => save());
        inner.querySelector(`[data-clear="${f.key}"]`).addEventListener('click', () => { pending[f.key] = ''; save(); paint(); });
      }
      for (const f of GRADIENT_FIELDS) {
        const colorInput = inner.querySelector(`#f-color-${f.key}`);
        colorInput.addEventListener('input', () => { pending[f.key] = colorInput.value; preview(); });
        colorInput.addEventListener('change', () => save());
        inner.querySelector(`[data-clear="${f.key}"]`).addEventListener('click', () => { pending[f.key] = ''; save(); paint(); });
      }
      const angleInput = inner.querySelector('#f-grad-angle');
      angleInput.addEventListener('input', () => {
        pending.gradAngle = Number(angleInput.value);
        inner.querySelector('#f-grad-angle-val').textContent = `${angleInput.value}°`;
        preview();
      });
      angleInput.addEventListener('change', () => save());
      inner.querySelector('#f-font').addEventListener('change', (e) => { pending.font = e.target.value; save(); });
      inner.querySelector('#f-language')?.addEventListener('change', async (e) => {
        const code = e.target.value;
        try {
          await api.setMyLanguage(code);
          currentLanguageCode = code;
          toast(t('userSettings.languageReloadToast'), {
            action: { label: t('userSettings.languageReloadButton'), onClick: () => window.location.reload() },
          });
        } catch (err) { toast(apiErrorMessage(err), { type: 'error' }); }
      });
      inner.querySelector('#f-landing-view')?.addEventListener('change', async (e) => {
        const value = e.target.value;
        const prev = landingView;
        landingView = value;
        try { await api.setUiPrefs({ landingView: value }); }
        catch (err) { landingView = prev; e.target.value = prev; toast(apiErrorMessage(err), { type: 'error' }); }
      });
      for (const [id, key, num] of [['#f-unread-line', 'unreadLine'], ['#f-unread-jump', 'unreadJump'], ['#f-unread-context', 'unreadContext', true], ['#f-initial-messages', 'initialMessages', true]]) {
        inner.querySelector(id)?.addEventListener('change', async (e) => {
          const value = num ? Number(e.target.value) : e.target.value;
          const prev = unreadPrefs[key];
          try {
            const res = await api.setUiPrefs({ [key]: value });
            Object.assign(state.uiPrefs, res.uiPrefs);
            unreadPrefs[key] = unreadPrefsOf(res.uiPrefs)[key];
            e.target.value = unreadPrefs[key];
          } catch (err) { e.target.value = prev; toast(apiErrorMessage(err), { type: 'error' }); }
        });
      }
      inner.querySelectorAll('[data-preset]').forEach((btn) => btn.addEventListener('click', () => {
        pending = { ...PRESETS.find((p) => p.name === btn.dataset.preset).theme };
        save(); paint();
      }));
      inner.querySelector('#f-copy').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(generateCss(pending)); toast(t('userSettings.themeCssCopiedToast')); }
        catch { toast(t('userSettings.couldNotCopyCss'), { type: 'error' }); }
      });
      inner.querySelector('#f-import-btn').addEventListener('click', () => {
        const text = inner.querySelector('#f-import').value;
        if (!text.trim()) return;
        pending = parseCss(text);
        save(); paint();
        toast(t('userSettings.themeImportedToast'));
      });
      inner.querySelector('#f-reset').addEventListener('click', () => { pending = { ...DEFAULT_THEME }; save(); paint(); });
    }

    // Live-updates the actual app immediately (not just this panel) so a color drag previews for
    // real — but doesn't hit the network on every drag tick, only on the picker's 'change'.
    function preview() { applyTheme(pending); }
    async function save() {
      preview();
      try { await api.setTheme(pending); }
      catch (err) { toast(apiErrorMessage(err), { type: 'error' }); }
    }

    paint();
  }

  const nextPaint = () => new Promise((r) => setTimeout(r, 0));

  async function showWorking(btn) {
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = t('auth.working');
    await nextPaint();
    return () => { btn.disabled = false; btn.textContent = label; };
  }

  // Sets the password (to the same value when restoring) and re-wraps the seed backup in one request.
  async function changePasswordWithBackup(me, seed, currentPassword, newPassword) {
    if (me.authMode === 'split') {
      const current = await currentCredential(me, currentPassword);
      const next = await splitCredential(newPassword);
      await api.changePassword({
        currentAuthKey: current.authKey, newAuthKey: next.authKey, newAuthSalt: next.authSalt, backup: await wrapFor(seed, next),
      });
    } else {
      await api.changePassword({ currentPassword, newPassword, backup: await wrapFor(seed, legacyCredential(newPassword)) });
    }
  }

  // Same, for a user with no seed to re-wrap at all: the server-side backup is explicitly dropped
  // instead, leaving the account in the same no-seed-on-device state (no usable backup either way).
  async function changePasswordDroppingBackup(me, currentPassword, newPassword) {
    if (me.authMode === 'split') {
      const current = await currentCredential(me, currentPassword);
      const next = await splitCredential(newPassword);
      await api.changePassword({
        currentAuthKey: current.authKey, newAuthKey: next.authKey, newAuthSalt: next.authSalt, dropBackup: true,
      });
    } else {
      await api.changePassword({ currentPassword, newPassword, dropBackup: true });
    }
  }

  async function renderPassport(inner) {
    const me = state.me;
    const seedBytes = me.passportId ? await getVerifiedSeed(me) : null;
    const exportedAt = lastExportedAt(me.id);
    const idBlock = `
      <div class="field">
        <label>${t('passport.idLabel')}</label>
        <div style="display:flex;gap:8px;align-items:center">
          <code class="passport-id" title="${escapeHtml(me.passportId || '')}">${me.passportId ? escapeHtml(formatPassportId(me.passportId)) : '-'}</code>
          <button type="button" class="btn btn-secondary" id="pp-copy">${t('passport.copy')}</button>
        </div>
        <div class="hint" style="word-break:break-all">${escapeHtml(me.passportId || '')}</div>
      </div>`;
    const intro = `<h2>${t('passport.title')}</h2>
      <p style="color:var(--text-secondary);font-size:14px;margin:0 0 12px">${t('passport.intro')}</p>`;

    if (!me.passportId) {
      inner.innerHTML = `${intro}
        <div class="divider"></div>
        <h3>${t('passport.createHeading')}</h3>
        <p style="color:var(--text-secondary);font-size:14px;margin:0 0 12px">${t('passport.createIntro')}</p>
        <div class="field"><label>${t('passport.currentPassword')}</label><input class="input" id="pp-create-pw" type="password" autocomplete="current-password"></div>
        <div class="field"><label>${t('passport.authenticatorCodeOptional')}</label><input class="input" id="pp-create-code" autocomplete="one-time-code"></div>
        <button class="btn btn-primary" id="pp-create">${t('passport.createButton')}</button>`;
      const createBtn = inner.querySelector('#pp-create');
      createBtn.addEventListener('click', async () => {
        createBtn.disabled = true;
        const currentPassword = inner.querySelector('#pp-create-pw').value;
        const code = inner.querySelector('#pp-create-code').value.trim();
        try {
          const cred = await currentCredential(me, currentPassword);
          const seed = await generateSeed();
          const keys = await deriveKeys(seed);
          const bundle = await passportBundle(seed, keys, cred);
          const res = await api.passportAttach({
            ...bundle, ...(await proveWith(keys, 'attach')), ...currentCredentialField(cred), ...(code ? { code } : {}),
          });
          await cacheSeed(me.id, seed);
          me.passportId = res.user.passportId;
          toast(t('passport.created'));
          renderPassport(inner);
        } catch (err) { toast(apiErrorMessage(err), { type: 'error' }); } finally { createBtn.disabled = false; }
      });
      return;
    }

    const split = me.authMode === 'split';
    const strengthenBlock = split
      ? `<div class="divider"></div><div class="hint">${t('passport.strengthenDone')}</div>`
      : `
      <div class="divider"></div>
      <h3>${t('passport.strengthenHeading')}</h3>
      <p style="color:var(--text-secondary);font-size:14px;margin:0 0 8px">${t('passport.strengthenIntro')}</p>
      <div class="hint" style="color:var(--yellow);margin-bottom:12px">${t('passport.strengthenAndroidWarning')}</div>
      <div class="field"><label>${t('passport.currentPassword')}</label><input class="input" id="pp-up-cur" type="password" autocomplete="current-password"></div>
      <div class="field"><label>${t('passport.strengthenNewPassword')}</label><input class="input" id="pp-up-new" type="password" autocomplete="new-password"></div>
      <div class="field"><label>${t('passport.strengthenRepeat')}</label><input class="input" id="pp-up-new2" type="password" autocomplete="new-password"></div>
      ${me.totpEnabled ? `<div class="field"><label>${t('auth.codeLabel')}</label><input class="input" id="pp-up-code" autocomplete="one-time-code"></div>` : ''}
      <button class="btn btn-primary" id="pp-upgrade">${t('passport.strengthenButton')}</button>`;

    inner.innerHTML = `${intro}
      ${idBlock}
      <div class="divider"></div>
      ${seedBytes ? `
      <h3>${t('passport.exportHeading')}</h3>
      <div class="hint" id="pp-status">${exportedAt ? t('passport.lastExported', { date: new Date(exportedAt).toLocaleString() }) : t('passport.neverExported')}</div>
      <div class="field"><label>${t('passport.passphraseLabel', { min: MIN_PASSPHRASE_LENGTH })}</label><input class="input" id="pp-pass" type="password" autocomplete="new-password"></div>
      <div class="field"><label>${t('passport.passphraseConfirm')}</label><input class="input" id="pp-pass2" type="password" autocomplete="new-password"></div>
      <button class="btn btn-primary" id="pp-export">${t('passport.exportButton')}</button>
      <div class="divider"></div>
      <h3>${t('passport.changePasswordHeading')}</h3>
      <div class="field"><label>${t('passport.currentPassword')}</label><input class="input" id="pp-cur" type="password" autocomplete="current-password"></div>
      <div class="field"><label>${t('passport.newPassword')}</label><input class="input" id="pp-new" type="password" autocomplete="new-password"></div>
      <button class="btn btn-primary" id="pp-change">${t('passport.changePasswordButton')}</button>
      ${strengthenBlock}`
      : `<div class="hint">${t('passport.noSeedOnDevice')}</div>
      <div class="divider"></div>
      <h3>${t('passport.restoreHeading')}</h3>
      <p style="color:var(--text-secondary);font-size:14px;margin:0 0 8px">${t('passport.restoreIntro')}</p>
      ${split ? '' : `<div class="hint" style="margin-bottom:12px">${t('passport.strengthenNeedsRestore')}</div>`}
      <div class="field"><label>${t('auth.passportFileLabel')}</label><input class="input" id="pp-rs-file" type="file" accept=".mcpass,application/json"></div>
      <div class="field"><label>${t('auth.passportPassphraseLabel')}</label><input class="input" id="pp-rs-pass" type="password" autocomplete="off"></div>
      <div class="field"><label>${t('passport.currentPassword')}</label><input class="input" id="pp-rs-pw" type="password" autocomplete="current-password"><div class="hint">${t('passport.restorePasswordHint')}</div></div>
      <div class="field"><label>${t('passport.newPassword')}</label><input class="input" id="pp-rs-new" type="password" autocomplete="new-password"></div>
      <div class="field"><label>${t('passport.strengthenRepeat')}</label><input class="input" id="pp-rs-new2" type="password" autocomplete="new-password"></div>
      <button class="btn btn-primary" id="pp-restore">${t('passport.restoreButton')}</button>
      <div class="divider"></div>
      <button type="button" class="btn-link" id="pp-rs-nokey">${t('passport.noKeyFileOption')}</button>
      <div id="pp-nk-form" style="display:none">
        <h3>${t('passport.dropBackupHeading')}</h3>
        <div class="field"><label>${t('passport.currentPassword')}</label><input class="input" id="pp-nk-pw" type="password" autocomplete="current-password"></div>
        <div class="field"><label>${t('passport.newPassword')}</label><input class="input" id="pp-nk-new" type="password" autocomplete="new-password"></div>
        <div class="field"><label>${t('passport.strengthenRepeat')}</label><input class="input" id="pp-nk-new2" type="password" autocomplete="new-password"></div>
        <label class="checkbox-row"><input type="checkbox" id="pp-nk-confirm">${t('passport.dropBackupWarning')}</label>
        <button class="btn btn-primary" id="pp-nk-submit" disabled>${t('passport.changePasswordButton')}</button>
      </div>`}`;

    inner.querySelector('#pp-copy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(me.passportId || ''); toast(t('passport.copied')); } catch { /* clipboard blocked */ }
    });
    if (!seedBytes) {
      const restoreBtn = inner.querySelector('#pp-restore');
      restoreBtn.addEventListener('click', async () => {
        const password = inner.querySelector('#pp-rs-pw').value;
        const newPassword = inner.querySelector('#pp-rs-new').value;
        if (password) {
          if (newPassword.length < MIN_PASSWORD_LENGTH) { toast(t('auth.passwordTooShort'), { type: 'error' }); return; }
          if (newPassword !== inner.querySelector('#pp-rs-new2').value) { toast(t('passport.strengthenMismatch'), { type: 'error' }); return; }
          if (newPassword.normalize('NFKC') === password.normalize('NFKC')) { toast(t('passport.strengthenSamePassword'), { type: 'error' }); return; }
        }
        const restore = await showWorking(restoreBtn);
        try {
          let seed;
          try {
            ({ seed } = await readFileWithPassphrase(inner.querySelector('#pp-rs-file').files[0], inner.querySelector('#pp-rs-pass').value));
          } catch { throw new Error(t('auth.passportBadFile')); }
          if (!(await seedMatchesAccount(seed, me.passportId))) throw new Error(t('passport.restoreWrongPassport'));
          if (password) await changePasswordWithBackup(me, seed, password, newPassword);
          await cacheSeed(me.id, seed);
          toast(t(password ? 'passport.restored' : 'passport.restoredLocalOnly'), { ttl: 8000 });
          renderPassport(inner);
        } catch (err) {
          toast(apiErrorMessage(err), { type: 'error' });
        } finally { restore(); }
      });

      const nokeyToggle = inner.querySelector('#pp-rs-nokey');
      const nokeyForm = inner.querySelector('#pp-nk-form');
      nokeyToggle.addEventListener('click', () => { nokeyForm.style.display = nokeyForm.style.display === 'none' ? '' : 'none'; });
      const nkConfirm = inner.querySelector('#pp-nk-confirm');
      const nkSubmit = inner.querySelector('#pp-nk-submit');
      nkConfirm.addEventListener('change', () => { nkSubmit.disabled = !nkConfirm.checked; });
      nkSubmit.addEventListener('click', async () => {
        const currentPassword = inner.querySelector('#pp-nk-pw').value;
        const newPassword = inner.querySelector('#pp-nk-new').value;
        if (newPassword.length < MIN_PASSWORD_LENGTH) { toast(t('auth.passwordTooShort'), { type: 'error' }); return; }
        if (newPassword !== inner.querySelector('#pp-nk-new2').value) { toast(t('passport.strengthenMismatch'), { type: 'error' }); return; }
        if (newPassword.normalize('NFKC') === currentPassword.normalize('NFKC')) { toast(t('passport.strengthenSamePassword'), { type: 'error' }); return; }
        const done = await showWorking(nkSubmit);
        try {
          await changePasswordDroppingBackup(me, currentPassword, newPassword);
          toast(t('passport.passwordChanged'));
          renderPassport(inner);
        } catch (err) {
          toast(apiErrorMessage(err), { type: 'error' });
        } finally { done(); }
      });
      return;
    }

    const exportBtn = inner.querySelector('#pp-export');
    exportBtn.addEventListener('click', async () => {
      const pass = inner.querySelector('#pp-pass').value;
      if (pass.length < MIN_PASSPHRASE_LENGTH) { toast(t('passport.passphraseTooShort', { min: MIN_PASSPHRASE_LENGTH }), { type: 'error' }); return; }
      if (pass !== inner.querySelector('#pp-pass2').value) { toast(t('passport.passphraseMismatch'), { type: 'error' }); return; }
      exportBtn.disabled = true;
      try {
        await downloadPassportFile(seedBytes, pass);
        markExported(me.id);
        toast(t('passport.exported'));
        renderPassport(inner);
      } catch (err) { toast(apiErrorMessage(err), { type: 'error' }); } finally { exportBtn.disabled = false; }
    });

    const changeBtn = inner.querySelector('#pp-change');
    changeBtn.addEventListener('click', async () => {
      const currentPassword = inner.querySelector('#pp-cur').value;
      const newPassword = inner.querySelector('#pp-new').value;
      if (newPassword.length < MIN_PASSWORD_LENGTH) { toast(t('auth.passwordTooShort'), { type: 'error' }); return; }
      const done = await showWorking(changeBtn);
      try {
        await changePasswordWithBackup(me, seedBytes, currentPassword, newPassword);
        toast(t('passport.passwordChanged'));
        renderPassport(inner);
      } catch (err) { toast(apiErrorMessage(err), { type: 'error' }); } finally { done(); }
    });

    if (split) return;
    const upBtn = inner.querySelector('#pp-upgrade');
    upBtn.addEventListener('click', async () => {
      const currentPassword = inner.querySelector('#pp-up-cur').value;
      const newPassword = inner.querySelector('#pp-up-new').value;
      const code = inner.querySelector('#pp-up-code')?.value.trim();
      if (newPassword.length < MIN_PASSWORD_LENGTH) { toast(t('auth.passwordTooShort'), { type: 'error' }); return; }
      if (newPassword !== inner.querySelector('#pp-up-new2').value) { toast(t('passport.strengthenMismatch'), { type: 'error' }); return; }
      // The server saw the current password at every legacy sign-in, so keys derived from it would not be secret from it.
      if (newPassword.normalize('NFKC') === currentPassword.normalize('NFKC')) { toast(t('passport.strengthenSamePassword'), { type: 'error' }); return; }
      const done = await showWorking(upBtn);
      try {
        const next = await splitCredential(newPassword);
        const res = await api.upgradeCredentials({
          currentPassword, authKey: next.authKey, authSalt: next.authSalt, backup: await wrapFor(seedBytes, next), ...(code ? { code } : {}),
        });
        me.authMode = res.user.authMode;
        toast(t('passport.strengthened'), { ttl: 8000 });
        renderPassport(inner);
      } catch (err) { toast(apiErrorMessage(err), { type: 'error' }); } finally { done(); }
    });
  }

  function renderPrivacy(inner) {
    const me = state.me;
    inner.innerHTML = `
      <h2>${t('userSettings.privacySafetyTab')}</h2>
      <div class="field">
        <label>${t('userSettings.whoCanDmLabel')}</label>
        <select class="select" id="f-dm-privacy">
          <option value="everyone" ${me.dmPrivacy === 'everyone' ? 'selected' : ''}>${t('userSettings.everyoneOption')}</option>
          <option value="friends" ${me.dmPrivacy === 'friends' ? 'selected' : ''}>${t('userSettings.friendsOnlyOption')}</option>
          <option value="none" ${me.dmPrivacy === 'none' ? 'selected' : ''}>${t('userSettings.noOneOption')}</option>
        </select>
      </div>
      <div class="field">
        <label>${t('userSettings.whoCanViewProfileLabel')}</label>
        <select class="select" id="f-profile-privacy">
          <option value="everyone" ${me.profilePrivacy === 'everyone' ? 'selected' : ''}>${t('userSettings.everyoneOption')}</option>
          <option value="friends" ${me.profilePrivacy === 'friends' ? 'selected' : ''}>${t('userSettings.friendsOnlyOption')}</option>
        </select>
      </div>
      <label class="checkbox-row">
        <input type="checkbox" id="f-discoverable" ${me.discoverable !== false ? 'checked' : ''}>
        <span>${t('userSettings.discoverableCheckbox')}</span>
      </label>
      <button class="btn btn-primary" id="priv-save">${t('common.save')}</button>

      <h2 style="margin-top:32px">${t('userSettings.twoFactorAuthHeading')}</h2>
      <div id="totp-section"></div>`;

    inner.querySelector('#priv-save').addEventListener('click', async () => {
      const dmPrivacy = inner.querySelector('#f-dm-privacy').value;
      const profilePrivacy = inner.querySelector('#f-profile-privacy').value;
      const discoverable = inner.querySelector('#f-discoverable').checked;
      try {
        const res = await api.updateMe({ dmPrivacy, profilePrivacy, discoverable });
        Object.assign(state.me, res.user);
        bus.emit('state:me');
        toast(t('userSettings.privacyUpdatedToast'));
      } catch (err) { toast(apiErrorMessage(err), { type: 'error' }); }
    });

    renderTotpSection(inner.querySelector('#totp-section'));
  }

  function renderTotpSection(host) {
    if (totpStep === 'recovery') {
      host.innerHTML = `
        <p style="color:var(--text-secondary);font-size:14px">
          ${t('userSettings.totpEnabledNowInfo')}
        </p>
        <div class="totp-recovery-codes">${totpRecoveryCodes.map((c) => `<code>${escapeHtml(c)}</code>`).join('')}</div>
        <button class="btn btn-primary" id="totp-done">${t('userSettings.doneButton')}</button>`;
      host.querySelector('#totp-done').addEventListener('click', () => {
        totpStep = 'idle'; totpRecoveryCodes = null; render();
      });
      return;
    }

    if (totpStep === 'setup') {
      host.innerHTML = `
        <p style="color:var(--text-secondary);font-size:14px">
          ${t('userSettings.totpScanInfo')}
        </p>
        <img class="totp-qr" src="${totpSetupData.qrDataUrl}" alt="2FA QR code" width="180" height="180">
        <p class="hint" style="font-size:12px;color:var(--text-faint)">${t('userSettings.totpManualKeyHint')} <code>${escapeHtml(totpSetupData.secret)}</code></p>
        <div class="field">
          <label for="totp-code">${t('userSettings.sixDigitCodeLabel')}</label>
          <input class="input" id="totp-code" type="text" inputmode="numeric" maxlength="6" style="max-width:160px">
        </div>
        <div class="error-text" id="totp-error"></div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-primary" id="totp-confirm">${t('userSettings.confirmEnableButton')}</button>
          <button class="btn btn-ghost" id="totp-cancel">${t('common.cancel')}</button>
        </div>`;
      host.querySelector('#totp-cancel').addEventListener('click', () => { totpStep = 'idle'; totpSetupData = null; render(); });
      host.querySelector('#totp-confirm').addEventListener('click', async () => {
        const code = host.querySelector('#totp-code').value.trim();
        try {
          const res = await api.enable2fa(code);
          totpStep = 'recovery';
          totpRecoveryCodes = res.recoveryCodes;
          state.me.totpEnabled = true;
          bus.emit('state:me');
          render();
        } catch (err) { host.querySelector('#totp-error').textContent = apiErrorMessage(err, t('userSettings.invalidCode')); }
      });
      return;
    }

    if (state.me.totpEnabled) {
      host.innerHTML = `
        <p style="color:var(--text-secondary);font-size:14px">${t('userSettings.totpEnabledInfo')}</p>
        <div class="field">
          <label for="totp-disable-code">${t('userSettings.enterCodeToDisableLabel')}</label>
          <input class="input" id="totp-disable-code" type="text" inputmode="numeric" maxlength="6" style="max-width:160px">
        </div>
        <div class="error-text" id="totp-error"></div>
        <button class="btn btn-danger" id="totp-disable">${t('userSettings.disable2faButton')}</button>`;
      host.querySelector('#totp-disable').addEventListener('click', async () => {
        const code = host.querySelector('#totp-disable-code').value.trim();
        try {
          await api.disable2fa(code);
          state.me.totpEnabled = false;
          bus.emit('state:me');
          toast(t('userSettings.totpDisabledToast'));
          render();
        } catch (err) { host.querySelector('#totp-error').textContent = apiErrorMessage(err, t('userSettings.invalidCode')); }
      });
      return;
    }

    host.innerHTML = `
      <p style="color:var(--text-secondary);font-size:14px">
        ${t('userSettings.totpRequireInfo')}
      </p>
      <button class="btn btn-primary" id="totp-start">${t('userSettings.enable2faButton')}</button>`;
    host.querySelector('#totp-start').addEventListener('click', async () => {
      try {
        totpSetupData = await api.setup2fa();
        totpStep = 'setup';
        render();
      } catch (err) { toast(apiErrorMessage(err, t('userSettings.couldNotStart2fa')), { type: 'error' }); }
    });
  }

  async function doLogout() {
    try { await api.logout(); } catch { /* ignore */ }
    clearCachedIdentity();
    location.reload();
  }

  render();
  return { close };
}
