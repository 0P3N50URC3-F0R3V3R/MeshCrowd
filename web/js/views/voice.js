import { bus } from '../bus.js';
import { ws } from '../ws.js';
import { icons } from '../icons.js';
import { api } from '../api.js';
import { state, isSelf, setVoiceState } from '../state.js';
import { avatarHtml, escapeHtml, toast } from '../utils.js';
import { voicePrefs, keyLabel } from '../voicePrefs.js';
import { createDenoiser } from '../noiseSuppression.js';
import { openSoundboardPicker } from './soundboardPicker.js';
import { t } from '../i18n.js';
import { tuneOpusSdp, voiceQualityPreset, DEFAULT_VOICE_QUALITY } from '../voiceQuality.js';

// A function (not a module-level constant) so labels re-evaluate against the current language —
// see userBar.js's statusOptions() for why a plain top-level object built with t() would freeze.
function qualityLabel() {
  return { good: t('voice.goodConnection'), ok: t('voice.unstableConnection'), poor: t('voice.poorConnection') };
}

// ICE servers for every peer connection: the operator's external STUN/TURN entries plus the
// built-in server's with a short-lived credential (GET /api/voice/ice, empty unless the admin
// opted in, so a default install stays LAN-only). Cached until shortly before the credential expires.
let iceCache = null; // { servers, expires }
async function getIceServers() {
  if (iceCache && iceCache.expires > Date.now()) return iceCache.servers;
  let servers;
  let ttlMs = 3_600_000;
  try {
    const res = await api.voiceIce();
    servers = res.iceServers || [];
    if (res.ttlMs) ttlMs = res.ttlMs;
  } catch {
    try { servers = (await api.config()).iceServers || []; } catch { servers = []; }
  }
  iceCache = { servers, expires: Date.now() + Math.max(60_000, ttlMs - 600_000) };
  return servers;
}
export const resetIceServers = () => { iceCache = null; };

// Discord-shaped voice channel: WebRTC mesh (every participant connects directly to every
// other participant), signalled over the existing app WebSocket. Opus is not a separate
// library: it's compiled into the browser/Electron's native WebRTC stack, nothing to vendor.
// Pass either { serverId, channelId, channelName } for a server voice channel, or { dmId, dmName }
// for an invite-only DM/group call — same mesh/signalling code, just a different room scope.
// The one voice room this client is currently joined to. Its instance outlives the view that
// mounted it: navigating elsewhere only detaches the UI (see destroy()), the call keeps running
// until the user presses Leave.
let activeCall = null; // { key, attach(container), leave() }
export const leaveActiveCall = () => activeCall?.leave();
const callKey = ({ dmId, channelId }) => (dmId ? `dm:${dmId}` : `ch:${channelId}`);

export function mountVoiceChannel(container, opts) {
  if (activeCall && activeCall.key === callKey(opts)) return activeCall.attach(container);
  return createVoiceMount(container, opts);
}

