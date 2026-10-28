import { bus } from '../bus.js';
import { state } from '../state.js';
import { icons } from '../icons.js';
import { escapeHtml } from '../utils.js';
import { t } from '../i18n.js';
import { leaveActiveCall } from './voice.js';

// Strip above the user bar while a call is live, so the user can read other channels and still see
// (and get back to / leave) the call they're in.
export function mountCallBar(container) {
  render();
  bus.on('state:voice', render);

  function render() {
    const { channelId, channelName, dmId, dmName, serverId } = state.voice;
    const inCall = !!(channelId || dmId);
    container.hidden = !inCall;
    if (!inCall) { container.innerHTML = ''; return; }
    const name = dmId ? dmName : channelName;
    container.innerHTML = `
      <button class="call-bar-info" id="cb-return" title="${t('voice.callBarReturnTitle')}">
        <span class="call-bar-status">${icons.headphones(14)} ${t('voice.callBarTitle')}</span>
        <span class="call-bar-name">${escapeHtml(name || '')}</span>
      </button>
      <button class="btn-icon active-danger" id="cb-leave" title="${t('voice.callBarLeaveTitle')}">${icons.phoneOff(18)}</button>`;
    container.querySelector('#cb-return').addEventListener('click', () => {
      bus.emit('ui:navigate', dmId ? { type: 'dm', dmId } : { type: 'server', serverId, channelId });
    });
    container.querySelector('#cb-leave').addEventListener('click', leaveActiveCall);
  }
}
