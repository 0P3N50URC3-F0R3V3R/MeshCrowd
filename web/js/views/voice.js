import { bus } from '../bus.js';
import { ws } from '../ws.js';
import { icons } from '../icons.js';
import { api } from '../api.js';
import { state, isSelf, setVoiceState } from '../state.js';
import { avatarHtml, escapeHtml, toast } from '../utils.js';
import { voicePrefs, keyLabel } from '../voicePrefs.js';
import { createDenoiser } from '../noiseSuppression.js';
import { openSoundboardPicker } from './soundboardPicker.js';
import { playSoundboardAudio } from '../soundboardPrefs.js';
import { t } from '../i18n.js';
import { createWhiteboard } from '../whiteboard.js';
import { DEFAULT_VOICE_QUALITY } from '../voiceQuality.js';
import { createMeshEngine } from '../voiceMesh.js';
import { createSfuEngine, createConnectRetry } from '../voiceSfu.js';
import { callKey, createCallRegistry, createCallMount, joinDeniedToastKey } from '../callLifecycle.mjs';

// A function (not a module-level constant) so labels re-evaluate against the current language —
// see userBar.js's statusOptions() for why a plain top-level object built with t() would freeze.
function qualityLabel() {
  return { good: t('voice.goodConnection'), ok: t('voice.unstableConnection'), poor: t('voice.poorConnection') };
}

// Quality dot tooltip: the quality label plus how the audio travels (direct LAN/VPN/public path,
// NAT-traversed through STUN, or relayed by TURN). Path is unknown until the first stats poll.
function qualityTitle(peer) {
  const q = qualityLabel()[peer?.quality || 'good'];
  const p = peer?.path ? { direct: t('voice.pathDirect'), stun: t('voice.pathStun'), relay: t('voice.pathRelay'), sfu: t('voice.pathSfu') }[peer.path] : '';
  const base = p ? `${q} - ${p}` : q;
  return localNetworks ? `${base}\n${t('voice.yourNetworks')}: ${localNetworks}` : base;
}

// Desktop client only: this machine's IPv4 adapters, shown in the tooltip so a Radmin/ZeroTier/VPN
// address is easy to spot when checking why two people do or don't connect directly.
let localNetworks = '';
window.dismeshClient?.getNetworkInterfaces?.()
  .then((list) => { localNetworks = (list || []).map((n) => `${n.name} ${n.address}`).join(', '); })
  .catch(() => {});

// ICE servers for every peer connection: the operator's external STUN/TURN entries plus the
// built-in server's with a short-lived credential (GET /api/voice/ice, empty unless the admin
// opted in, so a default install stays LAN-only). Cached until shortly before the credential expires.
// lanNetworks is the operator's optional LAN/VPN subnet list (see config.js); empty = no filtering.
let iceCache = null; // { servers, lanNetworks, expires }
async function getIceConfig() {
  if (iceCache && iceCache.expires > Date.now()) return iceCache;
  let servers;
  let lanNetworks = [];
  let ttlMs = 3_600_000;
  try {
    const res = await api.voiceIce();
    servers = res.iceServers || [];
    lanNetworks = Array.isArray(res.lanNetworks) ? res.lanNetworks : [];
    if (res.ttlMs) ttlMs = res.ttlMs;
  } catch {
    try { servers = (await api.config()).iceServers || []; } catch { servers = []; }
  }
  iceCache = { servers, lanNetworks, expires: Date.now() + Math.max(60_000, ttlMs - 600_000) };
  return iceCache;
}
export const resetIceServers = () => { iceCache = null; };

// Discord-shaped voice channel; the WebRTC topology lives in an engine (voiceMesh.js for a full
// mesh, voiceSfu.js for the server's SFU), signalled over the existing app WebSocket.
// Pass either { serverId, channelId, channelName } for a server voice channel, or { dmId, dmName }
// for an invite-only DM/group call — same engine/signalling code, just a different room scope.
// The one voice room this client is currently joined to. Its instance outlives the view that
// mounted it: navigating elsewhere only detaches the UI (see destroy()), the call keeps running
// until the user presses Leave or joins another room.
const calls = createCallRegistry();
export const leaveActiveCall = () => calls.leaveActive();

export function mountVoiceChannel(container, opts) {
  return calls.mount(callKey(opts), container, (c) => createVoiceMount(c, opts));
}

