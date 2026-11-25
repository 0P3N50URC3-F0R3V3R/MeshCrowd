// Pure helpers for the "Send to MeshCrowd" picker (Android share target and Direct Share shortcuts).

const CHANNEL_TYPES = new Set(['public', 'private', 'announcement']);
export const MAX_RECENTS = 8;

export const dmKey = (dmId) => `dm:${dmId}`;
export const channelKey = (serverId, channelId) => `ch:${serverId}:${channelId}`;

export function parseKey(key) {
  const m = /^(dm):(\d{1,12})$|^(ch):(\d{1,12}):(\d{1,12})$/.exec(String(key || ''));
  if (!m) return null;
  return m[1] ? { kind: 'dm', dmId: Number(m[2]) } : { kind: 'channel', serverId: Number(m[4]), channelId: Number(m[5]) };
}

// dms: [{ id, title, lastId, pinned, hidden, who }]; servers: [{ id, name, server, channels: [{ id, name, type, canSend }] }]
// Returns every place a share can go: recents first, then direct messages, then channels. Channels you cannot write to
// and non-text channels (voice, forum, notes, ...) are left out.
export function buildTargets({ dms = [], servers = [], recents = [] }) {
  const all = [];
  for (const d of [...dms].filter((x) => !x.hidden).sort((a, b) => (Number(!!b.pinned) - Number(!!a.pinned)) || ((b.lastId || 0) - (a.lastId || 0)))) {
    all.push({ key: dmKey(d.id), kind: 'dm', title: d.title, sub: '', section: 'dms', who: d.who });
  }
  for (const s of servers) {
    for (const c of s.channels || []) {
      if (!c.canSend || !CHANNEL_TYPES.has(c.type)) continue;
      all.push({ key: channelKey(s.id, c.id), kind: 'channel', title: `#${c.name}`, sub: s.name, section: 'channels', server: s.server });
    }
  }
  const byKey = new Map(all.map((t) => [t.key, t]));
  const recent = [];
  for (const k of recents) { const t = byKey.get(k); if (t && !recent.includes(t)) recent.push(t); }
  return [...recent.map((t) => ({ ...t, section: 'recent' })), ...all.filter((t) => !recent.includes(t))];
}

export function filterTargets(targets, query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return targets;
  return targets.filter((t) => { const hay = `${t.title} ${t.sub}`.toLowerCase(); return words.every((w) => hay.includes(w)); });
}

// note + (subject when the text does not already contain it) + text, within the message length limit.
export function buildMessage({ text = '', subject = '', note = '' }, max = 15000) {
  const parts = [String(note).trim(), subject && !String(text).includes(subject) ? String(subject).trim() : '', String(text).trim()].filter(Boolean);
  return parts.join('\n').slice(0, max);
}

export function pushRecent(list, key, max = MAX_RECENTS) {
  return [key, ...list.filter((k) => k !== key)].slice(0, max);
}
