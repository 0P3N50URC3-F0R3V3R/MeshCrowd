// Pure model behind the notification grid editor. The lists and defaults mirror
// server/lib/notifyGrid.js; web/js/notifyGridModel.test.mjs fails if the two drift apart.
export const STATUSES = ['online', 'idle', 'dnd', 'invisible'];
export const EVENTS = ['dmMessage', 'dmMention', 'channelMessage', 'channelMention', 'thread', 'call', 'friend', 'pinReminder'];
export const SURFACES = ['sound', 'popup', 'tray', 'android'];
export const NOT_APPLICABLE = { call: ['android'], friend: ['android'] };

export const isApplicable = (event, surface) => !(NOT_APPLICABLE[event] || []).includes(surface);

export function defaultsGrid() {
  const grid = {};
  for (const s of STATUSES) {
    grid[s] = {};
    for (const e of EVENTS) {
      grid[s][e] = {};
      for (const f of SURFACES) grid[s][e][f] = !((s === 'dnd' || s === 'invisible') && f === 'sound');
    }
  }
  return grid;
}

export function isStatusModified(grid, status) {
  const base = defaultsGrid()[status];
  return EVENTS.some((e) => SURFACES.some((f) => grid[status]?.[e]?.[f] !== base[e][f]));
}

// A PUT body that makes `to` look like `from`, skipping cells that do not exist for an event.
export function copyStatusPatch(grid, from, to) {
  const out = {};
  for (const e of EVENTS) {
    out[e] = {};
    for (const f of SURFACES) if (isApplicable(e, f)) out[e][f] = !!grid[from]?.[e]?.[f];
  }
  return { [to]: out };
}
