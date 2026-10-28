import { bus } from './bus.js';

// Per-machine voice/video settings (mic/speaker device, gain, push-to-talk). Deliberately
// localStorage-only, never synced to the server: device ids are meaningless across machines,
// and the rest (volume, PTT key) is the kind of thing Discord itself keeps per-install too.
const STORAGE_KEY = 'dismesh_voice_prefs';

const DEFAULTS = {
  inputDeviceId: null,
  outputDeviceId: null,
  inputVolume: 1, // gain multiplier applied to the mic before it's sent to peers, 0-2
  outputVolume: 1, // master multiplier applied on top of each participant's own slider, 0-2
  pttEnabled: false,
  pttKey: 'KeyT', // KeyboardEvent.code
  vadEnabled: false, // voice activation: mic only sends while input level is above vadThreshold
  noiseSuppression: false, // RNNoise neural noise suppression on the mic (loads a ~4.8 MB module when on)
  vadThreshold: 12, // same 0-255 byte-frequency-average scale as the speaking-ring indicator
};

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

let prefs = load();

export function keyLabel(code) {
  if (!code) return '?';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return code;
}

export const voicePrefs = {
  get() {
    return prefs;
  },
  set(patch) {
    prefs = { ...prefs, ...patch };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch { /* storage unavailable — prefs stay in-memory for this tab */ }
    bus.emit('voiceprefs:changed', prefs);
  },
};