function createVoiceMount(container, { serverId, channelId, channelName, dmId, dmName, sounds, channelType, canManageChannel, canModerateVoice, voiceQuality, mobile }) {
  const isDm = !!dmId;
  const key = callKey({ dmId, channelId });
  const roomLabel = isDm ? (dmName || t('voice.thisCallFallback')) : channelName;
  // Stage channels layer a speaker/audience split on top of the same voice room a regular
  // channel uses — never true for a DM (stages are server-scoped, never wired up there).
  const isStage = !isDm && channelType === 'stage';
  let speakerIds = new Set();
  let raisedHandIds = new Set();
  const amSpeaker = (userId) => !isStage || speakerIds.has(userId);
  // Every outbound ws message and every inbound ws:voice_state/ws:voice_signal filter needs to
  // agree on which room this mount is — scopePayload() is the single source of truth for that.
  function scopePayload() {
    return isDm ? { dmChannelId: dmId } : { channelId };
  }
  function matchesThisRoom(payload) {
    return isDm ? payload.dmChannelId === dmId : payload.channelId === channelId;
  }
  let joined = false;
  let detached = false; // view is gone but the call lives on; torn down for real on leave()
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
  let pttActive = false; // key currently held, only meaningful when voicePrefs().pttEnabled
  let rawStream = null; // straight from getUserMedia, kept only to stop() its tracks
  let sendTrack = null; // post-gain track actually attached to peer connections
  let audioCtx = null;
  let gainNode = null;
  let denoiser = null;
  let localMeter = null;
  let roster = []; // last known participants (public user objects), including self once joined
  const peers = new Map(); // userId -> { pc, audioEl, analyser, speaking, volume, quality, cameraStream, screenStream }
  let meterTimer = null;
  let statsTimer = null;

  // Camera/screen-share: separate optional video tracks layered onto the same mesh, added/removed
  // from every peer connection independently of the audio track above. Since a track's `.id` is
  // preserved end-to-end by WebRTC (signaled in the SDP), a lightweight `media-announce` message
  // sent just before renegotiating tells each peer "the next video track with this id is my
  // camera/screen" — avoids needing any mid-negotiation-order bookkeeping across N independent
  // peer connections (this is a full mesh, not an SFU, so mid assignment isn't even guaranteed
  // consistent across peers).
  let cameraTrack = null;
  let cameraFacing = 'user';
  let screenTrack = null;
  let localCameraStream = null;
  let localScreenStream = null;
  // userId -> ['camera'|'screen', ...] FIFO queue, consumed one entry per incoming video ontrack
  // from that peer. Deliberately NOT keyed by track id: proven live (two-browser WebRTC test,
  // 2026-09-06) that a video track's id is *not* reliably preserved end-to-end once a peer
  // connection has removed and re-added a video track — Chrome appears to reuse the existing
  // (now-inactive) transceiver/m-line slot for the next added video track, and the receiver's
  // RTCTrackEvent.track.id in that case does not match the sender's original track.id, contrary
  // to the naive reading of the WebRTC spec's msid-preservation guarantee. Ordering is what's
  // actually reliable here: media-announce is always sent (and arrives, same WS connection, FIFO)
  // strictly before the renegotiation offer that carries the track it describes, so a simple
  // per-peer queue popped in order is correct without needing id matching at all.
  const pendingRemoteMedia = new Map();

  render();

  const offVoiceState = bus.on('ws:voice_state', (payload) => {
    if (!matchesThisRoom(payload)) return;
    applyRoster(payload.participants);
  });
  const offVoiceSignal = bus.on('ws:voice_signal', (payload) => {
    if (!matchesThisRoom(payload)) return;
    handleSignal(payload.fromUserId, payload.signal);
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
    updateSendEnabled();
    render();
  });
  // A WS drop closes our server-side voice membership (voice.leaveAll on socket close) and every
  // other participant tears down their peer connection to us — so on reconnect we're a ghost:
  // still marked joined locally with peer connections nobody else recognizes. Tear ours down too
  // and re-announce, reusing the mic stream we already have.
  const offWsOpen = bus.on('ws:open', () => {
    if (!joined) return;
    for (const id of [...peers.keys()]) closePeer(id);
    // applyRoster only offers to others when it sees us transition from absent to present
    // (`!iWasIn && iAmIn`); our cached roster still has us in it from before the drop, so without
    // this it'd conclude we were never gone and silently skip re-offering to anyone.
    roster = roster.filter((u) => u.id !== state.me.id);
    ws.send({ type: 'voice_join', ...scopePayload() });
  });
  // Server-side backstop for the one-call rule (e.g. already in a call from another tab/device).
  const offJoinDenied = bus.on('ws:voice_join_denied', (payload) => {
    if (!joined || !matchesThisRoom(payload)) return;
    toast(t('voice.joinDeniedToast'), { type: 'error' });
    cleanupAll();
    joined = false;
    if (activeCall?.key === key) activeCall = null;
    roster = roster.filter((u) => u.id !== state.me.id);
    setVoiceState({ serverId: null, channelId: null, channelName: null, dmId: null, dmName: null });
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
          ${joined && prefs.pttEnabled
            ? `<span class="vc-ptt-hint" title="${t('voice.pttHintTitle')}">${icons.mic(16)} ${t('voice.holdKeyToTalk', { key: keyLabel(prefs.pttKey) })}</span>`
            : ''}
          ${joined
            ? `${!isStage || amSpeaker(state.me.id)
                ? `<button class="btn-icon voice-ctl ${muted ? 'active-danger' : ''}" id="vc-mute" ${prefs.pttEnabled || forceMuted ? 'disabled' : ''} title="${forceMuted ? t('voice.mutedByModeratorTitle') : muted ? t('userBar.unmute') : t('userBar.mute')}">${muted ? icons.micOff(20) : icons.mic(20)}</button>`
                : `<button class="btn-icon voice-ctl ${raisedHandIds.has(state.me.id) ? 'active' : ''}" id="vc-raise-hand" title="${raisedHandIds.has(state.me.id) ? t('voice.lowerHandTitle') : t('voice.raiseHandTitle')}">${icons.hand(20)}</button>`}
               <button class="btn-icon voice-ctl ${deafened ? 'active-danger' : ''}" id="vc-deafen" title="${deafened ? t('userBar.undeafen') : t('userBar.deafen')}">${deafened ? icons.headphonesOff(20) : icons.headphones(20)}</button>
               ${!isStage || amSpeaker(state.me.id) ? `
                 <button class="btn-icon voice-ctl ${cameraTrack ? 'active' : ''}" id="vc-camera" title="${cameraTrack ? t('voice.turnOffCameraTitle') : t('voice.turnOnCameraTitle')}">${cameraTrack ? icons.camera(20) : icons.videoOff(20)}</button>
                 ${mobile || window.dismeshClient?.isAndroidWebView ? (cameraTrack ? `<button class="btn-icon voice-ctl" id="vc-flip-camera" title="${t('voice.flipCameraTitle')}">${icons.refresh(20)}</button>` : '') : `<button class="btn-icon voice-ctl ${screenTrack ? 'active' : ''}" id="vc-screenshare" title="${screenTrack ? t('voice.stopScreenShareTitle') : t('voice.shareScreenTitle')}">${icons.monitor(20)}</button>`}` : ''}
               ${!isDm ? `<button class="btn-icon voice-ctl" id="vc-soundboard" title="${t('voice.soundboardTitle')}">${icons.music(20)}</button>` : ''}
               ${isStage && amSpeaker(state.me.id) ? `<button class="btn btn-secondary" id="vc-step-down">${icons.hand(16)} ${t('voice.stepDownButton')}</button>` : ''}
               <button class="btn btn-danger" id="vc-leave">${icons.phoneOff(16)} ${t('voice.leaveButton')}</button>`
            : `<button class="btn btn-primary" id="vc-join">${icons.headphones(16)} ${isStage ? t('voice.joinStageButton') : t('voice.joinVoiceButton')}</button>`}
        </div>
      </div>`;

    renderGrid();

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
      media = `<div class="voice-tile-avatar">${avatarHtml(u, 96)}${!mine ? `<span class="vc-quality vc-quality-${peer?.quality || 'good'}" title="${qualityLabel()[peer?.quality || 'good']}"></span>` : ''}${mutedByMod ? `<span class="vc-mod-muted-badge" title="${t('voice.mutedByModeratorTitle')}">${icons.micOff(11)}</span>` : ''}</div>`;
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
    const master = voicePrefs.get().outputVolume;
    peer.audioEl.volume = deafened ? 0 : Math.max(0, Math.min(1, master * (peer.volume ?? 1)));
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
    const audioEl = new Audio(sound.audioPath);
    audioEl.volume = voicePrefs.get().outputVolume;
    applySinkId(audioEl);
    audioEl.play().catch(() => {}); // autoplay can be blocked before the user's first interaction on the page — silently drop rather than surface an error for background playback
  }

  function onPrefsChanged() {
    if (!joined) { render(); return; }
    applyOutputVolumes();
    for (const peer of peers.values()) if (peer.audioEl) applySinkId(peer.audioEl);
    rebuildInputGraph();
    updateSendEnabled();
    render();
  }

  // Builds the mic -> GainNode -> MediaStreamAudioDestinationNode chain. The track handed to
  // peer connections is the destination node's track (post-gain), never the raw mic track, so
  // the input-volume slider actually affects what others hear, not just local monitoring.
  async function rebuildInputGraph() {
    if (!joined) return;
    const prefs = voicePrefs.get();
    let newRaw;
    try {
      newRaw = await navigator.mediaDevices.getUserMedia({
        audio: prefs.inputDeviceId ? { deviceId: { exact: prefs.inputDeviceId } } : true, video: false,
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
    head.connect(gainNode);
    gainNode.connect(dest);
    sendTrack = dest.stream.getAudioTracks()[0];
    updateSendEnabled();
    for (const { pc } of peers.values()) {
      const sender = pc.getSenders().find((s) => s.track?.kind === 'audio');
      if (sender) sender.replaceTrack(sendTrack);
    }
    startLocalMeter(source);
  }

  function teardownInputGraph() {
    if (rawStream) for (const t of rawStream.getTracks()) t.stop();
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
    if (!sendTrack) return;
    // Audience members can never transmit, regardless of their own mute toggle — the only way
    // out is a speaker promoting them (stage_invite_speaker), not anything they control locally.
    if (isStage && !amSpeaker(state.me.id)) { sendTrack.enabled = false; return; }
    if (forceMuted) { sendTrack.enabled = false; return; }
    const prefs = voicePrefs.get();
    if (deafened || muted) { sendTrack.enabled = false; return; }
    if (prefs.pttEnabled) { sendTrack.enabled = pttActive; return; }
    if (prefs.vadEnabled) return; // left alone — the meter tick opens/closes it off the live level
    sendTrack.enabled = true;
  }

  function applyRoster(next) {
    const prevIds = new Set(roster.map((u) => u.id));
    const nextIds = new Set(next.map((u) => u.id));
    const iWasIn = prevIds.has(state.me.id);
    const iAmIn = nextIds.has(state.me.id);

    // Newcomer-offers-to-existing-members convention: on the roster update where my own join
    // lands, I'm the newcomer — I initiate offers to everyone already there. On every other
    // update, any new arrival is someone else joining after me, so I just wait for their offer.
    if (!iWasIn && iAmIn) {
      for (const u of next) {
        if (u.id !== state.me.id) initiateOfferTo(u.id);
      }
    }

    for (const id of prevIds) {
      if (!nextIds.has(id) && id !== state.me.id) closePeer(id);
    }

    roster = next;
    const myEntry = next.find((u) => u.id === state.me.id);
    const nowForceMuted = !!myEntry?.mutedByMod;
    if (nowForceMuted !== forceMuted) {
      forceMuted = nowForceMuted;
      if (forceMuted && !muted) { muted = true; setVoiceState({ muted }); }
      updateSendEnabled();
      if (forceMuted) toast(t('voice.moderatorMutedYouToast'), { type: 'error' });
      render();
      return;
    }
    renderGrid();
  }

  async function join() {
    if (joined) return;
    if (activeCall && activeCall.key !== key) {
      toast(t('voice.alreadyInCallToast', { name: state.voice.dmName || state.voice.channelName || '' }), { type: 'error' });
      return;
    }
    joined = true;
    await rebuildInputGraph();
    if (!sendTrack) { joined = false; return; }
    activeCall = { key, attach, leave: () => { if (joined) leave(); } };
    ws.send({ type: 'voice_join', ...scopePayload() });
    registerPtt();
    startStatsPolling();
    setVoiceState(isDm ? { dmId, dmName } : { serverId, channelId, channelName });
    render();
  }

  function leave() {
    ws.send({ type: 'voice_leave', ...scopePayload() });
    cleanupAll();
    joined = false;
    if (activeCall?.key === key) activeCall = null;
    deafened = false;
    roster = roster.filter((u) => u.id !== state.me.id);
    // Mute/deafen themselves are left alone — like Discord, that's a standing preference, not
    // something a call ending should reset.
    setVoiceState({ serverId: null, channelId: null, channelName: null, dmId: null, dmName: null });
    if (detached) { destroy(); return; }
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
    if (cameraTrack) {
      for (const [uid, peer] of peers) {
        const sender = peer.pc.getSenders().find((s) => s.track === cameraTrack);
        if (sender) peer.pc.removeTrack(sender);
        ws.send({ type: 'voice_signal', ...scopePayload(), toUserId: uid, signal: { kind: 'media-announce', media: 'camera', active: false } });
      }
      cameraTrack.stop();
      cameraTrack = null;
      localCameraStream = null;
      await Promise.all([...peers.keys()].map(renegotiateWith));
      render();
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: mobile ? { facingMode: cameraFacing } : true });
    } catch {
      toast(t('voice.couldNotAccessCamera'), { type: 'error' });
      return;
    }
    cameraTrack = stream.getVideoTracks()[0];
    localCameraStream = stream;
    const thisTrack = cameraTrack;
    // The OS/browser "stop sharing"-equivalent for a camera is unplugging it or revoking the
    // permission mid-call — same graceful-stop handling screen share needs for its own OS-level
    // stop button, so both funnel through the same toggle-off path here. The `cameraTrack ===
    // thisTrack` guard stops a stale event from an already-replaced track re-triggering the
    // toggle-off path a second time.
    cameraTrack.onended = () => { if (cameraTrack === thisTrack) toggleCamera(); };
    for (const [uid, peer] of peers) { peer.pc.addTrack(cameraTrack, new MediaStream([cameraTrack])); announceMediaTo(uid, 'camera', cameraTrack); }
    await Promise.all([...peers.keys()].map(renegotiateWith));
    render();
  }

  // Phones usually cannot open two cameras at once, so the old track is stopped before the new one opens.
  async function flipCamera() {
    if (!cameraTrack) return;
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
      for (const [uid, peer] of peers) {
        const sender = peer.pc.getSenders().find((s) => s.track === old);
        if (sender) peer.pc.removeTrack(sender);
        ws.send({ type: 'voice_signal', ...scopePayload(), toUserId: uid, signal: { kind: 'media-announce', media: 'camera', active: false } });
      }
      await Promise.all([...peers.keys()].map(renegotiateWith));
      render();
      return;
    }
    const track = stream.getVideoTracks()[0];
    for (const peer of peers.values()) {
      const sender = peer.pc.getSenders().find((s) => s.track === old);
      if (sender) await sender.replaceTrack(track);
    }
    cameraTrack = track; localCameraStream = stream; cameraFacing = next;
    track.onended = () => { if (cameraTrack === track) toggleCamera(); };
    render();
  }

  async function toggleScreenShare() {
    if (screenTrack) {
      for (const [uid, peer] of peers) {
        const sender = peer.pc.getSenders().find((s) => s.track === screenTrack);
        if (sender) peer.pc.removeTrack(sender);
        ws.send({ type: 'voice_signal', ...scopePayload(), toUserId: uid, signal: { kind: 'media-announce', media: 'screen', active: false } });
      }
      screenTrack.stop();
      screenTrack = null;
      localScreenStream = null;
      await Promise.all([...peers.keys()].map(renegotiateWith));
      render();
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    } catch {
      return; // user cancelled the picker — not an error worth a toast
    }
    screenTrack = stream.getVideoTracks()[0];
    localScreenStream = stream;
    const thisTrack = screenTrack;
    // Fires when the user clicks the browser/OS's own native "Stop sharing" control, not just
    // when they click our button — same toggle-off path either way keeps state consistent.
    screenTrack.onended = () => { if (screenTrack === thisTrack) toggleScreenShare(); };
    for (const [uid, peer] of peers) { peer.pc.addTrack(screenTrack, new MediaStream([screenTrack])); announceMediaTo(uid, 'screen', screenTrack); }
    await Promise.all([...peers.keys()].map(renegotiateWith));
    render();
  }

  function onPttKeyDown(e) {
    if (isTypingTarget(e.target)) return;
    const prefs = voicePrefs.get();
    if (!prefs.pttEnabled || e.code !== prefs.pttKey || pttActive) return;
    pttActive = true;
    updateSendEnabled();
  }
  function onPttKeyUp(e) {
    const prefs = voicePrefs.get();
    if (!prefs.pttEnabled || e.code !== prefs.pttKey) return;
    pttActive = false;
    updateSendEnabled();
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
    pttActive = false;
  }

  function preferOpus(pc) {
    try {
      const transceiver = pc.getTransceivers().find((t) => t.sender?.track?.kind === 'audio');
      if (!transceiver || !transceiver.setCodecPreferences || !RTCRtpSender.getCapabilities) return;
      const caps = RTCRtpSender.getCapabilities('audio');
      if (!caps) return;
      const opus = caps.codecs.filter((c) => c.mimeType.toLowerCase() === 'audio/opus');
      const rest = caps.codecs.filter((c) => c.mimeType.toLowerCase() !== 'audio/opus');
      if (opus.length) transceiver.setCodecPreferences([...opus, ...rest]);
    } catch { /* setCodecPreferences isn't universally supported — Opus is already the default */ }
  }

  async function setTunedLocal(pc, desc) {
    await pc.setLocalDescription({ type: desc.type, sdp: tuneOpusSdp(desc.sdp, quality) });
    applySenderQuality(pc);
  }

  function applySenderQuality(pc) {
    const sender = pc.getSenders().find((s) => s.track?.kind === 'audio');
    if (!sender) return;
    try {
      const params = sender.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = voiceQualityPreset(quality).bitrate;
      sender.setParameters(params).catch(() => {});
    } catch { /* sender not negotiated yet; the post-setLocalDescription call covers it */ }
  }

  function announceMediaTo(userId, media, track) {
    ws.send({ type: 'voice_signal', ...scopePayload(), toUserId: userId, signal: { kind: 'media-announce', media, trackId: track.id, active: true } });
  }

  async function createPeer(userId) {
    const pc = new RTCPeerConnection({ iceServers: await getIceServers() });
    pc.onicecandidate = (e) => {
      if (e.candidate) ws.send({ type: 'voice_signal', ...scopePayload(), toUserId: userId, signal: { kind: 'ice', candidate: e.candidate.toJSON() } });
    };
    pc.ontrack = (e) => {
      if (e.track.kind === 'audio') { attachRemoteAudio(userId, e.streams[0]); return; }
      const queue = pendingRemoteMedia.get(userId);
      const media = queue?.shift() || 'camera';
      attachRemoteVideo(userId, media, e.streams[0]);
      e.track.onended = () => detachRemoteVideo(userId, media);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') closePeer(userId);
    };
    if (sendTrack) pc.addTrack(sendTrack, new MediaStream([sendTrack]));
    if (cameraTrack) { pc.addTrack(cameraTrack, new MediaStream([cameraTrack])); announceMediaTo(userId, 'camera', cameraTrack); }
    if (screenTrack) { pc.addTrack(screenTrack, new MediaStream([screenTrack])); announceMediaTo(userId, 'screen', screenTrack); }
    peers.set(userId, { pc, audioEl: null, speaking: false, volume: 1, quality: 'good', cameraStream: null, screenStream: null, makingOffer: false });
    return pc;
  }

  async function initiateOfferTo(userId) {
    if (peers.has(userId)) return;
    const pc = await createPeer(userId);
    const peer = peers.get(userId);
    peer.makingOffer = true;
    try {
      const offer = await pc.createOffer();
      preferOpus(pc);
      await setTunedLocal(pc, offer);
      ws.send({ type: 'voice_signal', ...scopePayload(), toUserId: userId, signal: { kind: 'offer', sdp: pc.localDescription.sdp } });
    } finally {
      peer.makingOffer = false;
    }
  }

  // Re-offers on an already-established connection — used whenever a local track is added or
  // removed after the initial join (camera/screen-share toggles). handleSignal's 'offer' branch
  // already reuses an existing pc rather than assuming a first-ever offer, so no changes needed
  // on the receiving side to support this.
  async function renegotiateWith(userId) {
    const peer = peers.get(userId);
    if (!peer) return;
    peer.makingOffer = true;
    try {
      const offer = await peer.pc.createOffer();
      preferOpus(peer.pc);
      await setTunedLocal(peer.pc, offer);
      ws.send({ type: 'voice_signal', ...scopePayload(), toUserId: userId, signal: { kind: 'offer', sdp: peer.pc.localDescription.sdp } });
    } finally {
      peer.makingOffer = false;
    }
  }

  async function handleSignal(fromUserId, signal) {
    if (!signal || !signal.kind) return;
    if (signal.kind === 'offer') {
      const existing = peers.get(fromUserId);
      const pc = existing ? existing.pc : await createPeer(fromUserId);
      const peer = peers.get(fromUserId);
      // Perfect-negotiation glare handling: both sides can renegotiate at once (e.g. both
      // toggling camera around the same time). Politeness is decided the same deterministic way
      // on both ends (higher user id is polite) so exactly one side backs off - the impolite side
      // ignores a colliding incoming offer and keeps its own outstanding one; the polite side
      // rolls its own back (implicit local rollback) and accepts the incoming offer instead.
      // Without this, a later-arriving answer for a since-rolled-back offer fails outright
      // ("Failed to set remote answer sdp: Called in wrong state: stable"), permanently breaking
      // that peer's connection instead of just settling on one side's renegotiation.
      const offerCollision = peer.makingOffer || pc.signalingState !== 'stable';
      const polite = state.me.id > fromUserId;
      if (offerCollision && !polite) return; // impolite: ignore their offer, ours will win
      if (offerCollision) await pc.setLocalDescription({ type: 'rollback' });
      await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
      const answer = await pc.createAnswer();
      preferOpus(pc);
      await setTunedLocal(pc, answer);
      ws.send({ type: 'voice_signal', ...scopePayload(), toUserId: fromUserId, signal: { kind: 'answer', sdp: pc.localDescription.sdp } });
    } else if (signal.kind === 'answer') {
      const peer = peers.get(fromUserId);
      // A stale answer for an offer we already rolled back (we were the polite side in a glare)
      // has nothing to apply to - signalingState is 'stable' by then, not 'have-local-offer'.
      if (peer && peer.pc.signalingState === 'have-local-offer') await peer.pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
    } else if (signal.kind === 'ice' && signal.candidate) {
      const peer = peers.get(fromUserId);
      if (peer) { try { await peer.pc.addIceCandidate(signal.candidate); } catch { /* stray late candidate, ignore */ } }
    } else if (signal.kind === 'media-announce') {
      if (signal.active) {
        if (!pendingRemoteMedia.has(fromUserId)) pendingRemoteMedia.set(fromUserId, []);
        pendingRemoteMedia.get(fromUserId).push(signal.media);
      } else {
        detachRemoteVideo(fromUserId, signal.media);
      }
    }
  }

  function attachRemoteAudio(userId, stream) {
    const peer = peers.get(userId);
    if (!peer) return;
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
    const peer = peers.get(userId);
    if (!peer) return;
    if (media === 'camera') peer.cameraStream = stream; else peer.screenStream = stream;
    renderGrid();
  }

  function detachRemoteVideo(userId, media) {
    const peer = peers.get(userId);
    if (!peer) return;
    if (media === 'camera') peer.cameraStream = null; else peer.screenStream = null;
    renderGrid();
  }

  function closePeer(userId) {
    const peer = peers.get(userId);
    if (!peer) return;
    peer.pc.close();
    peer.audioEl?.remove();
    peer.analyser?.ctx?.close?.().catch(() => {});
    peers.delete(userId);
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
    if (joined) {
      const prefs = voicePrefs.get();
      let level;
      if (localMeter) level = readLevel(localMeter);
      if (prefs.vadEnabled && !prefs.pttEnabled && !deafened && !muted && sendTrack && level !== undefined) {
        sendTrack.enabled = level > prefs.vadThreshold;
      }
      updateSpeakingIndicator(state.me.id, localMeter, !sendTrack?.enabled, prefs.vadThreshold);
    }
    for (const [id, peer] of peers) updateSpeakingIndicator(id, peer.analyser, false);
  }, 200);

  function startStatsPolling() {
    statsTimer = setInterval(pollStats, 2000);
  }

  async function pollStats() {
    for (const [id, peer] of peers) {
      try {
        const report = await peer.pc.getStats();
        let rtt = 0, lost = 0, received = 0;
        report.forEach((stat) => {
          if (stat.type === 'candidate-pair' && (stat.state === 'succeeded') && stat.currentRoundTripTime != null) {
            rtt = Math.max(rtt, stat.currentRoundTripTime * 1000);
          }
          if (stat.type === 'inbound-rtp' && stat.kind === 'audio') {
            lost = stat.packetsLost ?? 0;
            received = stat.packetsReceived ?? 0;
          }
        });
        const lossRatio = received > 0 ? lost / (lost + received) : 0;
        const quality = rtt < 150 && lossRatio < 0.02 ? 'good' : rtt < 300 && lossRatio < 0.05 ? 'ok' : 'poor';
        if (peer.quality !== quality) {
          peer.quality = quality;
          const dot = container.querySelector(`.voice-tile[data-uid="${id}"] .vc-quality`);
          if (dot) { dot.className = `vc-quality vc-quality-${quality}`; dot.title = qualityLabel()[quality]; }
        }
      } catch { /* stats unavailable mid-negotiation — try again next tick */ }
    }
  }

  function cleanupAll() {
    for (const id of [...peers.keys()]) closePeer(id);
    teardownInputGraph();
    unregisterPtt();
    clearInterval(statsTimer);
    cameraTrack?.stop();
    screenTrack?.stop();
    cameraTrack = null;
    screenTrack = null;
    localCameraStream = null;
    localScreenStream = null;
    pendingRemoteMedia.clear();
  }

  function attach(newContainer) {
    container = newContainer;
    detached = false;
    render();
    return handle;
  }

  function destroy() {
    if (joined) { detached = true; return; }
    offVoiceState();
    offVoiceSignal();
    offSoundboard();
    offStageState();
    offWsOpen();
    offJoinDenied();
    offPrefsChanged();
    offGlobalVoice();
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    clearInterval(meterTimer);
    cleanupAll();
  }

  const handle = { destroy, leave: () => { if (joined) leave(); }, isJoined: () => joined };
  return handle;
}
