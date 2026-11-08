import { state } from './state.js';
import { bus } from './bus.js';
import { api } from './api.js';

const ACTIVITY = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart', 'pointerdown'];
let started = false;

export function startAutoAway() {
  if (started) return;
  started = true;
  let lastActive = Date.now();
  let autoSet = false;
  let busy = false;

  async function setStatus(status) {
    busy = true;
    try {
      await api.setStatus({ status });
      state.me.status = status;
      bus.emit('state:me');
      return true;
    } catch { return false; } finally { busy = false; }
  }

  async function onActivity() {
    lastActive = Date.now();
    if (autoSet && !busy) {
      autoSet = false;
      if (state.me?.status === 'idle') await setStatus('online');
    }
  }
  for (const ev of ACTIVITY) window.addEventListener(ev, onActivity, { passive: true, capture: true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) onActivity(); });

  setInterval(async () => {
    if (busy || !state.me) return;
    if (autoSet && state.me.status !== 'idle') autoSet = false;
    const limit = Number(state.uiPrefs?.autoAwaySeconds) || 0;
    if (limit <= 0 || autoSet || state.me.status !== 'online') return;
    if (Date.now() - lastActive < limit * 1000) return;
    if (await setStatus('idle')) autoSet = true;
  }, 5000);
}
