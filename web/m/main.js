import { api } from '../js/api.js';
import { bus } from '../js/bus.js';
import { setMe, state, setServers } from '../js/state.js';
import { initI18n, applyStaticI18n, t } from '../js/i18n.js';
import '../js/animatedImages.js';
import { renderAuth } from '../js/views/auth.js';
import { loadAll, wireRealtime } from './data.js';
import { initRouter, nav } from './router.js';
import { parseDeepLink } from './lib/deepLink.mjs';
import { parseInviteHash } from '../js/inviteHash.mjs';
import { peekInvite, redeemInviteCode } from '../js/inviteLink.js';
import { confirmSheet } from './components/bottomSheet.js';
import { toast } from '../js/utils.js';
import { installKeyboardSupport } from './lib/keyboard.js';
import { mountCallBar } from './components/callBar.js';
import { initCallSession } from './lib/callSession.js';
import { getPref } from './lib/prefs.js';
import { installReauthGate } from './lib/reauth.js';
import './views/index.js';

const root = document.getElementById('app');

async function boot() {
  installKeyboardSupport();
  installReauthGate();
  let user;
  try {
    ({ user } = await api.me());
    await initI18n(user);
  } catch {
    await initI18n(null);
    applyStaticI18n();
    user = await renderAuth(root);
  }
  applyStaticI18n();
  setMe(user);
  await loadAll();
  root.innerHTML = '<div id="m-conn" class="m-conn hidden"></div><div id="m-callbar" class="m-callbar" hidden></div><div id="m-host" class="m-host"></div>';
  document.getElementById('m-conn').textContent = t('m.offline');
  wireRealtime();
  initRouter(document.getElementById('m-host'));
  initCallSession();
  mountCallBar(document.getElementById('m-callbar'));
  const openInvite = async (code) => {
    history.replaceState(history.state, '', location.pathname + location.search);
    try {
      const info = await peekInvite(code);
      const text = info ? t('invites.joinConfirmTitle', { name: info.name }) : t('invites.joinConfirmTitleGeneric');
      if (!(await confirmSheet(text, { danger: false, okLabel: t('serverRail.joinButton') }))) return;
      const { kind, res } = await redeemInviteCode(code);
      setServers((await api.listServers()).servers);
      if (kind === 'channel') nav.push('chat', { kind: 'channel', serverId: res.server.id, channelId: res.channelId });
    } catch { toast(t('serverRail.invalidInviteCode'), { type: 'error' }); }
  };
  const openLink = () => {
    const inviteCode = parseInviteHash(location.hash);
    if (inviteCode) { openInvite(inviteCode); return; }
    const target = parseDeepLink(location.hash);
    if (!target) return;
    history.replaceState(history.state, '', location.pathname + location.search);
    nav.push('chat', target);
  };
  window.addEventListener('hashchange', openLink);
  openLink();
  if (!parseDeepLink(location.hash) && getPref('startView', 'messages') === 'last') {
    try {
      const last = JSON.parse(getPref('lastChat', 'null'));
      if (last && (last.kind !== 'dm' || state.dms.some((d) => d.id === last.dmId))) nav.push('chat', last);
    } catch { /* stale value */ }
  }
}

let reloading = false;
bus.on('m:unauthorized', () => { if (!reloading) { reloading = true; location.reload(); } });

boot();
