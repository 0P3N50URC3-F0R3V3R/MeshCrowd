import { bus } from './bus.js';

// Per-device sound-notification prefs, same localStorage-only pattern as voicePrefs.js — not
// something that makes sense to sync across machines.
const STORAGE_KEY = 'dismesh_notif_sound_prefs';

const DEFAULTS = {
  enabled: true,
  volume: 0.5, // 0-1
  playWhenFocused: false, // also chime for messages in the conversation you're already looking at
  useCustom: false, // play the user's own uploaded clip (see setCustom) instead of the built-in chime
  customName: '',
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
let audioCtx = null;

// Optional user-supplied sound (any format this browser can decode: ogg, wav, mp3, mp4/m4a, webm,
// flac...). Stored per device as a Blob in IndexedDB — localStorage is far too small for audio and,
// like the other prefs here, it is never uploaded anywhere.
export const CUSTOM_MAX_BYTES = 2 * 1024 * 1024;
export const CUSTOM_MAX_SECONDS = 10;
const DB_NAME = 'dismesh_notif_sound';
const STORE = 'custom';
let customUrl = null;
let customReady = null;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbOp(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally { db.close(); }
}

function useBlob(blob) {
  if (customUrl) URL.revokeObjectURL(customUrl);
  customUrl = blob ? URL.createObjectURL(blob) : null;
}

function loadCustom() {
  customReady = customReady || dbOp('readonly', (st) => st.get('file')).then(useBlob).catch(() => {});
  return customReady;
}

// Resolves with the clip's duration in seconds, or rejects if the browser cannot decode it.
function probe(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const a = new Audio();
    const done = (fn, v) => { URL.revokeObjectURL(url); fn(v); };
    a.preload = 'metadata';
    a.onloadedmetadata = () => done(resolve, a.duration);
    a.onerror = () => done(reject, new Error('undecodable'));
    a.src = url;
  });
}

function playTone(ctx, freq, startAt, duration, peakGain) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.linearRampToValueAtTime(peakGain, startAt + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(startAt);
  osc.stop(startAt + duration);
}

export const notifySound = {
  get() {
    return prefs;
  },
  set(patch) {
    prefs = { ...prefs, ...patch };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch { /* storage unavailable — prefs stay in-memory for this tab */ }
    bus.emit('notifysound:changed', prefs);
  },
  // Throws an Error whose message is 'tooLarge' | 'tooLong' | 'undecodable' | 'storage'.
  async setCustom(file) {
    if (file.size > CUSTOM_MAX_BYTES) throw new Error('tooLarge');
    const duration = await probe(file);
    if (!(duration <= CUSTOM_MAX_SECONDS)) throw new Error(Number.isFinite(duration) ? 'tooLong' : 'undecodable');
    try {
      await dbOp('readwrite', (st) => st.put(file, 'file'));
    } catch { throw new Error('storage'); }
    customReady = Promise.resolve();
    useBlob(file);
    this.set({ useCustom: true, customName: file.name });
  },
  async clearCustom() {
    try { await dbOp('readwrite', (st) => st.delete('file')); } catch { /* nothing stored */ }
    customReady = Promise.resolve();
    useBlob(null);
    this.set({ useCustom: false, customName: '' });
  },
  hasCustom() {
    return !!customUrl;
  },
  ready: loadCustom,
  // Default is a two-tone chime synthesized on the fly — no bundled audio asset to ship or self-host.
  play() {
    if (!prefs.enabled || prefs.volume <= 0) return;
    if (prefs.useCustom && customUrl) {
      const a = new Audio(customUrl);
      a.volume = prefs.volume;
      a.play().catch(() => this.playChime());
      return;
    }
    this.playChime();
  },
  playChime() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const now = audioCtx.currentTime;
      const peak = prefs.volume * 0.2;
      playTone(audioCtx, 740, now, 0.12, peak);
      playTone(audioCtx, 988, now + 0.09, 0.16, peak);
    } catch { /* Web Audio unavailable — silently skip the sound */ }
  },
};

loadCustom();
