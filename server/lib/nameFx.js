'use strict';

// Text effects for names (people and roles). The effect is one of EFFECTS; its look can be tuned with up
// to five own colors (a gradient/rainbow made of just those) and a speed in seconds per cycle.
const EFFECTS = ['rainbow', 'gradient', 'glow', 'neon', 'pulse', 'shimmer', 'fire', 'wave'];
const HEX = /^#[0-9a-fA-F]{6}$/;
const MAX_COLORS = 5;
const MIN_SPEED = 0.5;
const MAX_SPEED = 12;

const validEffect = (e) => e === '' || e === null || e === undefined || EFFECTS.includes(e);

// -> { colors: [...], speed } or null when the input is not a usable object.
function cleanFx(input) {
  if (input === null || input === undefined) return { colors: [], speed: 4 };
  if (typeof input !== 'object' || Array.isArray(input)) return null;
  const colors = Array.isArray(input.colors) ? input.colors : [];
  if (colors.length > MAX_COLORS || !colors.every((c) => typeof c === 'string' && HEX.test(c))) return null;
  const speed = input.speed === undefined ? 4 : Number(input.speed);
  if (!Number.isFinite(speed) || speed < MIN_SPEED || speed > MAX_SPEED) return null;
  return { colors: colors.map((c) => c.toLowerCase()), speed };
}

function parseStored(raw) {
  if (!raw) return { colors: [], speed: 4 };
  try { return cleanFx(JSON.parse(raw)) || { colors: [], speed: 4 }; } catch { return { colors: [], speed: 4 }; }
}

module.exports = { EFFECTS, validEffect, cleanFx, parseStored };