function createVoiceMount(container, { serverId, channelId, channelName, dmId, dmName, sounds, channelType, canManageChannel, canModerateVoice, voiceQuality, mobile }) {
  const isDm = !!dmId;
  const key = callKey({ dmId, channelId });
  const call = createCallMount(calls, key);
  const roomLabel = isDm ? (dmName || t('voice.thisCallFallback')) : channelName;
  // Stage channels layer a speaker/audience split on top of the same voice room a regular
  // channel uses — never true for a DM (stages are server-scoped, never wired up there).
  const isStage = !isDm && channelType === 'stage';
  let speakerIds = new Set();
  let raisedHandIds = new Set();
  const amSpeaker = (userId) => !isStage || speakerIds.has(userId);
  // Shared whiteboard (server/lib/whiteboard.js): same draw/clear rules enforced server-side. Hiding
  // it is a purely local view choice; strokes keep arriving and are drawn into the hidden board.
  const wb = isDm ? null : createWhiteboard({
    send: (m) => ws.send({ ...m, channelId }),
    canDraw: () => call.joined && (!isStage || amSpeaker(state.me.id) || !!canManageChannel),
    canClear: () => call.joined && (!!canManageChannel || (isStage && amSpeaker(state.me.id))),
  });
  let wbVisible = isStage;
  let wbChosen = false;
  function showWbIfActive() {
    if (wbChosen || wbVisible || !wb.hasContent()) return;
    wbVisible = true;
    render();
  }
  // Every outbound ws message and every inbound ws:voice_state/ws:voice_signal filter needs to
  // agree on which room this mount is — scopePayload() is the single source of truth for that.
  function scopePayload() {
    return isDm ? { dmChannelId: dmId } : { channelId };
  }
  function matchesThisRoom(payload) {
    return isDm ? payload.dmChannelId === dmId : payload.channelId === channelId;
  }
  const quality = isDm ? DEFAULT_VOICE_QUALITY : (voiceQuality || DEFAULT_VOICE_QUALITY);
  // Seeded from the global preference (toggled from the persistent user-bar controls, which work
  // even outside this view) so muting before you join carries in, instead of always starting unmuted.
  let muted = state.voice.muted;
  // Set by a moderator's "Mute for Everyone" (see applyRoster) — overrides the user's own mute
  // toggle until a moderator lifts it; unlike deafen (self-inflicted, self-reversible), this one
  // can't be undone from this end at all.
  let forceMuted = false;
  let deafened = state.voice.deafened;
  let mutedBeforeDeafen = false;
  let pttActive = false; // key currently held (or within its release delay), only meaningful when voicePrefs().pttEnabled
  let pttReleaseTimer = null;
  let pttVadOpen = false; // voice activity currently above threshold, only used when pttEnabled && pttVadAlt
  let duckUntil = 0; // playback stays lowered (echo reduction) until this timestamp
  let rawStream = null; // straight from getUserMedia, kept only to stop() its tracks
  let meterStream = null; // clone of rawStream for the level meter, so closing the gate does not blind it
  let sendTrack = null; // post-gain track actually handed to the engine
  let audioCtx = null;
  let gainNode = null;
  let denoiser = null;
  let localMeter = null;
  let roster = []; // last known participants (public user objects), including self once joined
  // UI-side state per remote participant the engine has reported media or stats for; the engine
  // owns the connections themselves.
  const peers = new Map(); // userId -> { audioEl, analyser, speaking, volume, quality, path, cameraStream, screenStream }
  let meterTimer = null;
  let statsTimer = null;
  // The engine is created on the first voice_state that includes me, because only then is the
  // room's mode ('mesh' | 'sfu') known; every voice_join (join, reconnect, SFU reset) re-arms it.
  let awaitingEngine = false;
  // The server has no ICE-restart or transport-close op, so the one retry rejoins the room in
  // place: a voice_join for the room we are already in gives us a fresh server-side peer with new
  // transports. No voice_leave first, which would demote an invited stage speaker and re-ring a DM.
  // A second failure leaves.
  const sfuRetry = createConnectRetry({
    onRetry: () => rejoinRoom(),
    onGiveUp: () => {
      toast(t('voice.sfuGaveUp'), { type: 'error' });
      leave();
    },
  });

  let cameraTrack = null;
  let cameraFacing = 'user';
  let cameraOpening = false;
  let screenTrack = null;
  let screenOpening = false;
  let localCameraStream = null;
  let localScreenStream = null;

  function uiPeer(userId) {
    let peer = peers.get(userId);
    if (!peer) {
      peer = { audioEl: null, analyser: null, speaking: false, volume: 1, quality: 'good', path: null, cameraStream: null, screenStream: null };
      peers.set(userId, peer);
    }
    return peer;
  }

  function createEngine(mode) {
    const ctx = {
      me: state.me.id,
      ws,
      scopePayload,
      getIceConfig,
      quality: () => quality,
      hooks: {
        attachAudio: attachRemoteAudio,
        attachVideo: attachRemoteVideo,
        detachVideo: detachRemoteVideo,
        closeRemote: closeRemotePeer,
        onPath: (userId, path) => updateQuality(userId, peers.get(userId)?.quality || 'good', path),
        onHealthy: () => sfuRetry.healthy(),
        onConnectFailed: onSfuConnectFailed,
        onProduceFailed: onSfuProduceFailed,
      },
    };
    return mode === 'sfu' ? createSfuEngine(ctx) : createMeshEngine(ctx);
  }

  function sendJoin() {
    awaitingEngine = true;
    ws.send({ type: 'voice_join', ...scopePayload(), sfu: true });
  }

  function startEngine(payload) {
    if (!call.joined || !awaitingEngine || !payload.participants.some((u) => u.id === state.me.id)) return;
    awaitingEngine = false;
    const engine = createEngine(payload.mode === 'sfu' ? 'sfu' : 'mesh');
    if (!call.setEngine(engine)) return;
    if (sendTrack) engine.setLocalTrack('audio', sendTrack);
    if (cameraTrack) engine.setLocalTrack('camera', cameraTrack);
    if (screenTrack) engine.setLocalTrack('screen', screenTrack);
    engine.setAudioPaused?.(muted || deafened);
    engine.start();
  }

  // Drops the engine and every remote, then joins again through voice_join; the next voice_state
  // with me in it builds a fresh engine for whatever mode the room has now.
  function rejoinRoom() {
    call.dropEngine();
    for (const id of [...peers.keys()]) closeRemotePeer(id);
    roster = roster.filter((u) => u.id !== state.me.id);
    sendJoin();
  }

  function onSfuProduceFailed(media) {
    if (!call.joined) return;
    toast(t(media === 'camera' ? 'voice.cameraShareFailed' : 'voice.screenShareFailed'), { type: 'error' });
    if (media === 'camera' && cameraTrack) toggleCamera();
    if (media === 'screen' && screenTrack) toggleScreenShare();
  }

  function onSfuConnectFailed(direction) {
    if (!call.joined) return;
    if (direction) toast(t('voice.sfuConnectFailed'), { type: 'error' });
    sfuRetry.failed(direction);
  }

  render();

  const offVoiceState = bus.on('ws:voice_state', (payload) => {
    if (!matchesThisRoom(payload)) return;
    startEngine(payload);
    applyRoster(payload.participants);
  });
  // sfu_event goes to every tab of the user, so only the tab whose call is in that room acts on it.
  const offSfuEvent = bus.on('ws:sfu_event', (payload) => {
    if (!call.joined || !matchesThisRoom(payload)) return;
    if (payload.event === 'reset') { rejoinRoom(); return; }
    call.engine?.handleEvent?.(payload);
  });
  const offSfuResponse = bus.on('ws:sfu_response', (payload) => {
    call.engine?.handleResponse?.(payload);
  });
  const offVoiceSignal = bus.on('ws:voice_signal', (payload) => {
    if (!matchesThisRoom(payload)) return;
    call.engine?.handleSignal(payload.fromUserId, payload.signal);
  });
  // Every participant (sender included) plays from this same broadcast, not optimistically on
  // click — there's no central mixer to inject the clip into anyone's outgoing WebRTC track, so
  // "everyone hears it" just means "everyone's own browser plays the file locally, in sync".
  const offSoundboard = bus.on('ws:voice_soundboard_play', (payload) => {
    if (isDm || payload.channelId !== channelId) return;
    playSoundboardClip(payload.sound);
  });
  const offStageState = bus.on('ws:stage_state', (payload) => {
    if (!isStage || payload.channelId !== channelId) return;
    speakerIds = new Set(payload.speakers);
    raisedHandIds = new Set(payload.raisedHands);
    if (amSpeaker(state.me.id)) call.engine?.retryAudio?.();
    updateSendEnabled();
    render();
  });
  const offWbStroke = bus.on('ws:wb_stroke', (payload) => {
    if (!wb || payload.channelId !== channelId || !call.joined) return;
    wb.applyStroke(payload);
    showWbIfActive();
  });
  const offWbClear = bus.on('ws:wb_clear', (payload) => {
    if (!wb || payload.channelId !== channelId) return;
    wb.applyClear();
  });
  const offWbState = bus.on('ws:wb_state', (payload) => {
    if (!wb || payload.channelId !== channelId || !call.joined) return;
    wb.applyState(payload.strokes);
    showWbIfActive();
  });
  // A WS drop closes our server-side voice membership (voice.leaveAll on socket close) and every
  // other participant tears down their peer connection to us — so on reconnect we're a ghost:
  // still marked joined locally with peer connections nobody else recognizes. Tear ours down too
  // and re-announce, reusing the mic stream we already have.
  // The room may even have been recreated in another mode meanwhile, so the engine is rebuilt.
  const offWsOpen = bus.on('ws:open', () => {
    if (!call.joined) return;
    rejoinRoom();
  });
  // Server-side backstop for the one-call rule (e.g. already in a call from another tab/device).
  const offJoinDenied = bus.on('ws:voice_join_denied', (payload) => {
    if (!call.joined || !matchesThisRoom(payload)) return;
    const key = joinDeniedToastKey(payload.reason);
    if (key) toast(t(key), { type: 'error' });
    call.end();
    cleanupAll();
    roster = roster.filter((u) => u.id !== state.me.id);
    setVoiceState({ serverId: null, channelId: null, channelName: null, dmId: null, dmName: null });
    // Ended while the user is on another view: nothing will destroy this mount later.
    if (call.detached) { destroy(); return; }
    render();
  });
  const offPrefsChanged = bus.on('voiceprefs:changed', onPrefsChanged);
  // The user-bar mute/deafen controls (or another mount of this same channel) can change the
  // global preference out from under us — resync local state instead of drifting silently out
  // of sync with what the buttons down there show.
  const offGlobalVoice = bus.on('state:voice', syncFromGlobalVoiceState);

  function syncFromGlobalVoiceState() {
    if (muted === state.voice.muted && deafened === state.voice.deafened) return;
    muted = state.voice.muted;
    deafened = state.voice.deafened;
    updateSendEnabled();
    render();
  }

  function render() {
    const prefs = voicePrefs.get();
    container.innerHTML = `
      <div class="voice-room">
        <div class="voice-participants" id="vc-grid"></div>
        <div class="voice-controls">
          ${call.joined && prefs.pttEnabled
            ? `<span class="vc-ptt-hint" title="${t('voice.pttHintTitle')}">${icons.mic(16)} ${t('voice.holdKeyToTalk', { key: keyLabel(prefs.pttKey) })}</span>`
            : ''}
          ${call.joined
            ? `${!isStage || amSpeaker(state.me.id)
                ? `<button class="btn-icon voice-ctl ${muted ? 'active-danger' : ''}" id="vc-mute" ${prefs.pttEnabled || forceMuted ? 'disabled' : ''} title="${forceMuted ? t('voice.mutedByModeratorTitle') : muted ? t('userBar.unmute') : t('userBar.mute')}">${muted ? icons.micOff(20) : icons.mic(20)}</button>`
                : `<button class="btn-icon voice-ctl ${raisedHandIds.has(state.me.id) ? 'active' : ''}" id="vc-raise-hand" title="${raisedHandIds.has(state.me.id) ? t('voice.lowerHandTitle') : t('voice.raiseHandTitle')}">${icons.hand(20)}</button>`}
               <button class="btn-icon voice-ctl ${deafened ? 'active-danger' : ''}" id="vc-deafen" title="${deafened ? t('userBar.undeafen') : t('userBar.deafen')}">${deafened ? icons.headphonesOff(20) : icons.headphones(20)}</button>
               ${!isStage || amSpeaker(state.me.id) ? `
                 <button class="btn-icon voice-ctl ${cameraTrack ? 'active' : ''}" id="vc-camera" title="${cameraTrack ? t('voice.turnOffCameraTitle') : t('voice.turnOnCameraTitle')}">${cameraTrack ? icons.camera(20) : icons.videoOff(20)}</button>
                 ${mobile || window.dismeshClient?.isAndroidWebView ? (cameraTrack ? `<button class="btn-icon voice-ctl" id="vc-flip-camera" title="${t('voice.flipCameraTitle')}">${icons.refresh(20)}</button>` : '') : `<button class="btn-icon voice-ctl ${screenTrack ? 'active' : ''}" id="vc-screenshare" title="${screenTrack ? t('voice.stopScreenShareTitle') : t('voice.shareScreenTitle')}">${icons.monitor(20)}</button>`}` : ''}
               ${wb ? `<button class="btn-icon voice-ctl ${wbVisible ? 'active' : ''}" id="vc-whiteboard" aria-pressed="${wbVisible}" title="${wbVisible ? t('voice.wbHideTitle') : t('voice.wbShowTitle')}" aria-label="${wbVisible ? t('voice.wbHideTitle') : t('voice.wbShowTitle')}">${icons.edit(20)}</button>` : ''}
               ${!isDm ? `<button class="btn-icon voice-ctl" id="vc-soundboard" title="${t('voice.soundboardTitle')}">${icons.music(20)}</button>` : ''}
               ${isStage && amSpeaker(state.me.id) ? `<button class="btn btn-secondary" id="vc-step-down">${icons.hand(16)} ${t('voice.stepDownButton')}</button>` : ''}
               <button class="btn btn-danger" id="vc-leave">${icons.phoneOff(16)} ${t('voice.leaveButton')}</button>`
            : `<button class="btn btn-primary" id="vc-join">${icons.headphones(16)} ${isStage ? t('voice.joinStageButton') : t('voice.joinVoiceButton')}</button>`}
        </div>
      </div>`;

    renderGrid();
    if (wb && call.joined && wbVisible) {
      container.querySelector('.voice-controls').before(wb.el);
      wb.refresh();
      wb.fit();
    }

    container.querySelector('#vc-whiteboard')?.addEventListener('click', () => {
      wbVisible = !wbVisible;
      wbChosen = true;
      render();
    });
    container.querySelector('#vc-join')?.addEventListener('click', join);
    container.querySelector('#vc-leave')?.addEventListener('click', leave);
    container.querySelector('#vc-mute')?.addEventListener('click', toggleMute);
    container.querySelector('#vc-deafen')?.addEventListener('click', toggleDeafen);
    container.querySelector('#vc-raise-hand')?.addEventListener('click', () => {
      ws.send({ type: 'stage_raise_hand', channelId, raised: !raisedHandIds.has(state.me.id) });
    });
    container.querySelector('#vc-step-down')?.addEventListener('click', () => {
      ws.send({ type: 'stage_move_to_audience', channelId, userId: state.me.id });
    });
    container.querySelector('#vc-soundboard')?.addEventListener('click', (e) => {
      openSoundboardPicker(e.currentTarget, sounds || [], (sound) => {
        ws.send({ type: 'voice_soundboard_play', channelId, soundId: sound.id });
      });
    });
    container.querySelector('#vc-camera')?.addEventListener('click', toggleCamera);
    container.querySelector('#vc-flip-camera')?.addEventListener('click', flipCamera);
    container.querySelector('#vc-screenshare')?.addEventListener('click', toggleScreenShare);
  }

  // `streamMap` collects "uid:kind" -> MediaStream for every video element this render pass
  // produces; a video's `srcObject` can only be set via JS (never through the HTML string itself),
  // so renderGrid does one pass over `grid.querySelectorAll('[data-stream-key]')` afterwards to
  // wire each placeholder up to its stream.
  function renderTile(u, streamMap) {
    const peer = peers.get(u.id);
    const speaking = peer?.speaking ?? false;
    const mine = isSelf(u.id);
    const cameraStream = mine ? localCameraStream : peer?.cameraStream;
    let stageActions = '';
    if (isStage) {
      const speakerNow = amSpeaker(u.id);
      const raised = raisedHandIds.has(u.id);
      if (!speakerNow && raised) {
        stageActions += `<span class="vc-hand-badge" title="${t('voice.wantsToSpeakTitle')}">${icons.hand(14)}</span>`;
        if (amSpeaker(state.me.id)) stageActions += `<button class="btn btn-sm btn-secondary" data-invite-speaker="${u.id}">${t('voice.inviteToSpeakButton')}</button>`;
      }
      if (speakerNow && !mine && canManageChannel) {
        stageActions += `<button class="btn btn-sm btn-secondary" data-move-audience="${u.id}">${t('voice.moveToAudienceButton')}</button>`;
      }
    }
    const mutedByMod = !!u.mutedByMod;
    let media;
    if (cameraStream) {
      streamMap.set(`${u.id}:camera`, cameraStream);
      media = `<video class="vc-video" data-stream-key="${u.id}:camera" autoplay playsinline muted ${mine ? 'style="transform:scaleX(-1)"' : ''}></video>
        <button class="btn-icon vc-fullscreen-btn" data-fullscreen="${u.id}:camera" title="${t('voice.fullscreenTitle')}">${icons.maximize(16)}</button>
        ${mutedByMod ? `<span class="vc-mod-muted-badge vc-mod-muted-badge-video" title="${t('voice.mutedByModeratorTitle')}">${icons.micOff(11)}</span>` : ''}`;
    } else {
      media = `<div class="voice-tile-avatar">${avatarHtml(u, 96)}${!mine ? `<span class="vc-quality vc-quality-${peer?.quality || 'good'}" title="${escapeHtml(qualityTitle(peer))}"></span>` : ''}${mutedByMod ? `<span class="vc-mod-muted-badge" title="${t('voice.mutedByModeratorTitle')}">${icons.micOff(11)}</span>` : ''}</div>`;
    }
    return `
      <div class="voice-tile ${speaking ? 'speaking' : ''} ${cameraStream ? 'has-video' : ''}" data-uid="${u.id}">
        ${media}
        <div class="vc-volume-strip" title="${t('voice.speakingVolumeTitle')}"><div class="vc-volume-strip-fill" data-level-uid="${u.id}"></div></div>
        <div class="voice-tile-name">${escapeHtml(u.displayName)}${mine ? t('voice.youSuffix') : ''}</div>
        ${!mine ? `<div class="vc-tile-row">
          <input type="range" class="vc-volume" data-uid="${u.id}" min="0" max="100" value="${Math.round((peer?.volume ?? 1) * 100)}" title="${t('voice.volumeTitle')}">
          ${canModerateVoice ? `<button class="btn-icon vc-mod-mute ${mutedByMod ? 'active-danger' : ''}" data-mod-mute="${u.id}" title="${mutedByMod ? t('voice.unmuteForEveryoneTitle') : t('voice.muteForEveryoneTitle')}">${mutedByMod ? icons.micOff(14) : icons.mic(14)}</button>` : ''}
        </div>` : ''}
        ${stageActions ? `<div class="vc-stage-actions">${stageActions}</div>` : ''}
      </div>`;
  }

  // A screen share is its own tile, separate from the sharer's regular avatar/camera tile —
  // matches Discord (your camera and your screen share are two different things being shown, not
  // one replacing the other).
  function renderScreenShareTile(u, streamMap) {
    const mine = isSelf(u.id);
    const stream = mine ? localScreenStream : peers.get(u.id)?.screenStream;
    streamMap.set(`${u.id}:screen`, stream);
    return `
      <div class="voice-tile has-video" data-uid="${u.id}">
        <video class="vc-video" data-stream-key="${u.id}:screen" autoplay playsinline muted></video>
        <button class="btn-icon vc-fullscreen-btn" data-fullscreen="${u.id}:screen" title="${t('voice.fullscreenTitle')}">${icons.maximize(16)}</button>
        <div class="voice-tile-name">${escapeHtml(u.displayName)}${mine ? t('voice.youSuffix') : ''}${t('voice.screenTitleSuffix')}</div>
      </div>`;
  }

  function renderGrid() {
    const grid = container.querySelector('#vc-grid');
    if (!grid) return;
    if (roster.length === 0) {
      grid.innerHTML = `<div class="empty-state"><p>${t('voice.nobodyInRoom', { room: escapeHtml(roomLabel) })}</p></div>`;
      return;
    }
    const streamMap = new Map();
    const screenSharers = roster.filter((u) => (isSelf(u.id) ? localScreenStream : peers.get(u.id)?.screenStream));
    const screenTilesHtml = screenSharers.map((u) => renderScreenShareTile(u, streamMap)).join('');
    if (isStage) {
      const speakers = roster.filter((u) => amSpeaker(u.id));
      const audience = roster.filter((u) => !amSpeaker(u.id));
      grid.innerHTML = `
        ${screenTilesHtml}
        <div class="vc-stage-section-label">${t('voice.speakersLabel')}${speakers.length ? ` — ${speakers.length}` : ''}</div>
        ${speakers.length ? speakers.map((u) => renderTile(u, streamMap)).join('') : `<div class="empty-state vc-stage-section-label" style="text-transform:none;font-weight:400"><p>${t('voice.nobodySpeakingYet')}</p></div>`}
        <div class="vc-stage-section-label">${t('voice.audienceLabel')}${audience.length ? ` — ${audience.length}` : ''}</div>
        ${audience.length ? audience.map((u) => renderTile(u, streamMap)).join('') : `<div class="empty-state vc-stage-section-label" style="text-transform:none;font-weight:400"><p>${t('voice.nobodyHereYet')}</p></div>`}`;
    } else {
      grid.innerHTML = screenTilesHtml + roster.map((u) => renderTile(u, streamMap)).join('');
    }
    grid.querySelectorAll('[data-stream-key]').forEach((videoEl) => {
      const stream = streamMap.get(videoEl.dataset.streamKey);
      if (stream) videoEl.srcObject = stream;
    });
    grid.querySelectorAll('.vc-volume').forEach((slider) => {
      slider.addEventListener('input', (e) => setParticipantVolume(Number(e.target.dataset.uid), Number(e.target.value) / 100));
    });
    grid.querySelectorAll('[data-invite-speaker]').forEach((btn) => {
      btn.addEventListener('click', () => ws.send({ type: 'stage_invite_speaker', channelId, userId: Number(btn.dataset.inviteSpeaker) }));
    });
    grid.querySelectorAll('[data-move-audience]').forEach((btn) => {
      btn.addEventListener('click', () => ws.send({ type: 'stage_move_to_audience', channelId, userId: Number(btn.dataset.moveAudience) }));
    });
    grid.querySelectorAll('[data-mod-mute]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const uid = Number(btn.dataset.modMute);
        const target = roster.find((u) => u.id === uid);
        ws.send({ type: target?.mutedByMod ? 'voice_force_unmute' : 'voice_force_mute', channelId, userId: uid });
      });
    });
    grid.querySelectorAll('[data-fullscreen]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tile = btn.closest('.voice-tile');
        if (document.fullscreenElement === tile) document.exitFullscreen?.();
        else tile.requestFullscreen?.().catch(() => toast(t('voice.fullscreenNotAvailable'), { type: 'error' }));
      });
    });
  }

  // Swaps the maximize/minimize icon on whichever tile is currently fullscreen - a native
  // fullscreenchange listener rather than tracking state locally, so it stays correct even if the
  // browser itself exits fullscreen (Escape key), not just via this button. Removed in destroy()
  // below since this is a document-level listener that would otherwise outlive this mount.
  function onFullscreenChange() {
    container.querySelectorAll('.vc-fullscreen-btn').forEach((btn) => {
      const isThis = document.fullscreenElement === btn.closest('.voice-tile');
      btn.innerHTML = isThis ? icons.minimize(16) : icons.maximize(16);
      btn.title = isThis ? t('voice.exitFullscreenTitle') : t('voice.fullscreenTitle');
    });
  }
  document.addEventListener('fullscreenchange', onFullscreenChange);

  function setParticipantVolume(userId, volume) {
    const peer = peers.get(userId);
    if (!peer) return;
    peer.volume = volume;
    applyOutputVolume(peer);
  }

  function applyOutputVolume(peer) {
    if (!peer.audioEl) return;
    const { outputVolume: master, echoReduction, echoReductionDb } = voicePrefs.get();
    const duck = echoReduction && Date.now() < duckUntil ? 10 ** (-echoReductionDb / 20) : 1;
    peer.audioEl.volume = deafened ? 0 : Math.max(0, Math.min(1, master * duck * (peer.volume ?? 1)));
  }

  function applyOutputVolumes() {
    for (const peer of peers.values()) applyOutputVolume(peer);
  }

  async function applySinkId(audioEl) {
    const { outputDeviceId } = voicePrefs.get();
    if (!outputDeviceId || typeof audioEl.setSinkId !== 'function') return;
    try { await audioEl.setSinkId(outputDeviceId); } catch { /* device gone or browser refused — stays on default output */ }
  }

  // Deafened means "hear nothing", soundboard clips included — same rule real Discord follows.
  function playSoundboardClip(sound) {
    if (deafened) return;
    playSoundboardAudio(sound.audioPath, voicePrefs.get().outputVolume, applySinkId);
  }

  const graphSig = (p) => [p.inputDeviceId, p.inputVolume, p.noiseSuppression].join('|');
  let lastGraphSig = graphSig(voicePrefs.get());

  function onPrefsChanged() {
    if (!call.joined) { render(); return; }
    if (!voicePrefs.get().echoReduction) duckUntil = 0;
    applyOutputVolumes();
    for (const peer of peers.values()) if (peer.audioEl) applySinkId(peer.audioEl);
    const sig = graphSig(voicePrefs.get());
    if (sig !== lastGraphSig) { lastGraphSig = sig; rebuildInputGraph(); }
    updateSendEnabled();
    render();
  }

  // Builds the mic -> GainNode -> MediaStreamAudioDestinationNode chain. The track handed to
  // peer connections is the destination node's track (post-gain), never the raw mic track, so
  // the input-volume slider actually affects what others hear, not just local monitoring.
  async function rebuildInputGraph() {
    if (!call.joined) return;
    const prefs = voicePrefs.get();
    let newRaw;
    try {
      newRaw = await navigator.mediaDevices.getUserMedia({
        audio: { ...(prefs.inputDeviceId ? { deviceId: { exact: prefs.inputDeviceId } } : {}), channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch {
      toast(t('voice.couldNotAccessMic'), { type: 'error' });
      return;
    }
    teardownInputGraph();
    rawStream = newRaw;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)(prefs.noiseSuppression ? { sampleRate: 48000 } : undefined);
    const source = audioCtx.createMediaStreamSource(rawStream);
    gainNode = audioCtx.createGain();
    gainNode.gain.value = prefs.inputVolume;
    const dest = audioCtx.createMediaStreamDestination();
    let head = source;
    if (prefs.noiseSuppression) {
      try {
        denoiser = await createDenoiser(audioCtx);
        source.connect(denoiser.input);
        head = denoiser.output;
      } catch {
        denoiser = null;
        toast(t('voice.noiseSuppressionFailed'), { type: 'error' });
      }
    }
    // A mic that is clocked separately from the audio graph crackles when routed through it, so the
    // graph (gain + denoiser) only sits in the send path when it actually changes the signal.
    const needsGraph = denoiser || Math.abs(prefs.inputVolume - 1) > 0.01;
    if (needsGraph) {
      head.connect(gainNode);
      gainNode.connect(dest);
      sendTrack = dest.stream.getAudioTracks()[0];
    } else {
      sendTrack = rawStream.getAudioTracks()[0];
    }
    updateSendEnabled();
    call.engine?.setLocalTrack('audio', sendTrack);
    // The meter reads its own clone of the mic: a disabled track (closed gate) feeds silence, so a meter on
    // the sent track could never see the voice that is supposed to open it again.
    meterStream = rawStream.clone();
    startLocalMeter(audioCtx.createMediaStreamSource(meterStream));
  }

  function teardownInputGraph() {
    if (rawStream) for (const t of rawStream.getTracks()) t.stop();
    if (meterStream) for (const t of meterStream.getTracks()) t.stop();
    meterStream = null;
    rawStream = null;
    sendTrack = null;
    // startLocalMeter() builds its meter straight off the shared audioCtx (not its own), so
    // localMeter.ctx and audioCtx are the same object here — close it exactly once, and via
    // .catch rather than try/catch since AudioContext#close() rejects asynchronously rather
    // than throwing synchronously on an already-closed context.
    localMeter = null;
    denoiser?.destroy();
    denoiser = null;
    if (audioCtx) audioCtx.close().catch(() => {});
    audioCtx = null;
    gainNode = null;
  }

  // Single source of truth for whether the outbound track should actually carry audio: manual
  // mute, deafen (which force-mutes), push-to-talk, and voice activation all funnel through here
  // (or, for VAD, through the level-driven gate in the meter tick below) instead of each poking
  // track.enabled directly, so they can't fight each other.
  function updateSendEnabled() {
    call.engine?.setAudioPaused?.(muted || deafened);
    if (!sendTrack) return;
    // Audience members can never transmit, regardless of their own mute toggle — the only way
    // out is a speaker promoting them (stage_invite_speaker), not anything they control locally.
    if (isStage && !amSpeaker(state.me.id)) { sendTrack.enabled = false; return; }
    if (forceMuted) { sendTrack.enabled = false; return; }
    const prefs = voicePrefs.get();
    if (deafened || muted) { sendTrack.enabled = false; return; }
    if (prefs.pttEnabled) { sendTrack.enabled = pttActive || (prefs.pttVadAlt && pttVadOpen); return; }
    if (prefs.vadEnabled) return; // left alone — the meter tick opens/closes it off the live level
    sendTrack.enabled = true;
  }

  function applyRoster(next) {
    call.engine?.onRoster(next.map((u) => u.id));
    roster = next;
    const myEntry = next.find((u) => u.id === state.me.id);
    const nowForceMuted = !!myEntry?.mutedByMod;
    if (nowForceMuted !== forceMuted) {
      forceMuted = nowForceMuted;
      if (forceMuted && !muted) { muted = true; setVoiceState({ muted }); }
      if (!forceMuted) call.engine?.retryAudio?.();
      updateSendEnabled();
      if (forceMuted) toast(t('voice.moderatorMutedYouToast'), { type: 'error' });
      render();
      return;
    }
    renderGrid();
  }

  async function join() {
    if (!call.beginJoin()) return;
    await rebuildInputGraph();
    if (!sendTrack) { call.cancelJoin(); return; }
    call.activate({ attach, leave: () => { if (call.joined) leave(); } });
    sfuRetry.reset();
    sendJoin();
    registerPtt();
    startStatsPolling();
    setVoiceState(isDm ? { dmId, dmName } : { serverId, channelId, channelName });
    render();
  }

  function leave() {
    ws.send({ type: 'voice_leave', ...scopePayload() });
    call.end();
    cleanupAll();
    deafened = false;
    roster = roster.filter((u) => u.id !== state.me.id);
    // Mute/deafen themselves are left alone — like Discord, that's a standing preference, not
    // something a call ending should reset.
    setVoiceState({ serverId: null, channelId: null, channelName: null, dmId: null, dmName: null });
    if (call.detached) { destroy(); return; }
    render();
  }

  function toggleMute() {
    if (forceMuted) { toast(t('voice.moderatorMutedYouError'), { type: 'error' }); return; }
    muted = !muted;
    updateSendEnabled();
    setVoiceState({ muted });
    render();
  }

  function toggleDeafen() {
    deafened = !deafened;
    if (deafened) {
      mutedBeforeDeafen = muted;
      muted = true;
    } else {
      muted = mutedBeforeDeafen;
    }
    updateSendEnabled();
    applyOutputVolumes();
    setVoiceState({ muted, deafened });
    render();
  }

  async function toggleCamera() {
    // A second click while the camera is still opening (or flipping) would open a second one and lose track of it.
    if (cameraOpening) return;
    if (cameraTrack) {
      // Started before stop() so the senders are removed while the track is still live, as before
      // the engine split; the renegotiation it awaits runs after.
      const removed = call.engine?.setLocalTrack('camera', null);
      cameraTrack.stop();
      cameraTrack = null;
      localCameraStream = null;
      await removed;
      render();
      return;
    }
    cameraOpening = true;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: mobile ? { facingMode: cameraFacing } : true });
    } catch {
      toast(t('voice.couldNotAccessCamera'), { type: 'error' });
      return;
    } finally {
      cameraOpening = false;
    }
    if (!call.joined) { for (const tr of stream.getTracks()) tr.stop(); return; }
    cameraTrack = stream.getVideoTracks()[0];
    localCameraStream = stream;
    const thisTrack = cameraTrack;
    // The OS/browser "stop sharing"-equivalent for a camera is unplugging it or revoking the
    // permission mid-call — same graceful-stop handling screen share needs for its own OS-level
    // stop button, so both funnel through the same toggle-off path here. The `cameraTrack ===
    // thisTrack` guard stops a stale event from an already-replaced track re-triggering the
    // toggle-off path a second time.
    cameraTrack.onended = () => { if (cameraTrack === thisTrack) toggleCamera(); };
    await call.engine?.setLocalTrack('camera', cameraTrack);
    render();
  }

  // Phones usually cannot open two cameras at once, so the old track is stopped before the new one opens.
  async function flipCamera() {
    if (!cameraTrack || cameraOpening) return;
    cameraOpening = true;
    const next = cameraFacing === 'user' ? 'environment' : 'user';
    const old = cameraTrack;
    old.onended = null;
    old.stop();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: next } } });
    } catch {
      cameraTrack = null; localCameraStream = null;
      toast(t('voice.couldNotAccessCamera'), { type: 'error' });
      await call.engine?.setLocalTrack('camera', null);
      render();
      return;
    } finally {
      cameraOpening = false;
    }
    if (!call.joined || cameraTrack !== old) { for (const tr of stream.getTracks()) tr.stop(); return; }
    const track = stream.getVideoTracks()[0];
    cameraTrack = track; localCameraStream = stream; cameraFacing = next;
    await call.engine?.setLocalTrack('camera', track);
    track.onended = () => { if (cameraTrack === track) toggleCamera(); };
    render();
  }

  async function toggleScreenShare() {
    if (screenTrack) {
      const removed = call.engine?.setLocalTrack('screen', null);
      screenTrack.stop();
      screenTrack = null;
      localScreenStream = null;
      await removed;
      render();
      return;
    }
    if (screenOpening) return;
    screenOpening = true;
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    } catch {
      return; // user cancelled the picker — not an error worth a toast
    } finally {
      screenOpening = false;
    }
    if (!call.joined) { for (const tr of stream.getTracks()) tr.stop(); return; }
    screenTrack = stream.getVideoTracks()[0];
    localScreenStream = stream;
    const thisTrack = screenTrack;
    // Fires when the user clicks the browser/OS's own native "Stop sharing" control, not just
    // when they click our button — same toggle-off path either way keeps state consistent.
    screenTrack.onended = () => { if (screenTrack === thisTrack) toggleScreenShare(); };
    await call.engine?.setLocalTrack('screen', screenTrack);
    render();
  }

  function onPttKeyDown(e) {
    if (isTypingTarget(e.target)) return;
    const prefs = voicePrefs.get();
    if (!prefs.pttEnabled || e.code !== prefs.pttKey) return;
    clearTimeout(pttReleaseTimer);
    pttReleaseTimer = null;
    if (pttActive) return;
    pttActive = true;
    updateSendEnabled();
  }
  function onPttKeyUp(e) {
    const prefs = voicePrefs.get();
    if (!prefs.pttEnabled || e.code !== prefs.pttKey) return;
    clearTimeout(pttReleaseTimer);
    const release = () => { pttReleaseTimer = null; pttActive = false; updateSendEnabled(); };
    if (prefs.pttReleaseDelayMs > 0) pttReleaseTimer = setTimeout(release, prefs.pttReleaseDelayMs);
    else release();
  }
  function isTypingTarget(el) {
    const tag = el?.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable;
  }
  function registerPtt() {
    document.addEventListener('keydown', onPttKeyDown);
    document.addEventListener('keyup', onPttKeyUp);
  }
  function unregisterPtt() {
    document.removeEventListener('keydown', onPttKeyDown);
    document.removeEventListener('keyup', onPttKeyUp);
    clearTimeout(pttReleaseTimer);
    pttReleaseTimer = null;
    pttActive = false;
    pttVadOpen = false;
  }

  function attachRemoteAudio(userId, stream) {
    const peer = uiPeer(userId);
    // An SFU audio producer can be replaced (mute retry, rejoin), which attaches a second stream.
    peer.audioEl?.remove();
    peer.analyser?.ctx?.close?.().catch(() => {});
    const audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    audioEl.srcObject = stream;
    document.body.appendChild(audioEl);
    peer.audioEl = audioEl;
    applyOutputVolume(peer);
    applySinkId(audioEl);
    peer.analyser = createMeter(stream);
  }

  function attachRemoteVideo(userId, media, stream) {
    const peer = uiPeer(userId);
    if (media === 'camera') peer.cameraStream = stream; else peer.screenStream = stream;
    renderGrid();
  }

  function detachRemoteVideo(userId, media) {
    const peer = peers.get(userId);
    if (!peer) return;
    if (media === 'camera') peer.cameraStream = null; else peer.screenStream = null;
    renderGrid();
  }

  function closeRemotePeer(userId) {
    const peer = peers.get(userId);
    if (peer) {
      peer.audioEl?.remove();
      peer.analyser?.ctx?.close?.().catch(() => {});
      peers.delete(userId);
    }
    renderGrid();
  }

  // Coarse volume-based speaking indicator, sampled a few times a second — not a real VAD, but
  // enough to light up "who's talking" during a call. Used for both remote peers and the local
  // mic (see startLocalMeter).
  function createMeter(streamOrSource) {
    try {
      const ctx = streamOrSource instanceof MediaStream ? new (window.AudioContext || window.webkitAudioContext)() : audioCtx;
      const source = streamOrSource instanceof MediaStream ? ctx.createMediaStreamSource(streamOrSource) : streamOrSource;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      return { ctx, node: analyser, data: new Uint8Array(analyser.frequencyBinCount) };
    } catch {
      return null; // Web Audio unavailable — speaking indicator just stays off
    }
  }

  function startLocalMeter(sourceNode) {
    localMeter = createMeter(sourceNode);
  }

  // Samples each active meter and writes the result straight to both the peer record and the
  // tile's DOM class — one path for self and remote peers alike, no separate "did anything
  // change" bookkeeping needed since a no-op classList.toggle is effectively free.
  function readLevel(meter) {
    meter.node.getByteFrequencyData(meter.data);
    return meter.data.reduce((a, b) => a + b, 0) / meter.data.length;
  }

  function updateSpeakingIndicator(userId, meter, currentlyMuted, threshold = 12) {
    if (!meter) return;
    const avg = readLevel(meter);
    const speaking = !currentlyMuted && avg > threshold;
    const peer = peers.get(userId);
    if (peer) peer.speaking = speaking;
    const el = container.querySelector(`.voice-tile[data-uid="${userId}"]`);
    if (el) el.classList.toggle('speaking', speaking);
    // The moving volume strip, in addition to the boundary ring above - avg is a 0-255 byte-range
    // frequency average (see readLevel); most speech at a normal mic gain peaks well under 128,
    // so that's used as the "full bar" reference rather than 255, or the bar would barely move.
    const fillEl = container.querySelector(`[data-level-uid="${userId}"]`);
    if (fillEl) fillEl.style.width = `${currentlyMuted ? 0 : Math.max(0, Math.min(100, (avg / 128) * 100))}%`;
    return avg;
  }

  meterTimer = setInterval(() => {
    if (call.joined) {
      const prefs = voicePrefs.get();
      let level;
      if (localMeter) level = readLevel(localMeter);
      if (prefs.vadEnabled && !prefs.pttEnabled && !deafened && !muted && sendTrack && level !== undefined) {
        sendTrack.enabled = level > prefs.vadThreshold;
      }
      if (prefs.pttEnabled && prefs.pttVadAlt && level !== undefined) {
        const open = level > prefs.vadThreshold;
        if (open !== pttVadOpen) { pttVadOpen = open; updateSendEnabled(); }
      }
      if (prefs.echoReduction && level !== undefined && sendTrack?.enabled && level > prefs.vadThreshold) {
        const wasDucked = Date.now() < duckUntil;
        duckUntil = Date.now() + 500;
        if (!wasDucked) applyOutputVolumes();
      } else if (duckUntil && Date.now() >= duckUntil) {
        duckUntil = 0;
        applyOutputVolumes();
      }
      updateSpeakingIndicator(state.me.id, localMeter, !sendTrack?.enabled, prefs.vadThreshold);
    }
    for (const [id, peer] of peers) updateSpeakingIndicator(id, peer.analyser, false);
  }, 200);

  function startStatsPolling() {
    statsTimer = setInterval(pollStats, 2000);
  }

  async function pollStats() {
    const engine = call.engine;
    if (!engine) return;
    for (const [id, { quality, path }] of await engine.pollStats()) {
      if (call.engine === engine) updateQuality(id, quality, path);
    }
  }

  function updateQuality(userId, quality, path) {
    const peer = uiPeer(userId);
    if (peer.quality === quality && peer.path === path) return;
    peer.quality = quality;
    peer.path = path;
    const dot = container.querySelector(`.voice-tile[data-uid="${userId}"] .vc-quality`);
    if (dot) { dot.className = `vc-quality vc-quality-${quality}`; dot.title = qualityTitle(peer); }
  }

  function cleanupAll() {
    awaitingEngine = false;
    wb?.reset();
    wbVisible = isStage;
    wbChosen = false;
    for (const id of [...peers.keys()]) closeRemotePeer(id);
    teardownInputGraph();
    unregisterPtt();
    clearInterval(statsTimer);
    cameraTrack?.stop();
    screenTrack?.stop();
    cameraTrack = null;
    screenTrack = null;
    localCameraStream = null;
    localScreenStream = null;
  }

  function attach(newContainer) {
    container = newContainer;
    call.attach();
    render();
    return handle;
  }

  function destroy() {
    if (!call.detach()) return;
    offVoiceState();
    offSfuEvent();
    offSfuResponse();
    offVoiceSignal();
    offSoundboard();
    offStageState();
    offWbStroke();
    offWbClear();
    offWbState();
    wb?.destroy();
    offWsOpen();
    offJoinDenied();
    offPrefsChanged();
    offGlobalVoice();
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    clearInterval(meterTimer);
    cleanupAll();
  }

  const handle = { destroy, leave: () => { if (call.joined) leave(); }, isJoined: () => call.joined };
  return handle;
}
