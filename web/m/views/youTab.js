import { api } from '../../js/api.js';
import { bus } from '../../js/bus.js';
import { icons } from '../../js/icons.js';
import { t, currentLanguage } from '../../js/i18n.js';
import { escapeHtml, avatarHtml, toast } from '../../js/utils.js';
import { state } from '../../js/state.js';
import { handleError } from '../lib/errors.js';
import { openEditProfile } from '../lib/editProfile.js';
import { androidBridge } from '../lib/androidBridge.js';
import { getPref, setPref } from '../lib/prefs.js';
import { actionSheet, openSheet } from '../components/bottomSheet.js';
import { openUserSettings } from '../../js/views/userSettings.js';
import { openBookmarksModal } from '../../js/views/bookmarks.js';
import { openAdminPanel } from '../../js/views/admin.js';
import { openScheduleModal } from '../../js/views/scheduled.js';

const STATUSES = [['online', 'm.statusOnline'], ['idle', 'm.statusIdle'], ['dnd', 'm.statusDnd'], ['invisible', 'm.statusInvisible']];
const START_VIEWS = [['servers', 'm.tabServers'], ['messages', 'm.tabMessages'], ['notifications', 'm.tabNotifications'], ['you', 'm.tabYou'], ['last', 'm.startViewLast']];
const SOUNDS = { auto: 'm.soundAuto', always: 'm.soundAlways', never: 'm.soundNever' };

