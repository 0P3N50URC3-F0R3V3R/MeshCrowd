import { escapeHtml } from './utils.js';
import { t } from './i18n.js';
import { icons } from './icons.js';

export const MAX_VOICE_MS = 5 * 60 * 1000;
export const MIN_VOICE_MS = 500;

export function formatClock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// The first recording format this browser can produce, with a file extension the server will serve
// as audio. Chromium, Electron, Android WebView and Firefox record Opus in WebM/Ogg; Safari only MP4.
export function pickRecorderFormat(isSupported = (m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) {
  const options = [
    { mime: 'audio/webm;codecs=opus', ext: 'webm' },
    { mime: 'audio/ogg;codecs=opus', ext: 'ogg' },
    { mime: 'audio/mp4', ext: 'm4a' },
    { mime: 'audio/webm', ext: 'webm' },
  ];
  return options.find((o) => isSupported(o.mime)) || null;
}

export const canRecordVoice = () => !!(navigator.mediaDevices?.getUserMedia && pickRecorderFormat());

// Records one clip. start() asks for the microphone; stop() resolves { file, durationMs }; cancel() drops it.
export class VoiceRecorder {
  constructor({ onTick, onLimit } = {}) {
    this.onTick = onTick;
    this.onLimit = onLimit;
    this.format = pickRecorderFormat();
    this.chunks = [];
    this.stream = null;
    this.recorder = null;
    this.startedAt = 0;
    this.timer = null;
  }

  async start() {
    if (!this.format) throw new Error('recording is not supported here');
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    this.recorder = new MediaRecorder(this.stream, { mimeType: this.format.mime });
    this.recorder.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.recorder.start(250);
    this.startedAt = Date.now();
    this.timer = setInterval(() => {
      const ms = Date.now() - this.startedAt;
      this.onTick?.(ms);
      if (ms >= MAX_VOICE_MS) this.onLimit?.();
    }, 200);
  }

  elapsed() { return this.startedAt ? Date.now() - this.startedAt : 0; }

  release() {
    clearInterval(this.timer);
    this.timer = null;
    for (const track of this.stream?.getTracks() || []) track.stop();
    this.stream = null;
  }

  stop() {
    return new Promise((resolve, reject) => {
      if (!this.recorder || this.recorder.state === 'inactive') { this.release(); reject(new Error('not recording')); return; }
      const durationMs = Math.min(MAX_VOICE_MS, Date.now() - this.startedAt);
      this.recorder.onstop = () => {
        this.release();
        const type = this.format.mime.split(';')[0];
        const blob = new Blob(this.chunks, { type });
        resolve({ file: new File([blob], `voice-message.${this.format.ext}`, { type }), durationMs });
      };
      this.recorder.stop();
    });
  }

  cancel() {
    try { if (this.recorder && this.recorder.state !== 'inactive') { this.recorder.onstop = null; this.recorder.stop(); } } catch { /* already stopped */ }
    this.chunks = [];
    this.release();
  }
}

// ---- playback ----

export function voiceMessageHtml(att) {
  const url = escapeHtml(att.url);
  return `<div class="voice-msg" data-voice-src="${url}" data-voice-ms="${att.voiceMs}">
    <button type="button" class="voice-play" aria-label="${t('voiceMsg.play')}">${icons.play(16)}</button>
    <div class="voice-track"><div class="voice-bar"></div></div>
    <span class="voice-time">${formatClock(att.voiceMs)}</span>
  </div>`;
}

let audio = null;
let active = null;

function reset(el) {
  if (!el) return;
  el.classList.remove('playing');
  el.querySelector('.voice-play').innerHTML = icons.play(16);
  el.querySelector('.voice-bar').style.width = '0%';
  el.querySelector('.voice-time').textContent = formatClock(Number(el.dataset.voiceMs));
}

function toggle(el) {
  if (active === el && audio && !audio.paused) { audio.pause(); el.classList.remove('playing'); el.querySelector('.voice-play').innerHTML = icons.play(16); return; }
  if (active !== el) {
    reset(active);
    if (audio) audio.pause();
    audio = new Audio(el.dataset.voiceSrc);
    active = el;
    const total = Number(el.dataset.voiceMs);
    audio.addEventListener('timeupdate', () => {
      const dur = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration * 1000 : total;
      el.querySelector('.voice-bar').style.width = `${Math.min(100, (audio.currentTime * 1000 / dur) * 100)}%`;
      el.querySelector('.voice-time').textContent = formatClock(audio.currentTime * 1000);
    });
    audio.addEventListener('ended', () => { reset(el); active = null; });
    audio.addEventListener('error', () => { reset(el); active = null; });
  }
  audio.play().then(() => { el.classList.add('playing'); el.querySelector('.voice-play').innerHTML = icons.pause(16); }).catch(() => reset(el));
}

// One delegated listener per message list; only one clip plays at a time.
export function wireVoicePlayers(root) {
  root.addEventListener('click', (e) => {
    const track = e.target.closest('.voice-track');
    const msg = e.target.closest('.voice-msg');
    if (!msg) return;
    if (track && active === msg && audio && Number.isFinite(audio.duration)) {
      const rect = track.getBoundingClientRect();
      audio.currentTime = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * audio.duration;
      return;
    }
    if (e.target.closest('.voice-play') || track) toggle(msg);
  });
}

// A recording bar shown in `host` (an element above the composer) while a clip is being made.
// onSend({file, durationMs}) is awaited; the bar closes after it resolves. Returns { close }.
export async function openRecorderBar(host, { onSend, onError }) {
  const bar = document.createElement('div');
  bar.className = 'voice-recorder';
  bar.innerHTML = `
    <span class="voice-rec-dot"></span>
    <span class="voice-rec-time">0:00</span>
    <span class="voice-rec-hint">${t('voiceMsg.recording')}</span>
    <button type="button" class="btn-icon" data-cancel title="${t('voiceMsg.cancel')}">${icons.trash(18)}</button>
    <button type="button" class="btn-icon voice-rec-send" data-send title="${t('voiceMsg.send')}">${icons.send(18)}</button>`;
  const recorder = new VoiceRecorder({
    onTick: (ms) => { bar.querySelector('.voice-rec-time').textContent = formatClock(ms); },
    onLimit: () => bar.querySelector('[data-send]').click(),
  });
  try {
    await recorder.start();
  } catch (err) {
    recorder.cancel();
    onError?.(err);
    return { close() {} };
  }
  host.appendChild(bar);
  const close = () => { recorder.cancel(); bar.remove(); };
  bar.querySelector('[data-cancel]').addEventListener('click', close);
  bar.querySelector('[data-send]').addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    if (recorder.elapsed() < MIN_VOICE_MS) { close(); return; }
    try {
      const clip = await recorder.stop();
      bar.remove();
      await onSend(clip);
    } catch (err) { bar.remove(); onError?.(err); }
  });
  return { close };
}
