export const HISTORY_MAX = 8;

export function parseHistory(raw) {
  try {
    const h = JSON.parse(raw || '[]');
    return Array.isArray(h) ? h.filter((x) => typeof x === 'string').slice(0, HISTORY_MAX) : [];
  } catch { return []; }
}

export function rememberQuery(history, q, max = HISTORY_MAX) {
  const v = String(q).trim();
  if (!v) return history;
  return [v, ...history.filter((h) => h !== v)].slice(0, max);
}

export const fieldsParam = (set) => [...set].join(',');