export function mountYouTab(host) {
  const bridge = androidBridge();
  function paint() {
    const me = state.me;
    const row = (id, icon, label, sub = '') => `<button class="m-row m-menu" data-id="${id}"><span class="m-sheet-icon">${icon}</span>
      <span class="m-grow"><b>${label}</b>${sub ? `<small>${escapeHtml(sub)}</small>` : ''}</span>${icons.chevronRight(18)}</button>`;
    host.innerHTML = `<div class="m-scroll">
      <div class="m-you-banner">${avatarHtml(me, 72)}<div class="m-you-name">${escapeHtml(me.displayName)}</div><div class="m-you-user">@${escapeHtml(me.username)}</div></div>
      ${row('status', icons.smile(20), t('m.setStatus'), t(STATUSES.find(([v]) => v === me.status)?.[1] || 'm.statusOnline'))}
      ${row('profile', icons.user(20), t('m.profile'))}
      ${row('tab:account', icons.gear(20), t('userSettings.myAccountTab'))}
      ${row('tab:appearance', icons.palette ? icons.palette(20) : icons.gear(20), t('userSettings.appearanceTab'))}
      ${row('tab:voice', icons.mic(20), t('userSettings.voiceVideoTab'))}
      ${row('tab:privacy', icons.shield(20), t('userSettings.privacySafetyTab'))}
      ${row('tab:passport', icons.lock(20), t('passport.tab'))}
      ${row('saved', icons.bookmark(20), t('bookmarks.title'))}
      ${row('scheduled', icons.clock ? icons.clock(20) : icons.bell(20), t('scheduled.listTitle'))}
      ${me.isSiteAdmin ? row('admin', icons.shield(20), t('userSettings.adminPanelNav')) : ''}
      ${row('startView', icons.home(20), t('m.startView'), t(START_VIEWS.find(([v]) => v === getPref('startView', 'messages'))?.[1] || 'm.tabMessages'))}
      ${bridge ? row('chatStyle', icons.messageSquare(20), t('m.chatStyle'), t(getPref('chatStyle', 'plain') === 'bubbles' ? 'm.chatStyleBubbles' : 'm.chatStylePlain')) : ''}
      ${row('sound', icons.bell(20), t('m.notificationSound'), t(SOUNDS[me.notifySoundMode || 'auto']))}
      ${row('language', icons.menu(20), t('m.language'), currentLanguage())}
      ${bridge ? row('android', icons.bell(20), t('m.androidSection')) : ''}
      ${row('desktop', icons.link(20), t('m.openDesktop'))}
      ${row('logout', icons.x(20), t('m.logout'))}
    </div>`;
  }

  async function onRow(id) {
    try {
      if (id === 'status') {
        const v = await actionSheet({ title: t('m.setStatus'), items: STATUSES.map(([value, key]) => ({ id: value, label: t(key) })) });
        if (v) { await api.setStatus({ status: v }); state.me.status = v; bus.emit('state:me'); }
      } else if (id === 'sound') {
        const v = await actionSheet({ title: t('m.notificationSound'), items: Object.entries(SOUNDS).map(([value, key]) => ({ id: value, label: t(key) })) });
        if (v) { await api.setStatus({ notifySoundMode: v }); state.me.notifySoundMode = v; bus.emit('state:me'); }
      } else if (id === 'startView') {
        const v = await actionSheet({ title: t('m.startView'), items: START_VIEWS.map(([value, key]) => ({ id: value, label: t(key) })) });
        if (v) { setPref('startView', v); paint(); }
      } else if (id === 'chatStyle') {
        const v = await actionSheet({ title: t('m.chatStyle'), items: [{ id: 'plain', label: t('m.chatStylePlain') }, { id: 'bubbles', label: t('m.chatStyleBubbles') }] });
        if (v) { setPref('chatStyle', v); paint(); }
      } else if (id === 'language') {
        const { languages } = await api.getLanguages();
        const v = await actionSheet({ title: t('m.language'), items: languages.map((l) => ({ id: l.code, label: l.name })) });
        if (v && v !== currentLanguage()) { await api.setMyLanguage(v); location.reload(); }
      } else if (id === 'profile') openEditProfile();
      else if (id.startsWith('tab:')) openUserSettings(id.slice(4));
      else if (id === 'saved') openBookmarksModal();
      else if (id === 'scheduled') openScheduleModal({ scope: null });
      else if (id === 'admin') openAdminPanel();
      else if (id === 'android') androidSettings();
      else if (id === 'desktop') location.href = '/?ui=desktop';
      else if (id === 'logout') { try { await api.logout(); } finally { location.href = '/m/'; } }
    } catch (err) { handleError(err); }
  }

  function androidSettings() {
    const s = bridge.getSettings();
    openSheet({
      title: t('m.androidSection'),
      html: `<label class="m-field">${t('m.pollInterval')}<input class="m-input" id="a-min" type="number" inputmode="numeric" min="1" max="1440" value="${s.pollMinutes}"></label>
        <label class="m-check"><input type="checkbox" id="a-fast" ${s.fastMode ? 'checked' : ''}> ${t('m.fastMode')}</label>
        ${bridge.hasPushSupport ? `<div class="m-field" id="a-push-box"><b>${t('m.pushTitle')}</b>
          <small style="display:block;color:var(--text-muted)">${t('m.pushHint')}</small>
          <small id="a-push-status" style="display:block;margin:4px 0">${s.pushEnabled ? (s.pushRegistered ? t('m.pushOn') : t('m.pushWaiting')) : t('m.pushOff')}</small>
          <button class="btn btn-secondary btn-block" id="a-push">${s.pushEnabled ? t('m.pushDisable') : t('m.pushEnable')}</button></div>` : ''}
        <button class="btn btn-secondary btn-block" id="a-battery">${t('m.batterySettings')}</button>
        <button class="btn btn-secondary btn-block" id="a-server" style="margin-top:8px">${t('m.serverAddress')}${s.serverUrl ? ` (${escapeHtml(s.serverUrl)})` : ''}</button>
        <button class="btn btn-primary btn-block" id="a-save" style="margin-top:8px">${t('m.save')}</button>`,
      onMount: (body, close) => {
        body.querySelector('#a-push')?.addEventListener('click', async () => {
          if (bridge.getSettings().pushEnabled) { bridge.pushDisable(); close(); return; }
          const list = bridge.pushDistributors();
          if (!list.length) { toast(t('m.pushNoDistributor')); return; }
          let id = '';
          if (list.length > 1) {
            id = await actionSheet({ title: t('m.pushChoose'), items: list.map((d) => ({ id: d.id, label: d.label })) });
            if (!id) return;
          }
          if (bridge.pushEnable(id)) { toast(t('m.pushStarted')); close(); }
        });
        body.querySelector('#a-battery').addEventListener('click', () => bridge.openBatterySettings());
        body.querySelector('#a-server').addEventListener('click', () => bridge.changeServer());
        body.querySelector('#a-save').addEventListener('click', () => {
        bridge.setPollMinutes(Number(body.querySelector('#a-min').value) || 15);
        bridge.setFastMode(body.querySelector('#a-fast').checked);
        close();
        });
      },
    });
  }

  host.addEventListener('click', (e) => { const r = e.target.closest('[data-id]'); if (r) onRow(r.dataset.id); });
  const off = bus.on('state:me', paint);
  paint();
  return { destroy: off };
}
