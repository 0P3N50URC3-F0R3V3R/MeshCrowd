import { api } from '../../js/api.js';
import { bus } from '../../js/bus.js';
import { t } from '../../js/i18n.js';
import { escapeHtml, toast, avatarHtml } from '../../js/utils.js';
import { state } from '../../js/state.js';
import { handleError } from './errors.js';
import { cropImage } from '../../js/cropEditor.js';
import { openSheet } from '../components/bottomSheet.js';

export function openEditProfile() {
  openSheet({
    title: t('m.profile'),
    html: `<label class="m-field">${t('m.displayName')}<input class="m-input" id="p-name" maxlength="32" value="${escapeHtml(state.me.displayName)}"></label>
      <label class="m-field">${t('m.bio')}<textarea class="m-input" id="p-bio" rows="3" maxlength="190">${escapeHtml(state.me.bio || '')}</textarea></label>
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px"><span id="p-av-prev">${avatarHtml(state.me, 56)}</span>
        <label class="m-check" id="p-bg-row" ${state.me.avatarPath ? '' : 'hidden'}><input type="checkbox" id="p-bg" ${state.me.avatarBackground ? 'checked' : ''}> ${t('m.avatarBackground')}</label></div>
      <input type="file" id="p-avatar" accept="image/*" hidden>
      <div class="m-confirm-row"><button class="btn btn-secondary" id="p-pick">${t('m.attachPhoto')}</button><button class="btn btn-primary" id="p-save">${t('m.save')}</button></div>`,
    onMount: (body, close) => {
      const bgBox = body.querySelector('#p-bg');
      const refreshPreview = () => {
        body.querySelector('#p-av-prev').innerHTML = avatarHtml({ ...state.me, avatarBackground: bgBox.checked }, 56);
        body.querySelector('#p-bg-row').hidden = !state.me.avatarPath;
      };
      bgBox.addEventListener('change', refreshPreview);
      body.querySelector('#p-pick').addEventListener('click', () => body.querySelector('#p-avatar').click());
      body.querySelector('#p-avatar').addEventListener('change', async (e) => {
        const picked = e.target.files[0];
        e.target.value = '';
        if (!picked) return;
        try { const f = await cropImage(picked, 'avatar', { user: state.me }); if (!f) return; const res = await api.uploadAvatar(f); Object.assign(state.me, res.user); bus.emit('state:me'); bgBox.checked = !!state.me.avatarBackground; refreshPreview(); } catch (err) { handleError(err); }
      });
      body.querySelector('#p-save').addEventListener('click', async () => {
        try {
          const res = await api.updateMe({ displayName: body.querySelector('#p-name').value.trim(), bio: body.querySelector('#p-bio').value, avatarBackground: bgBox.checked });
          Object.assign(state.me, res.user); bus.emit('state:me'); toast(t('m.profileSaved')); close();
        } catch (err) { handleError(err); }
      });
    },
  });
}
