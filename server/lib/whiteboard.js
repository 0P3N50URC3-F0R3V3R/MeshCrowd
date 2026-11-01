'use strict';

const PALETTE = ['black', 'white', 'red', 'orange', 'yellow', 'green', 'blue', 'purple'];
const ERASER = 'eraser';
const WIDTHS = [2, 5, 10];
const MAX_POINTS_PER_MESSAGE = 64;
const MAX_POINTS_PER_STROKE = 4000;
const MAX_STROKES = 400;
const MAX_BOARD_POINTS = 60000;
const MAX_STROKE_ID_LENGTH = 24;
const RATE_BURST = 100;
const RATE_PER_SECOND = 50;

const boards = new Map(); // roomId -> { strokes: Array<{ id, userId, color, width, points }>, total: number }
const buckets = new Map(); // `${roomId}:${userId}` -> { tokens, at }

function board(roomId) {
  if (!boards.has(roomId)) boards.set(roomId, { strokes: [], total: 0 });
  return boards.get(roomId);
}

function takeToken(roomId, userId, now) {
  const key = `${roomId}:${userId}`;
  const b = buckets.get(key) || { tokens: RATE_BURST, at: now };
  b.tokens = Math.min(RATE_BURST, b.tokens + ((now - b.at) / 1000) * RATE_PER_SECOND);
  b.at = now;
  buckets.set(key, b);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

function cleanPoints(points) {
  if (!Array.isArray(points) || points.length === 0 || points.length % 2 !== 0) return null;
  if (points.length > MAX_POINTS_PER_MESSAGE * 2) return null;
  const out = new Array(points.length);
  for (let i = 0; i < points.length; i++) {
    const v = points[i];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) return null;
    out[i] = Math.round(v * 10000) / 10000;
  }
  return out;
}

function evict(b) {
  while (b.strokes.length > MAX_STROKES || (b.total > MAX_BOARD_POINTS && b.strokes.length > 1)) {
    const old = b.strokes.shift();
    b.total -= old.points.length / 2;
  }
}

// ctx: { participant, canDraw } — computed by the caller from live voice/stage state, never from the client.
function applyStroke(roomId, userId, msg, ctx, now = Date.now()) {
  if (!ctx.participant) return { ok: false, reason: 'not_participant' };
  if (!ctx.canDraw) return { ok: false, reason: 'forbidden' };
  if (!msg || typeof msg !== 'object') return { ok: false, reason: 'invalid' };
  const { strokeId, color, width } = msg;
  if (typeof strokeId !== 'string' || strokeId.length === 0 || strokeId.length > MAX_STROKE_ID_LENGTH || !/^[A-Za-z0-9_-]+$/.test(strokeId)) {
    return { ok: false, reason: 'invalid' };
  }
  if (color !== ERASER && !PALETTE.includes(color)) return { ok: false, reason: 'invalid' };
  if (!WIDTHS.includes(width)) return { ok: false, reason: 'invalid' };
  const points = cleanPoints(msg.points);
  if (!points) return { ok: false, reason: 'invalid' };
  if (!takeToken(roomId, userId, now)) return { ok: false, reason: 'rate_limited' };

  const b = board(roomId);
  let stroke = null;
  for (let i = b.strokes.length - 1; i >= 0; i--) {
    if (b.strokes[i].id === strokeId) { stroke = b.strokes[i]; break; }
  }
  if (stroke) {
    if (stroke.userId !== userId || stroke.color !== color || stroke.width !== width) return { ok: false, reason: 'invalid' };
    if (stroke.points.length / 2 + points.length / 2 > MAX_POINTS_PER_STROKE) return { ok: false, reason: 'invalid' };
    for (const v of points) stroke.points.push(v);
  } else {
    stroke = { id: strokeId, userId, color, width, points };
    b.strokes.push(stroke);
  }
  b.total += points.length / 2;
  evict(b);
  return { ok: true, payload: { strokeId, userId, color, width, points } };
}

function applyClear(roomId, userId, ctx, now = Date.now()) {
  if (!ctx.participant) return { ok: false, reason: 'not_participant' };
  if (!ctx.canClear) return { ok: false, reason: 'forbidden' };
  if (!takeToken(roomId, userId, now)) return { ok: false, reason: 'rate_limited' };
  boards.delete(roomId);
  return { ok: true };
}

function snapshot(roomId, ctx) {
  if (!ctx.participant) return null;
  const b = boards.get(roomId);
  return (b ? b.strokes : []).map((s) => ({ strokeId: s.id, userId: s.userId, color: s.color, width: s.width, points: s.points.slice() }));
}

function dropBoard(roomId) {
  boards.delete(roomId);
  const prefix = `${roomId}:`;
  for (const key of buckets.keys()) if (key.startsWith(prefix)) buckets.delete(key);
}

function strokeCount(roomId) {
  return boards.get(roomId)?.strokes.length ?? 0;
}

function canDraw({ isStage, isSpeaker, canManage }) {
  return !isStage || isSpeaker || canManage;
}

function canClear({ isStage, isSpeaker, canManage }) {
  return canManage || (isStage && isSpeaker);
}

module.exports = {
  PALETTE, ERASER, WIDTHS, MAX_POINTS_PER_MESSAGE, MAX_POINTS_PER_STROKE, MAX_STROKES, MAX_BOARD_POINTS,
  applyStroke, applyClear, snapshot, dropBoard, strokeCount, canDraw, canClear,
};
