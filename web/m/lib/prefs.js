const key = (k) => `mc_${k}`;

export function getPref(name, fallback) {
  try { const v = localStorage.getItem(key(name)); return v === null ? fallback : v; } catch { return fallback; }
}

export function setPref(name, value) {
  try { if (value === null) localStorage.removeItem(key(name)); else localStorage.setItem(key(name), String(value)); } catch { /* storage unavailable */ }
}
