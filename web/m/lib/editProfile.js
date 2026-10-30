import { api } from '../../js/api.js';
import { bus } from '../../js/bus.js';
import { t } from '../../js/i18n.js';
import { escapeHtml, toast } from '../../js/utils.js';
import { state } from '../../js/state.js';
import { handleError } from './errors.js';
import { openSheet } from '../components/bottomSheet.js';

export function openEditProfile() {
  openSheet({
    title: t('m.profile'),
    html: `<label class="m-field">${t('m.displayName')}<input class="m-input" id="p-name" maxlength="32" value="${escapeHtml(state.me.displayName)}"></label>
      <label class="m-field">${t('m.bio')}<textarea class="m-input" id="p-bio" rows="3" maxlength="190">${escapeHtml(state.me.bio || '')}</textarea></label>
      <input type="file" id="p-avatar" accept="image/*" hidden>
      <div class="m-confirm-row"><button class="btn btn-secondary" id="p-pick">${t('m.attachPhoto')}</button><button class="btn btn-primary" id="p-save">${t('m.save')}</button></div>`,
    onMount: (body, close) => {
      body.querySelector('#p-pick').addEventListener('click', () => body.querySelector('#p-avatar').click());
      body.querySelector('#p-avatar').addEventListener('change', async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        try { const res = await api.uploadAvatar(f); Object.assign(state.me, res.user); bus.emit('state:me'); } catch (err) { handleError(err); }
      });
      body.querySelector('#p-save').addEventListener('click', async () => {
        try {
          const res = await api.updateMe({ displayName: body.querySelector('#p-name').value.trim(), bio: body.querySelector('#p-bio').value });
          Object.assign(state.me, res.user); bus.emit('state:me'); toast(t('m.profileSaved')); close();
        } catch (err) { handleError(err); }
      });
    },
  });
}
