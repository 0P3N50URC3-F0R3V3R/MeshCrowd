import { api } from '../../js/api.js';
import { bus } from '../../js/bus.js';
import { t } from '../../js/i18n.js';
import { renderBio } from '../../js/bioMarkup.mjs';
import { bioToolbarHtml, wireBioToolbar } from '../../js/bioEditor.js';
import { nameColorPickerHtml, wireNameColorPicker, readNameColor, readNameEffect, readNameFx } from '../../js/nameColorPicker.js';
import { escapeHtml, toast, avatarHtml, colorForId, BIO_MAX } from '../../js/utils.js';
import { state } from '../../js/state.js';
import { handleError } from './errors.js';
import { cropImage } from '../../js/cropEditor.js';
import { openSheet } from '../components/bottomSheet.js';

export function openEditProfile() {
  openSheet({
    title: t('m.profile'),
    html: `<label class="m-field">${t('m.displayName')}<input class="m-input" id="p-name" maxlength="32" value="${escapeHtml(state.me.displayName)}"></label>
      <div class="m-field"><span>${t('userSettings.nameColorLabel')}</span>${nameColorPickerHtml(state.me.nameColor, state.me.nameEffect, state.me.nameFx)}</div>
      <label class="m-field"><span style="display:flex;justify-content:space-between">${t('m.bio')}<small id="p-bio-count"></small></span>${bioToolbarHtml()}<textarea class="m-input" id="p-bio" rows="3" maxlength="${BIO_MAX}">${escapeHtml(state.me.bio || '')}</textarea></label>
      <div class="pp-bio" id="p-bio-prev" style="margin-bottom:8px"></div>
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px"><span id="p-av-prev">${avatarHtml(state.me, 56)}</span>
        <label class="m-check" id="p-bg-row" ${state.me.avatarPath ? '' : 'hidden'}><input type="checkbox" id="p-bg" ${state.me.avatarBackground ? 'checked' : ''}> ${t('m.avatarBackground')}</label>
        <input type="color" id="p-bg-color" value="${escapeHtml(state.me.avatarBgColor || colorForId(state.me.id))}" ${state.me.avatarPath && state.me.avatarBackground ? '' : 'hidden'} title="${t('userSettings.avatarBackgroundColor')}"></div>
      <input type="file" id="p-avatar" accept="image/*" hidden>
      <div class="m-confirm-row"><button class="btn btn-secondary" id="p-pick">${t('m.attachPhoto')}</button><button class="btn btn-primary" id="p-save">${t('m.save')}</button></div>
      <div class="m-confirm-row"><button class="btn btn-secondary" id="p-stranger">${t('profile.viewAsStrangerMenuItem')}</button></div>`,
    onMount: (body, close) => {
      const bioBox = body.querySelector('#p-bio'); const bioCount = body.querySelector('#p-bio-count');
      const bioPrev = body.querySelector('#p-bio-prev');
      const paintBioCount = () => { bioCount.textContent = `${[...bioBox.value].length}/${BIO_MAX}`; bioPrev.innerHTML = renderBio(bioBox.value); };
      paintBioCount(); bioBox.addEventListener('input', paintBioCount);
      wireBioToolbar(body.querySelector('.bio-toolbar'), bioBox, paintBioCount);
      wireNameColorPicker(body);
      const bgBox = body.querySelector('#p-bg');
      const colorBox = body.querySelector('#p-bg-color');
      let colorTouched = false;
      const refreshPreview = () => {
        body.querySelector('#p-av-prev').innerHTML = avatarHtml({ ...state.me, avatarBackground: bgBox.checked, avatarBgColor: colorBox.value }, 56);
        body.querySelector('#p-bg-row').hidden = !state.me.avatarPath;
        colorBox.hidden = !state.me.avatarPath || !bgBox.checked;
      };
      bgBox.addEventListener('change', refreshPreview);
      colorBox.addEventListener('input', () => { colorTouched = true; refreshPreview(); });
      body.querySelector('#p-pick').addEventListener('click', () => body.querySelector('#p-avatar').click());
      body.querySelector('#p-avatar').addEventListener('change', async (e) => {
        const picked = e.target.files[0];
        e.target.value = '';
        if (!picked) return;
        try { const f = await cropImage(picked, 'avatar', { user: state.me }); if (!f) return; const res = await api.uploadAvatar(f); Object.assign(state.me, res.user); bus.emit('state:me'); bgBox.checked = !!state.me.avatarBackground; refreshPreview(); } catch (err) { handleError(err); }
      });
      body.querySelector('#p-stranger').addEventListener('click', async () => {
        close();
        const { openProfileSheet } = await import('../views/profileSheet.js');
        openProfileSheet(state.me.id, { asStranger: true });
      });
      body.querySelector('#p-save').addEventListener('click', async () => {
        try {
          const res = await api.updateMe({ displayName: body.querySelector('#p-name').value.trim(), nameColor: readNameColor(body), nameEffect: readNameEffect(body), nameFx: readNameFx(body), bio: body.querySelector('#p-bio').value, avatarBackground: bgBox.checked, ...(colorTouched ? { avatarBgColor: colorBox.value } : {}) });
          Object.assign(state.me, res.user); bus.emit('state:me'); toast(t('m.profileSaved')); close();
        } catch (err) { handleError(err); }
      });
    },
  });
}
