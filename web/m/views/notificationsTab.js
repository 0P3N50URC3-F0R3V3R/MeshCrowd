import { bus } from '../../js/bus.js';
import { icons } from '../../js/icons.js';
import { t } from '../../js/i18n.js';
import { escapeHtml, formatShortTime } from '../../js/utils.js';
import { state } from '../../js/state.js';
import { nav } from '../router.js';

const ICON = { mention: 'atSign', dm: 'messageSquare', channel: 'hash' };

export function mountNotificationsTab(host) {
  host.innerHTML = `<div class="m-page-title">${t('m.notificationsTitle')}</div><div class="m-scroll" id="m-feed"></div>`;
  const feed = host.querySelector('#m-feed');
  function paint() {
    feed.innerHTML = state.activityFeed.length ? state.activityFeed.map((a) => `
      <button class="m-row m-notif" data-id="${a.id}"><span class="m-sheet-icon">${icons[ICON[a.kind] || 'bell'](20)}</span>
        <span class="m-grow"><b>${escapeHtml(a.title)}</b><small>${escapeHtml(a.body || '')}</small></span><small>${formatShortTime(a.createdAt)}</small></button>`).join('')
      : `<div class="m-empty">${t('m.notificationsEmpty')}</div>`;
  }
  feed.addEventListener('click', (e) => {
    const a = state.activityFeed.find((x) => x.id === e.target.closest('[data-id]')?.dataset.id);
    if (!a) return;
    if (a.scopeType === 'dm') nav.push('chat', { kind: 'dm', dmId: a.scopeId });
    else if (a.threadId) nav.push('chat', { kind: 'thread', serverId: a.serverId, channelId: a.scopeId, threadId: a.threadId, jumpToMessageId: a.messageId });
    else if (a.scopeType === 'channel') nav.push('chat', { kind: 'channel', serverId: a.serverId, channelId: a.scopeId, jumpToMessageId: a.messageId });
  });
  const off = bus.on('state:activity', paint);
  paint();
  return { destroy: off };
}
