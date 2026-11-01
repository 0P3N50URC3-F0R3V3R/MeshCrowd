import { bus } from './bus.js';
import { emptyLog, heartbeat, connected } from './offlineLog.mjs';

const KEY = 'dismesh.offlineLog';
const BEAT_MS = 10000;

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && Array.isArray(raw.windows)) return raw;
  } catch { /* unreadable or blocked storage: start fresh */ }
  return emptyLog();
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(log)); } catch { /* storage blocked */ }
}

// Per-device record of the periods this client had no live socket. The page start itself counts as
// "connecting", so the gap since the last heartbeat is already known before the first chat opens.
let log = connected(load(), Date.now());
let live = false;
save();

bus.on('ws:open', () => { live = true; log = connected(log, Date.now()); save(); });
bus.on('ws:close', () => { live = false; });
bus.on('ws:message', () => { if (live) log = heartbeat(log, Date.now()); });
setInterval(() => { if (live) { log = heartbeat(log, Date.now()); save(); } }, BEAT_MS);
addEventListener('pagehide', () => { if (live) { log = heartbeat(log, Date.now()); save(); } });

export const offlineWindows = () => log.windows;
