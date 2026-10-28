import { icons } from '../../js/icons.js';
import { t } from '../../js/i18n.js';
import { escapeHtml } from '../../js/utils.js';
import { state } from '../../js/state.js';
import { PERMISSIONS, has, memberPermissionBits, channelPermissionBits } from '../../js/permissions.js';
import { mountNotes } from '../../js/views/notes.js';
import { mountSite } from '../../js/views/site.js';
import { nav } from '../router.js';
import { ensureServerDetail } from '../data.js';
import { handleError } from '../lib/errors.js';

// Notes channels and Sites already work in a narrow container, so the phone UI hosts the shared
// desktop mounts inside its own screen chrome instead of re-implementing the encryption and the
// iframe plumbing.
function screen(el, title) {
  el.innerHTML = `<div class="m-header"><button class="m-icon-btn" id="m-back" aria-label="${t('m.back')}">${icons.arrowLeft(22)}</button>
    <h1>${escapeHtml(title || '')}</h1></div><div class="m-hosted" id="m-host"></div>`;
  el.querySelector('#m-back').addEventListener('click', () => nav.back());
  return el.querySelector('#m-host');
}

export function mountNotesScreen(el, params) {
  const host = screen(el, '');
  let handle = null;
  let destroyed = false;
  (async () => {
    try {
      const detail = await ensureServerDetail(params.serverId);
      const channel = detail.channels.find((c) => c.id === params.channelId);
      if (destroyed || !channel) return;
      el.querySelector('h1').textContent = channel.name;
      const isOwner = detail.server.owner_id === state.me.id;
      const me = detail.members.find((m) => m.user.id === state.me.id);
      const bits = channelPermissionBits(channel, detail.roles, me, memberPermissionBits(detail.server, detail.roles, me, state.me.id), isOwner);
      handle = mountNotes(host, {
        serverId: params.serverId, channelId: params.channelId, channelName: channel.name,
        canTrim: has(bits, PERMISSIONS.MANAGE_CHANNELS) || has(bits, PERMISSIONS.PRUNE_CONTENT),
      });
    } catch (err) { handleError(err, 'm.loadFailed'); }
  })();
  return { destroy: () => { destroyed = true; handle?.destroy?.(); } };
}

export function mountSiteScreen(el, params) {
  const host = screen(el, '');
  let handle = null;
  (async () => {
    try {
      const detail = await ensureServerDetail(params.serverId);
      el.querySelector('h1').textContent = detail.server.name;
      handle = mountSite(host, { server: detail.server });
    } catch (err) { handleError(err, 'm.loadFailed'); }
  })();
  return { destroy: () => handle?.destroy?.() };
}
