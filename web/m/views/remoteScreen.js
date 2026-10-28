import { bus } from '../../js/bus.js';
import { icons } from '../../js/icons.js';
import { t } from '../../js/i18n.js';
import { escapeHtml } from '../../js/utils.js';
import { state } from '../../js/state.js';
import { mountRemoteServer, getRemoteInfo } from '../../js/views/remoteServer.js';
import { nav } from '../router.js';

// A server owned by a paired instance. The desktop remote view renders a channel list plus a
// message column; on a phone the channel list becomes a panel opened from the header.
export function mountRemoteScreen(el, params) {
  const { peerId, serverId } = params;
  const entry = state.remoteServers.find((s) => s.peerId === peerId && s.serverId === serverId);
  el.innerHTML = `<div class="m-header"><button class="m-icon-btn" id="m-back" aria-label="${t('m.back')}">${icons.arrowLeft(22)}</button>
    <h1>${escapeHtml(entry?.name || t('remote.serverFallback'))}</h1>
    <button class="m-icon-btn" id="m-chans" aria-label="${t('remote.channelsLabel')}">${icons.menu(22)}</button></div>
    <div class="m-remote"><div class="m-remote-side" id="r-side" hidden></div><div class="m-remote-main" id="r-main"></div></div>`;
  const side = el.querySelector('#r-side');
  const main = el.querySelector('#r-main');
  let handle = null;
  let view = { type: 'remote', peerId, serverId };

  function start(v) {
    handle?.destroy?.();
    view = v;
    handle = mountRemoteServer({ sidebarEl: side, mainEl: main }, v);
  }
  el.querySelector('#m-back').addEventListener('click', () => nav.back());
  el.querySelector('#m-chans').addEventListener('click', () => { side.hidden = !side.hidden; });

  const off = bus.on('ui:navigate', (v) => {
    if (v.type === 'remote' && v.peerId === peerId && v.serverId === serverId) { side.hidden = true; start(v); }
    else if (v.type === 'home') nav.back();
  });
  const offInfo = bus.on('remote:info', () => {
    const info = getRemoteInfo(peerId, serverId);
    if (info) el.querySelector('h1').textContent = info.server.name;
  });
  start(view);
  return { destroy: () => { off(); offInfo(); handle?.destroy?.(); } };
}
