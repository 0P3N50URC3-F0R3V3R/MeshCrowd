import { tuneOpusSdp, voiceQualityPreset } from './voiceQuality.js';
import { shouldAcceptRemoteCandidate, connectionPath } from './iceUtil.js';

// Full-mesh voice engine: every participant connects directly to every other participant,
// signalled over the app WebSocket (`voice_signal`). Opus is not a separate library: it's compiled
// into the browser/Electron's native WebRTC stack, nothing to vendor. No DOM access here: the view
// (views/voice.js) owns audio elements, meters and tiles and is told about remote media via ctx.hooks.
export function createMeshEngine(ctx) {
  const { me, ws, scopePayload, getIceConfig, hooks } = ctx;
  const peers = new Map(); // userId -> { pc, makingOffer, pendingIce, lanNetworks, restarts, restartTimer }
  let rosterIds = new Set();
  let audioTrack = null;
  let cameraTrack = null;
  let screenTrack = null;
  let stopped = false;

  // Camera/screen-share: separate optional video tracks layered onto the same mesh, added/removed
  // from every peer connection independently of the audio track. A lightweight `media-announce`
  // message sent just before renegotiating tells each peer "the next video track is my
  // camera/screen" — avoids needing any mid-negotiation-order bookkeeping across N independent
  // peer connections (this is a full mesh, not an SFU, so mid assignment isn't even guaranteed
  // consistent across peers).
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

  function sendSignal(toUserId, signal) {
    ws.send({ type: 'voice_signal', ...scopePayload(), toUserId, signal });
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
    await pc.setLocalDescription({ type: desc.type, sdp: tuneOpusSdp(desc.sdp, ctx.quality()) });
    applySenderQuality(pc);
  }

  function applySenderQuality(pc) {
    const sender = pc.getSenders().find((s) => s.track?.kind === 'audio');
    if (!sender) return;
    try {
      const params = sender.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = voiceQualityPreset(ctx.quality()).bitrate;
      sender.setParameters(params).catch(() => {});
    } catch { /* sender not negotiated yet; the post-setLocalDescription call covers it */ }
  }

  function announceMediaTo(userId, media, track) {
    sendSignal(userId, { kind: 'media-announce', media, trackId: track.id, active: true });
  }

  async function createPeer(userId) {
    const ice = await getIceConfig();
    if (stopped) return null;
    const pc = new RTCPeerConnection({ iceServers: ice.servers, iceCandidatePoolSize: 2 });
    pc.onicecandidate = (e) => {
      if (e.candidate) sendSignal(userId, { kind: 'ice', candidate: e.candidate.toJSON() });
    };
    pc.ontrack = (e) => {
      if (e.track.kind === 'audio') { if (peers.has(userId)) hooks.attachAudio(userId, e.streams[0]); return; }
      const queue = pendingRemoteMedia.get(userId);
      const media = queue?.shift() || 'camera';
      if (peers.has(userId)) hooks.attachVideo(userId, media, e.streams[0]);
      e.track.onended = () => detachVideo(userId, media);
    };
    // A dropped path (Wi-Fi roam, VPN reconnect) is retried with an ICE restart, which gathers
    // fresh candidates and falls back to STUN/TURN if the direct path is gone; only after repeated
    // failures is the peer closed.
    pc.onconnectionstatechange = () => {
      const peer = peers.get(userId);
      if (!peer || peer.pc !== pc) return;
      clearTimeout(peer.restartTimer);
      if (pc.connectionState === 'connected') peer.restarts = 0;
      else if (pc.connectionState === 'disconnected') peer.restartTimer = setTimeout(() => restartIceFor(userId), 4000);
      else if (pc.connectionState === 'failed') restartIceFor(userId);
      else if (pc.connectionState === 'closed') closePeer(userId);
    };
    if (audioTrack) pc.addTrack(audioTrack, new MediaStream([audioTrack]));
    if (cameraTrack) { pc.addTrack(cameraTrack, new MediaStream([cameraTrack])); announceMediaTo(userId, 'camera', cameraTrack); }
    if (screenTrack) { pc.addTrack(screenTrack, new MediaStream([screenTrack])); announceMediaTo(userId, 'screen', screenTrack); }
    peers.set(userId, { pc, makingOffer: false, pendingIce: [], lanNetworks: ice.lanNetworks, restarts: 0, restartTimer: null });
    return pc;
  }

  async function restartIceFor(userId) {
    const peer = peers.get(userId);
    if (!peer || peer.pc.connectionState === 'connected' || peer.pc.connectionState === 'closed') return;
    if (peer.restarts >= 3) { closePeer(userId); return; }
    if (peer.makingOffer || peer.pc.signalingState !== 'stable') { peer.restartTimer = setTimeout(() => restartIceFor(userId), 3000); return; }
    peer.restarts++;
    peer.pc.restartIce();
    try { await renegotiateWith(userId); } catch { /* next state change retries */ }
    peer.restartTimer = setTimeout(() => restartIceFor(userId), 8000);
  }

  async function flushPendingIce(peer) {
    const queued = peer.pendingIce.splice(0);
    for (const c of queued) { try { await peer.pc.addIceCandidate(c); } catch { /* stale candidate */ } }
  }

  async function initiateOfferTo(userId) {
    if (peers.has(userId)) return;
    const pc = await createPeer(userId);
    if (!pc) return;
    const peer = peers.get(userId);
    peer.makingOffer = true;
    try {
      const offer = await pc.createOffer();
      preferOpus(pc);
      await setTunedLocal(pc, offer);
      sendSignal(userId, { kind: 'offer', sdp: pc.localDescription.sdp });
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
      sendSignal(userId, { kind: 'offer', sdp: peer.pc.localDescription.sdp });
    } finally {
      peer.makingOffer = false;
    }
  }

  async function handleSignal(fromUserId, signal) {
    if (!signal || !signal.kind) return;
    if (signal.kind === 'offer') {
      const existing = peers.get(fromUserId);
      const pc = existing ? existing.pc : await createPeer(fromUserId);
      if (!pc) return;
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
      const polite = me > fromUserId;
      if (offerCollision && !polite) return; // impolite: ignore their offer, ours will win
      if (offerCollision) await pc.setLocalDescription({ type: 'rollback' });
      await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
      await flushPendingIce(peer);
      const answer = await pc.createAnswer();
      preferOpus(pc);
      await setTunedLocal(pc, answer);
      sendSignal(fromUserId, { kind: 'answer', sdp: pc.localDescription.sdp });
    } else if (signal.kind === 'answer') {
      const peer = peers.get(fromUserId);
      // A stale answer for an offer we already rolled back (we were the polite side in a glare)
      // has nothing to apply to - signalingState is 'stable' by then, not 'have-local-offer'.
      if (peer && peer.pc.signalingState === 'have-local-offer') {
        await peer.pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
        await flushPendingIce(peer);
      }
    } else if (signal.kind === 'ice' && signal.candidate) {
      const peer = peers.get(fromUserId);
      if (!peer || !shouldAcceptRemoteCandidate(signal.candidate, peer.lanNetworks)) return;
      // Candidates can outrun the offer/answer they belong to; adding one before the remote
      // description is set throws, so hold it until then.
      if (!peer.pc.remoteDescription) { peer.pendingIce.push(signal.candidate); return; }
      try { await peer.pc.addIceCandidate(signal.candidate); } catch { /* stray late candidate, ignore */ }
    } else if (signal.kind === 'media-announce') {
      if (signal.active) {
        if (!pendingRemoteMedia.has(fromUserId)) pendingRemoteMedia.set(fromUserId, []);
        pendingRemoteMedia.get(fromUserId).push(signal.media);
      } else {
        detachVideo(fromUserId, signal.media);
      }
    }
  }

  function detachVideo(userId, media) {
    if (peers.has(userId)) hooks.detachVideo(userId, media);
  }

  function closePeer(userId) {
    const peer = peers.get(userId);
    if (!peer) return;
    clearTimeout(peer.restartTimer);
    peer.pc.close();
    peers.delete(userId);
    hooks.closeRemote(userId);
  }

  // Newcomer-offers-to-existing-members convention: on the roster update where my own join
  // lands, I'm the newcomer — I initiate offers to everyone already there. On every other
  // update, any new arrival is someone else joining after me, so I just wait for their offer.
  function onRoster(userIds) {
    const nextIds = new Set(userIds);
    if (!rosterIds.has(me) && nextIds.has(me)) {
      for (const id of userIds) {
        if (id !== me) initiateOfferTo(id);
      }
    }
    for (const id of rosterIds) {
      if (!nextIds.has(id) && id !== me) closePeer(id);
    }
    rosterIds = nextIds;
  }

  async function setLocalTrack(media, track) {
    if (media === 'audio') {
      audioTrack = track;
      for (const { pc } of peers.values()) {
        const sender = pc.getSenders().find((s) => s.track?.kind === 'audio');
        if (sender) sender.replaceTrack(track);
      }
      return;
    }
    const old = media === 'camera' ? cameraTrack : screenTrack;
    const set = (t) => { if (media === 'camera') cameraTrack = t; else screenTrack = t; };
    if (old && track) {
      for (const peer of peers.values()) {
        const sender = peer.pc.getSenders().find((s) => s.track === old);
        if (sender) await sender.replaceTrack(track);
      }
      set(track);
      return;
    }
    if (old) {
      set(null);
      for (const [uid, peer] of peers) {
        const sender = peer.pc.getSenders().find((s) => s.track === old);
        if (sender) peer.pc.removeTrack(sender);
        sendSignal(uid, { kind: 'media-announce', media, active: false });
      }
    } else if (track) {
      set(track);
      for (const [uid, peer] of peers) { peer.pc.addTrack(track, new MediaStream([track])); announceMediaTo(uid, media, track); }
    } else {
      return;
    }
    await Promise.all([...peers.keys()].map(renegotiateWith));
  }

  async function pollStats() {
    const out = new Map();
    for (const [id, peer] of peers) {
      try {
        const report = await peer.pc.getStats();
        const path = connectionPath(report);
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
        if (peers.get(id) === peer) out.set(id, { quality, path });
      } catch { /* stats unavailable mid-negotiation — try again next tick */ }
    }
    return out;
  }

  function stop() {
    stopped = true;
    for (const id of [...peers.keys()]) closePeer(id);
    pendingRemoteMedia.clear();
    rosterIds = new Set();
  }

  return {
    start: async () => {},
    stop,
    setLocalTrack,
    onRoster,
    handleSignal,
    pollStats,
  };
}
