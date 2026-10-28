import { icons } from '../../js/icons.js';
import { t } from '../../js/i18n.js';
import { state, nameFor } from '../../js/state.js';
import { escapeHtml } from '../../js/utils.js';
import { PERMISSIONS, has, memberPermissionBits, channelPermissionBits } from '../../js/permissions.js';
import { nav } from '../router.js';
import { ensureServerDetail } from '../data.js';
import { handleError } from '../lib/errors.js';
import { dmTitle } from '../lib/dmPreview.mjs';
import { androidBridge } from '../lib/androidBridge.js';
import { openSession, getSession, setVisible, setSpeaker, endSession, sessionJoined } from '../lib/callSession.js';
import { roomKey } from '../lib/callRoom.mjs';

export function mountVoice(el, params) {
  const isDm = params.kind === 'dm';
  const bridge = androidBridge();
  let destroyed = false;
  let session = null;

  el.innerHTML = `
    <div class="m-header">
      <button class="m-icon-btn" id="m-back" aria-label="${t('m.back')}">${icons.arrowLeft(22)}</button>
      <h1 id="m-title"></h1>
      <div class="m-actions" id="m-actions"></div>
    </div>
    <div class="m-voice-body" id="m-voice-body"></div>`;
  const body = el.querySelector('#m-voice-body');
  el.querySelector('#m-back').addEventListener('click', () => nav.back());

  function paintActions() {
    const box = el.querySelector('#m-actions');
    box.innerHTML = (!isDm ? `<button class="m-icon-btn" id="m-vchat" aria-label="${t('m.chatAction')}">${icons.messageSquare(20)}</button>` : '')
      + (bridge?.hasCallSupport ? `<button class="m-pill" id="m-speaker">${session?.speaker === false ? t('m.speakerOff') : t('m.speakerOn')}</button>` : '');
    box.querySelector('#m-vchat')?.addEventListener('click', () => nav.push('chat', { kind: 'channel', serverId: params.serverId, channelId: params.channelId }));
    box.querySelector('#m-speaker')?.addEventListener('click', () => { setSpeaker(!(session?.speaker ?? true)); paintActions(); });
  }

  async function start() {
    let title; let room;
    if (isDm) {
      const d = state.dms.find((x) => x.id === params.dmId);
      title = dmTitle(d, nameFor);
      room = { dmId: params.dmId, dmName: title };
    } else {
      const detail = await ensureServerDetail(params.serverId);
      const channel = detail.channels.find((c) => c.id === params.channelId);
      if (!channel) throw new Error('channel not found');
      title = channel.name;
      const isOwner = detail.server.owner_id === state.me.id;
      const me = detail.members.find((m) => m.user.id === state.me.id);
      const memberBits = memberPermissionBits(detail.server, detail.roles, me, state.me.id);
      const chBits = channelPermissionBits(channel, detail.roles, me, memberBits, isOwner);
      room = {
        serverId: params.serverId, channelId: channel.id, channelName: channel.name, channelType: channel.type,
        sounds: detail.sounds, canModerateVoice: has(chBits, PERMISSIONS.MODERATE_MEMBERS), voiceQuality: channel.voice_quality,
      };
    }
    if (destroyed) return;
    el.querySelector('#m-title').textContent = title;
    if (!window.isSecureContext) {
      body.innerHTML = `<div class="m-empty m-placeholder"><p>${escapeHtml(t('m.voiceNeedsHttps'))}</p></div>`;
      return;
    }
    const live = getSession();
    if (live && live.key !== roomKey(params) && sessionJoined()) {
      body.innerHTML = `<div class="m-empty m-placeholder"><p>${escapeHtml(t('voice.joinDeniedToast'))}</p></div>`;
      return;
    }
    session = openSession(room, title);
    body.appendChild(session.container);
    setVisible(true);
    paintActions();
  }

  start().catch((err) => { if (!destroyed) handleError(err); });

  return {
    onShow() {
      const s = getSession();
      if (s && s.key === roomKey(params) && !destroyed) { session = s; body.appendChild(s.container); setVisible(true); paintActions(); }
    },
    onHide() { if (getSession()?.key === roomKey(params)) setVisible(false); },
    destroy() {
      destroyed = true;
      const s = getSession();
      if (!s || s.key !== roomKey(params)) return;
      if (s.container.parentNode === body) s.container.remove();
      setVisible(false);
      if (!sessionJoined()) endSession();
    },
  };
}
