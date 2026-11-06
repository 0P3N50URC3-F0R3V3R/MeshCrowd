const STORAGE_KEY = 'dismesh_soundboard_prefs';
const DEFAULTS = { muted: false, volume: 1 };

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

let prefs = load();

export const soundboardPrefs = {
  get: () => ({ ...prefs }),
  set(patch) {
    prefs = { ...prefs, ...patch };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch { /* storage unavailable — keeps the in-memory value for this session */ }
  },
};

// Plays a received soundboard clip honoring the local mute/volume. `baseVolume` is any extra 0-1 gain
// (e.g. the voice output volume); returns the Audio element or null when muted.
export function playSoundboardAudio(url, baseVolume = 1, setup) {
  const { muted, volume } = prefs;
  if (muted || volume <= 0) return null;
  const audio = new Audio(url);
  audio.volume = Math.max(0, Math.min(1, volume * baseVolume));
  if (setup) setup(audio);
  audio.play().catch(() => {});
  return audio;
}
