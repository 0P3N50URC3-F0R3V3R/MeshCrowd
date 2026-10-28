import { bus } from '../bus.js';
import { api } from '../api.js';
import { state, setVoiceState } from '../state.js';
import { icons } from '../icons.js';
import { avatarHtml, escapeHtml, toast, apiErrorMessage } from '../utils.js';
import { openContextMenu, openModal } from './modal.js';
import { openUserSettings } from './userSettings.js';
import { statusEmojiFieldHtml, bindStatusEmojiField } from './statusEmojiField.js';
import { t } from '../i18n.js';

// A function (not a module-level constant) because it's built from t(), which must be
// re-evaluated after the active language resolves — a plain top-level array would freeze in
// whatever language was active (usually none yet) at module-import time.
function statusOptions() {
  return [
    { value: 'online', label: t('common.statusOnline'), color: 'var(--green)' },
    { value: 'idle', label: t('common.statusIdle'), color: 'var(--yellow)' },
    { value: 'dnd', label: t('common.statusDnd'), color: 'var(--red)' },
    { value: 'invisible', label: t('common.statusInvisible'), color: 'var(--grey-status)' },
  ];
}

export function mountUserBar(container) {
  render();
  const off = bus.on('state:me', render);
  // Mute/deafen are a standing preference, not tied to actually being in a call right now (same
  // as Discord's own bottom bar) — these buttons work whether or not voice.js is even mounted.
  const offVoice = bus.on('state:voice', render);

  function render() {
    const me = state.me;
    if (!me) { container.innerHTML = ''; return; }
    const { muted, deafened } = state.voice;
    container.innerHTML = `
      <div class="self-avatar" id="ub-avatar">
        ${avatarHtml(me, 32)}
        <div class="status-dot ${me.status}" style="width:10px;height:10px"></div>
      </div>
      <div class="self-info" id="ub-info">
        <div class="name">${escapeHtml(me.displayName)}</div>
        <div class="status-text">${me.customStatusText ? escapeHtml(me.customStatusText) : (statusOptions().find((s) => s.value === me.status)?.label || t('common.statusOnline'))}</div>
      </div>
      <div class="actions">
        <button class="btn-icon ${muted ? 'active-danger' : ''}" id="ub-mute" title="${muted ? t('userBar.unmute') : t('userBar.mute')}">${muted ? icons.micOff(18) : icons.mic(18)}</button>
        <button class="btn-icon ${deafened ? 'active-danger' : ''}" id="ub-deafen" title="${deafened ? t('userBar.undeafen') : t('userBar.deafen')}">${deafened ? icons.headphonesOff(18) : icons.headphones(18)}</button>
        <button class="btn-icon" id="ub-settings" title="${t('userBar.userSettings')}">${icons.gear(18)}</button>
      </div>`;

    container.querySelector('#ub-avatar').addEventListener('click', (e) => openStatusMenu(e.currentTarget));
    container.querySelector('#ub-info').addEventListener('click', () => openUserSettings());
    container.querySelector('#ub-settings').addEventListener('click', () => openUserSettings());
    container.querySelector('#ub-mute').addEventListener('click', () => {
      setVoiceState({ muted: !state.voice.muted });
    });
    container.querySelector('#ub-deafen').addEventListener('click', () => {
      const deafening = !state.voice.deafened;
      setVoiceState({ deafened: deafening, muted: deafening ? true : state.voice.muted });
    });
  }

  function openStatusMenu(anchor) {
    const rect = anchor.getBoundingClientRect();
    const items = statusOptions().map((opt) => ({
      label: opt.label,
      icon: () => `<span class="dot-lg" style="width:10px;height:10px;border-radius:50%;background:${opt.color};display:inline-block"></span>`,
      onClick: async () => {
        try {
          await api.setStatus({ status: opt.value });
          state.me.status = opt.value;
          bus.emit('state:me');
        } catch { /* toast handled globally if needed */ }
      },
    }));
    items.push('sep', { label: t('userBar.customStatusMenuItem'), icon: icons.smile, onClick: openCustomStatusModal });
    openContextMenu(rect.left, rect.top - 8 - (items.length - 1) * 40, items);
  }

  // Quick access to the same custom-status fields buried in full Settings — Discord puts this one
  // click from the avatar, not three menus deep.
  function openCustomStatusModal() {
    const me = state.me;
    const m = openModal({
      title: t('userBar.customStatusModalTitle'),
      render(body) {
        body.innerHTML = `
          <div class="field">
            <div style="display:flex;gap:8px;align-items:center">
              ${statusEmojiFieldHtml('cs-emoji', me.customStatusEmoji)}
              <input class="input" id="cs-text" placeholder="${t('userBar.customStatusTextPlaceholder')}" maxlength="128" value="${escapeHtml(me.customStatusText || '')}">
            </div>
            <div class="hint" style="margin-top:8px">${t('userBar.quickPicks')} ${['🎮', '💻', '🎧', '☕', '😴', '🚀'].map((e) => `<button type="button" class="quick-emoji" data-e="${e}" style="font-size:18px;margin-right:6px">${e}</button>`).join('')}</div>
          </div>
          <div class="field">
            <label>${t('userBar.notificationSoundLabel')}</label>
            <select class="input" id="cs-sound-mode">
              <option value="auto" ${(me.notifySoundMode || 'auto') === 'auto' ? 'selected' : ''}>${t('userBar.soundAuto')}</option>
              <option value="always" ${me.notifySoundMode === 'always' ? 'selected' : ''}>${t('userBar.soundAlways')}</option>
              <option value="never" ${me.notifySoundMode === 'never' ? 'selected' : ''}>${t('userBar.soundNever')}</option>
            </select>
          </div>`;
        const setStatusEmoji = bindStatusEmojiField(body, 'cs-emoji');
        body.querySelectorAll('.quick-emoji').forEach((b) => b.addEventListener('click', () => setStatusEmoji(b.dataset.e)));
      },
      footer: `<button class="btn btn-primary" id="cs-save">${t('common.save')}</button>`,
    });
    m.overlay.querySelector('#cs-save').addEventListener('click', async () => {
      const customStatusEmoji = m.overlay.querySelector('#cs-emoji').value.trim();
      const customStatusText = m.overlay.querySelector('#cs-text').value.trim();
      const notifySoundMode = m.overlay.querySelector('#cs-sound-mode').value;
      try {
        await api.setStatus({ customStatusEmoji, customStatusText, notifySoundMode });
        Object.assign(state.me, { customStatusEmoji, customStatusText, notifySoundMode });
        bus.emit('state:me');
        toast(t('userBar.statusUpdated'));
        m.close();
      } catch (err) { toast(apiErrorMessage(err), { type: 'error' }); }
    });
  }

  function destroy() { off(); offVoice(); }
  return { destroy };
}
