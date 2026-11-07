'use strict';

const { db } = require('../db');

// Per-server cosmetic/feature limits a moderator can put on one member. Stored as a bitmask on the
// server_members row, so they never leave that server.
const FLAGS = {
  name_color: 1 << 0,
  name_effect: 1 << 1,
  stickers: 1 << 2,
  bio_style: 1 << 3,
};
const NAMES = Object.keys(FLAGS);

function toNames(bits) {
  return NAMES.filter((n) => bits & FLAGS[n]);
}

// null when the list holds anything that isn't a known restriction
function fromNames(names) {
  if (!Array.isArray(names)) return null;
  let bits = 0;
  for (const n of names) {
    if (!FLAGS[n]) return null;
    bits |= FLAGS[n];
  }
  return bits;
}

function getBits(serverId, userId) {
  return db.prepare('SELECT restrictions FROM server_members WHERE server_id = ? AND user_id = ?').get(serverId, userId)?.restrictions || 0;
}

function isRestricted(serverId, userId, name) {
  return !!(getBits(serverId, userId) & FLAGS[name]);
}

module.exports = { FLAGS, NAMES, toNames, fromNames, getBits, isRestricted };
