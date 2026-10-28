import { bus } from '../../js/bus.js';
import { state } from '../../js/state.js';
import { mountVoiceChannel } from '../../js/views/voice.js';
import { androidBridge } from './androidBridge.js';
import { roomKey, isJoinedTo } from './callRoom.mjs';

// One voice room at a time, mounted in a detached container so the call survives leaving its
// screen (the call bar brings it back). The container is re-parented into whichever voice screen
// is on top.
let session = null; // { key, params, label, container, handle, visible, speaker }
let wasInCall = false;

export const getSession = () => session;
export const sessionJoined = () => !!session && isJoinedTo(session.key, state.voice);

function sync() {
  const joined = sessionJoined();
  if (joined !== wasInCall) {
    wasInCall = joined;
    const b = androidBridge();
    if (b) { b.setInCall(joined); if (joined) b.setSpeaker(session.speaker); }
  }
  if (session && !joined && !session.visible) endSession();
  bus.emit('m:call');
}

export function openSession(params, label) {
  const key = roomKey(params);
  if (session && session.key === key) { session.label = label; return session; }
  if (session) endSession();
  const container = document.createElement('div');
  container.className = 'm-voice-room';
  session = { key, params, label, container, handle: null, visible: false, speaker: true };
  session.handle = mountVoiceChannel(container, { ...params, mobile: true, channelName: params.channelName, dmName: params.dmName });
  bus.emit('m:call');
  return session;
}

export function endSession() {
  const s = session;
  if (!s) return;
  session = null;
  s.handle.leave();
  s.handle.destroy();
  s.container.remove();
  sync();
}

export function setVisible(visible) {
  if (!session) return;
  session.visible = visible;
  sync();
}

export function setSpeaker(on) {
  if (!session) return;
  session.speaker = on;
  androidBridge()?.setSpeaker(on);
  bus.emit('m:call');
}

export function leaveSession() {
  if (!session) return;
  session.handle.leave();
  sync();
}

export function initCallSession() {
  bus.on('state:voice', sync);
}
