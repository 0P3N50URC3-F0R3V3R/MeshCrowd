'use strict';

// The per-user notification grid: for each presence status and each kind of event, which delivery
// surfaces fire. The user's stored value is only their overrides; everything else is the defaults.

const STATUSES = ['online', 'idle', 'dnd', 'invisible'];
const EVENTS = ['dmMessage', 'dmMention', 'channelMessage', 'channelMention', 'thread', 'call', 'friend', 'pinReminder'];
const SURFACES = ['sound', 'popup', 'tray', 'android'];

// Surfaces with no code path for an event today; the editor shows them disabled.
const NOT_APPLICABLE = { call: ['android'], friend: ['android'] };
const isApplicable = (event, surface) => !(NOT_APPLICABLE[event] || []).includes(surface);

// Matches how presence behaved before the grid existed: busy and invisible stayed silent.
function defaults() {
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

function effective(stored) {
  const grid = defaults();
  if (!stored) return grid;
  for (const s of Object.keys(stored)) {
    if (!grid[s]) continue;
    for (const e of Object.keys(stored[s] || {})) {
      if (!grid[s][e]) continue;
      for (const f of Object.keys(stored[s][e] || {})) {
        if (f in grid[s][e] && typeof stored[s][e][f] === 'boolean') grid[s][e][f] = stored[s][e][f];
      }
    }
  }
  return grid;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Returns the normalized overrides, or throws an Error with a message fit to show the user.
function validate(input) {
  if (!isObject(input)) throw new Error('grid must be an object');
  const out = {};
  for (const [s, events] of Object.entries(input)) {
    if (!STATUSES.includes(s)) throw new Error(`unknown status "${s}"`);
    if (!isObject(events)) throw new Error(`${s} must be an object`);
    out[s] = {};
    for (const [e, cells] of Object.entries(events)) {
      if (!EVENTS.includes(e)) throw new Error(`unknown event "${e}"`);
      if (!isObject(cells)) throw new Error(`${s}.${e} must be an object`);
      out[s][e] = {};
      for (const [f, v] of Object.entries(cells)) {
        if (!SURFACES.includes(f)) throw new Error(`unknown surface "${f}"`);
        if (typeof v !== 'boolean') throw new Error(`${s}.${e}.${f} must be true or false`);
        if (!isApplicable(e, f)) throw new Error(`${e} has no ${f} notifications`);
        out[s][e][f] = v;
      }
    }
  }
  return out;
}

// Earlier versions had one sound mode: 'always' chimed in every status, 'never' in none.
function migrateSoundMode(mode) {
  if (mode !== 'always' && mode !== 'never') return null;
  const sound = mode === 'always';
  const out = {};
  for (const s of STATUSES) {
    out[s] = {};
    for (const e of EVENTS) out[s][e] = { sound };
  }
  return out;
}

// The stored column is JSON text or NULL; anything unreadable counts as no overrides.
function parseStored(text) {
  if (!text) return {};
  try { const v = JSON.parse(text); return isObject(v) ? v : {}; } catch { return {}; }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// { scopeType, kind, mentioned, message, recipient } -> one of EVENTS.
function classify({ scopeType, kind, mentioned, message, recipient }) {
  if (kind === 'pin') return 'pinReminder';
  if (kind === 'thread') return 'thread';
  if (scopeType === 'dm') {
    // Every DM arrives flagged as mentioned, so only an explicit @name counts as a DM mention. An
    // encrypted DM's text is redacted and never inspected.
    const name = recipient && recipient.username;
    if (name && message && !message.isEncrypted && typeof message.content === 'string'
      && new RegExp(`(^|[^a-zA-Z0-9_.])@${escapeRe(name)}(?![a-zA-Z0-9_.])`, 'i').test(message.content)) return 'dmMention';
    return 'dmMessage';
  }
  // A mention wins over the thread it was posted in: someone who asked to be pinged for mentions is.
  if (mentioned) return 'channelMention';
  return message && message.scopeType === 'thread' ? 'thread' : 'channelMessage';
}

// An unknown status or event never blocks anything: a grid problem must not silence a user.
function allows(grid, status, event, surface) {
  const cell = grid && grid[status] && grid[status][event];
  return !cell || cell[surface] !== false;
}

module.exports = { STATUSES, EVENTS, SURFACES, NOT_APPLICABLE, isApplicable, defaults, effective, validate, migrateSoundMode, classify, allows, parseStored };
