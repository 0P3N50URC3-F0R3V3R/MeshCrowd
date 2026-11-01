export const GRACE_MS = 15000;
export const KEEP_MS = 14 * 24 * 3600 * 1000;
const MAX_WINDOWS = 60;

export function emptyLog() {
  return { alive: 0, windows: [] };
}

export function heartbeat(log, now) {
  return { ...log, alive: now };
}

// A gap shorter than GRACE_MS is a reconnect blip, not being offline.
export function connected(log, now) {
  const windows = log.alive && now - log.alive > GRACE_MS ? [...log.windows, [log.alive, now]] : log.windows;
  return { alive: now, windows: windows.filter(([, to]) => now - to < KEEP_MS).slice(-MAX_WINDOWS) };
}

export function wasOffline(windows, ts) {
  return windows.some(([from, to]) => ts > from && ts <= to);
}
