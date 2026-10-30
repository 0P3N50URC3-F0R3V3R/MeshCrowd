import { bus } from '../../js/bus.js';
import { icons } from '../../js/icons.js';
import { t } from '../../js/i18n.js';
import { state, isUnread, isChannelMuted } from '../../js/state.js';
import { getPref } from '../lib/prefs.js';
import { mountServersTab } from './serversTab.js';
import { mountMessagesTab } from './messagesTab.js';
import { mountNotificationsTab } from './notificationsTab.js';
import { mountYouTab } from './youTab.js';

const TABS = [
  { id: 'servers', icon: 'home', label: 'm.tabServers', mount: mountServersTab },
  { id: 'messages', icon: 'messageSquare', label: 'm.tabMessages', mount: mountMessagesTab },
  { id: 'notifications', icon: 'bell', label: 'm.tabNotifications', mount: mountNotificationsTab },
  { id: 'you', icon: 'user', label: 'm.tabYou', mount: mountYouTab },
];

let seenActivity = 0;

function badgeFor(id) {
  if (id === 'messages') {
    const dms = state.dms.filter((d) => isUnread('dm', d.id, d.lastMessage?.id)).length;
    return dms + state.friends.pending.filter((f) => f.direction === 'incoming').length;
  }
  if (id === 'servers') {
    let n = 0;
    for (const d of state.serverDetail.values()) for (const c of d.channels) if (isUnread('channel', c.id, c.last_message_id) && !isChannelMuted(d.server.id, c.id)) n++;
    return n;
  }
  if (id === 'notifications') return Math.max(0, state.activityFeed.length - seenActivity);
  return 0;
}

export function mountTabs(el) {
  const startPref = getPref('startView', 'messages');
  let active = TABS.some((x) => x.id === startPref) ? startPref : 'messages';
  let inner = null;
  el.innerHTML = '<div class="m-tab-body" id="m-tab-body"></div><nav class="m-tabbar" id="m-tabbar"></nav>';
  const body = el.querySelector('#m-tab-body');
  const bar = el.querySelector('#m-tabbar');

  function paintBar() {
    bar.innerHTML = TABS.map((tab) => {
      const n = badgeFor(tab.id);
      return `<button class="m-tab${tab.id === active ? ' active' : ''}" data-tab="${tab.id}">
        <span class="m-tab-icon">${icons[tab.icon](22)}${n ? `<i class="m-badge">${n > 99 ? '99+' : n}</i>` : ''}</span>
        <span class="m-tab-label">${t(tab.label)}</span></button>`;
    }).join('');
  }
  function show(id) {
    inner?.destroy?.();
    active = id;
    if (id === 'notifications') seenActivity = state.activityFeed.length;
    body.innerHTML = '';
    inner = TABS.find((x) => x.id === id).mount(body) || {};
    paintBar();
  }
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b && b.dataset.tab !== active) show(b.dataset.tab);
  });
  const offs = ['state:dms', 'state:readState', 'state:friends', 'state:serverDetail', 'state:activity'].map((ev) => bus.on(ev, paintBar));
  show(active);
  window.__mcShowTab = (id) => { if (id !== active && TABS.some((x) => x.id === id)) show(id); };
  window.__mcTabBack = () => {
    if (active === 'servers') return false;
    show('servers');
    return true;
  };
  return { destroy: () => { delete window.__mcTabBack; delete window.__mcShowTab; offs.forEach((off) => off()); inner?.destroy?.(); }, onShow: paintBar };
}
