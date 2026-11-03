import { bus } from './bus.js';
import { api } from './api.js';
import {
  state, setServers, setDms, setFriends, setNotificationPrefs, setServerPrefs, setUserAnnotations, setDmPrefs,
  setBookmarkIds, setReadStateBulk, setServerLayout,
} from './state.js';
import { applyTheme } from './theme.js';
import { toast } from './utils.js';
import { t } from './i18n.js';

const READERS = {
  theme: async () => applyTheme((await api.getTheme()).theme),
  ui_prefs: async () => {
    const { uiPrefs } = await api.getUiPrefs();
    state.uiPrefs = uiPrefs;
    const root = document.documentElement.style;
    if (uiPrefs.sidebarWidth) root.setProperty('--sidebar-width', `${uiPrefs.sidebarWidth}px`);
    if (uiPrefs.membersWidth) root.setProperty('--members-width', `${uiPrefs.membersWidth}px`);
    bus.emit('state:uiPrefs');
  },
  layout: async () => setServerLayout((await api.getServerLayout()).layout),
  annotations: async () => setUserAnnotations((await api.getUserAnnotations()).annotations),
  dm_prefs: async () => setDmPrefs((await api.getDmPrefs()).prefs),
  bookmarks: async () => setBookmarkIds((await api.getBookmarkIds()).ids),
  notification_prefs: async () => setNotificationPrefs((await api.getNotificationPrefs()).prefs),
  server_prefs: async () => setServerPrefs((await api.getServerPrefs()).prefs),
  friends: async () => setFriends(await api.friends()),
  language: async () => { toast(t('userSync.languageChanged'), { ttl: 8000 }); },
};

// Re-reads one stored setting (or everything) and applies it in place. Nothing re-renders the page: each
// setter updates state and the views that subscribe to it redraw only their own part, so scroll
// position, drafts and open panels stay as they are.
export async function applyUserSync(what, { refreshServerDetail } = {}) {
  if (what !== 'all') { await READERS[what]?.(); return; }
  const [servers, dms, readState] = await Promise.all([api.listServers(), api.listDms(), api.getReadState()]);
  setServers(servers.servers);
  setDms(dms.dms);
  setReadStateBulk(readState.state, readState.pinsUnseen, readState.threadsUnread);
  await Promise.all(Object.entries(READERS).filter(([k]) => k !== 'language').map(([, fn]) => fn().catch(() => {})));
  if (refreshServerDetail) for (const id of [...state.serverDetail.keys()]) refreshServerDetail(id);
}

const MIN_FOCUS_GAP_MS = 60_000;

// Listens for `user_sync` pushes (another device changed something) and, as a safety net for missed events,
// quietly re-syncs when the window comes back to the foreground after a while.
export function wireUserSync(opts = {}) {
  const timers = new Map();
  bus.on('ws:user_sync', ({ what }) => {
    clearTimeout(timers.get(what));
    timers.set(what, setTimeout(() => { applyUserSync(what, opts).catch(() => {}); }, 300));
  });
  let lastSync = Date.now();
  bus.on('state:connection', () => { lastSync = Date.now(); });
  const onVisible = () => {
    if (document.hidden || Date.now() - lastSync < MIN_FOCUS_GAP_MS) return;
    lastSync = Date.now();
    applyUserSync('all', opts).catch(() => {});
  };
  // Events pushed while this device was offline are gone for good, so a reconnect re-reads everything.
  let wasClosed = false;
  bus.on('ws:close', () => { wasClosed = true; });
  bus.on('ws:open', () => {
    if (!wasClosed) return;
    wasClosed = false;
    lastSync = Date.now();
    applyUserSync('all', opts).catch(() => {});
  });
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', onVisible);
}
