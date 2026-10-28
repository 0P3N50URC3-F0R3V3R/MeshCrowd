import { bus } from '../../js/bus.js';
import { icons } from '../../js/icons.js';
import { t } from '../../js/i18n.js';
import { state, setVoiceState } from '../../js/state.js';
import { escapeHtml } from '../../js/utils.js';
import { nav } from '../router.js';
import { getSession, leaveSession } from '../lib/callSession.js';
import { callBarModel } from '../lib/callRoom.mjs';

// A strip above the tab bar / chat that shows while a call is running in the background.
export function mountCallBar(el) {
  function paint() {
    const s = getSession();
    const model = s && callBarModel({ key: s.key, voice: state.voice, screenVisible: s.visible, label: s.label });
    el.hidden = !model;
    if (!model) { el.innerHTML = ''; return; }
    el.innerHTML = `
      <button class="m-callbar-main" id="m-callbar-open" aria-label="${t('m.inCallTap')}">
        <span class="m-callbar-dot"></span><span class="m-callbar-text"><b>${t('m.inCall')}</b> ${escapeHtml(model.label)}</span>
      </button>
      <button class="m-icon-btn ${model.muted ? 'm-callbar-off' : ''}" id="m-callbar-mute" aria-label="${model.muted ? t('m.unmuteAction') : t('m.muteAction')}">${model.muted ? icons.micOff(20) : icons.mic(20)}</button>
      <button class="m-icon-btn m-callbar-leave" id="m-callbar-leave" aria-label="${t('m.leaveCall')}">${icons.phoneOff(20)}</button>`;
    el.querySelector('#m-callbar-open').addEventListener('click', () => nav.push('voice', s.params.dmId ? { kind: 'dm', dmId: s.params.dmId } : { kind: 'channel', serverId: s.params.serverId, channelId: s.params.channelId }));
    el.querySelector('#m-callbar-mute').addEventListener('click', () => setVoiceState({ muted: !state.voice.muted }));
    el.querySelector('#m-callbar-leave').addEventListener('click', leaveSession);
  }
  bus.on('m:call', paint);
  bus.on('state:voice', paint);
  paint();
}
