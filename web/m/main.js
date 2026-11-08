import { api } from '../js/api.js';
import { bus } from '../js/bus.js';
import { setMe, state, setServers } from '../js/state.js';
import { initI18n, applyStaticI18n, t } from '../js/i18n.js';
import '../js/animatedImages.js';
import '../js/autoRefocus.js';
import { startAutoAway } from '../js/autoAway.js';
import { renderAuth } from '../js/views/auth.js';
import { loadAll, fetchAll, applyAll, wireRealtime } from './data.js';
import { readSnapshot, writeSnapshot, clearSnapshot } from './lib/stateCache.js';
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

function rememberServerName() {
  const name = (state.servers.find((s) => s.kind === 'site') || {}).name;
  if (!name) return;
  try { localStorage.setItem('mc_server_name', name); } catch { /* storage unavailable */ }
  try { window.MeshCrowdAndroid?.setServerName?.(name); } catch { /* not in the app */ }
}

function saveSnapshot(user, data) {
  if (user && data) writeSnapshot({ user, data, savedAt: Date.now() });
}

// After the cached screen is up: confirm the session and swap in fresh data. Going offline keeps the
// cached view; a dead session clears it and returns to sign-in.
async function revalidate(mePromise, dataPromise) {
  try {
    const { user } = await mePromise;
    setMe(user);
    const data = await dataPromise;
    applyAll(data);
    rememberServerName();
    saveSnapshot(user, data);
  } catch (err) {
    if (err && err.status === 401) bus.emit('m:unauthorized');
  }
}

async function boot() {
  installKeyboardSupport();
  installReauthGate();
  const snapshot = await readSnapshot();
  // Session check and the lists go out together; a signed-out visitor just gets two 401s that are ignored here.
  const mePromise = api.me();
  const dataPromise = fetchAll();
  mePromise.catch(() => {});
  dataPromise.catch(() => {});
  let user;
  let data = null;
  let revalidating = false;
  if (snapshot) {
    user = snapshot.user;
    await initI18n(user);
    applyStaticI18n();
    setMe(user);
    applyAll(snapshot.data);
    revalidating = true;
  } else {
    let signedIn = true;
    try {
      ({ user } = await mePromise);
      await initI18n(user);
    } catch {
      signedIn = false;
      await initI18n(null);
      applyStaticI18n();
      user = await renderAuth(root);
    }
    applyStaticI18n();
    setMe(user);
    data = await loadAll(signedIn ? dataPromise : undefined);
    saveSnapshot(user, data);
  }
  rememberServerName();
  root.innerHTML = '<div id="m-conn" class="m-conn hidden"></div><div id="m-callbar" class="m-callbar" hidden></div><div id="m-host" class="m-host"></div>';
  document.getElementById('m-conn').textContent = t('m.offline');
  wireRealtime();
  startAutoAway();
  initRouter(document.getElementById('m-host'));
  initCallSession();
  mountCallBar(document.getElementById('m-callbar'));
  const pushChat = (target) => {
    if (target.kind !== 'dm') window.__mcShowTab?.('servers');
    nav.push('chat', target);
  };
  const openInvite = async (code) => {
    history.replaceState(history.state, '', location.pathname + location.search);
    try {
      const info = await peekInvite(code);
      const text = info ? t('invites.joinConfirmTitle', { name: info.name }) : t('invites.joinConfirmTitleGeneric');
      if (!(await confirmSheet(text, { danger: false, okLabel: t('serverRail.joinButton') }))) return;
      const { kind, res } = await redeemInviteCode(code);
      setServers((await api.listServers()).servers);
      if (kind === 'channel') pushChat({ kind: 'channel', serverId: res.server.id, channelId: res.channelId });
    } catch { toast(t('serverRail.invalidInviteCode'), { type: 'error' }); }
  };
  const openLink = () => {
    const inviteCode = parseInviteHash(location.hash);
    if (inviteCode) { openInvite(inviteCode); return; }
    const target = parseDeepLink(location.hash);
    if (!target) return;
    history.replaceState(history.state, '', location.pathname + location.search);
    pushChat(target);
  };
  window.addEventListener('hashchange', openLink);
  openLink();
  if (!parseDeepLink(location.hash) && getPref('startView', 'messages') === 'last') {
    try {
      const last = JSON.parse(getPref('lastChat', 'null'));
      if (last && (last.kind !== 'dm' || state.dms.some((d) => d.id === last.dmId))) pushChat(last);
    } catch { /* stale value */ }
  }
  if (revalidating) revalidate(mePromise, dataPromise);
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', async () => {
    try {
      await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      const reg = await navigator.serviceWorker.ready;
      const urls = performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.startsWith(location.origin));
      reg.active?.postMessage({ precache: urls });
    } catch { /* no secure context, or the certificate is not accepted for workers */ }
  });
}

let reloading = false;
bus.on('m:unauthorized', async () => {
  if (reloading) return;
  reloading = true;
  await clearSnapshot();
  location.reload();
});

registerServiceWorker();
boot();
