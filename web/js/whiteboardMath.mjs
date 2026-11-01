export const PALETTE = [
  { id: 'black', hex: '#000000' },
  { id: 'white', hex: '#ffffff' },
  { id: 'red', hex: '#e53935' },
  { id: 'orange', hex: '#fb8c00' },
  { id: 'yellow', hex: '#fdd835' },
  { id: 'green', hex: '#43a047' },
  { id: 'blue', hex: '#1e88e5' },
  { id: 'purple', hex: '#8e24aa' },
];
export const ERASER = 'eraser';
export const WIDTHS = [2, 5, 10];
export const ERASER_SCALE = 4;
export const MAX_POINTS_PER_MESSAGE = 64;
export const MAX_STROKES = 400;
export const MAX_BOARD_POINTS = 60000;
export const SEND_INTERVAL_MS = 40;
export const WIDTH_UNIT = 1000;

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const round4 = (v) => Math.round(v * 10000) / 10000;

export function toNormalized(clientX, clientY, rect) {
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  return [round4(clamp01((clientX - rect.left) / rect.width)), round4(clamp01((clientY - rect.top) / rect.height))];
}

export function strokePixelWidth(width, tool, canvasWidth) {
  return Math.max(1, (width / WIDTH_UNIT) * canvasWidth * (tool === ERASER ? ERASER_SCALE : 1));
}

export function colorHex(id) {
  return PALETTE.find((c) => c.id === id)?.hex ?? null;
}

export function createBatcher({ maxPoints = MAX_POINTS_PER_MESSAGE, minDist = 0.0015 } = {}) {
  let pending = [];
  let lastX = null;
  let lastY = null;
  return {
    add(x, y) {
      if (lastX !== null && Math.hypot(x - lastX, y - lastY) < minDist) return false;
      pending.push(x, y);
      lastX = x;
      lastY = y;
      return true;
    },
    take() {
      if (pending.length === 0) return null;
      const n = Math.min(pending.length, maxPoints * 2);
      const out = pending.slice(0, n);
      pending = pending.slice(n);
      return out;
    },
    hasPending() { return pending.length > 0; },
    reset() { pending = []; lastX = null; lastY = null; },
  };
}

// Draws `points` (flat normalized x,y list) continuing from `prev` ([x,y] or null); returns the new last point.
export function drawPoints(ctx, stroke, points, w, h, prev) {
  if (points.length === 0) return prev;
  const erase = stroke.color === ERASER;
  const hex = erase ? '#000000' : colorHex(stroke.color);
  if (!hex) return prev;
  const lw = strokePixelWidth(stroke.width, erase ? ERASER : 'pen', w);
  ctx.save();
  ctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
  ctx.strokeStyle = hex;
  ctx.fillStyle = hex;
  ctx.lineWidth = lw;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  let px = prev ? prev[0] : null;
  let py = prev ? prev[1] : null;
  for (let i = 0; i < points.length; i += 2) {
    const x = points[i];
    const y = points[i + 1];
    if (px === null) {
      ctx.beginPath();
      ctx.arc(x * w, y * h, lw / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(px * w, py * h);
      ctx.lineTo(x * w, y * h);
      ctx.stroke();
    }
    px = x;
    py = y;
  }
  ctx.restore();
  return [px, py];
}

export function createStore() {
  const strokes = [];
  let total = 0;
  const byId = new Map();
  function evict() {
    while (strokes.length > MAX_STROKES || (total > MAX_BOARD_POINTS && strokes.length > 1)) {
      const old = strokes.shift();
      byId.delete(old.id);
      total -= old.points.length / 2;
    }
  }
  const store = {
    strokes,
    append({ strokeId, color, width, points }) {
      let s = byId.get(strokeId);
      const fresh = !s;
      if (!s) {
        s = { id: strokeId, color, width, points: [] };
        strokes.push(s);
        byId.set(strokeId, s);
      }
      const prev = s.points.length ? [s.points[s.points.length - 2], s.points[s.points.length - 1]] : null;
      for (const v of points) s.points.push(v);
      total += points.length / 2;
      evict();
      return { stroke: s, prev, fresh };
    },
    replace(list) {
      store.clear();
      for (const s of list) store.append(s);
    },
    clear() { strokes.length = 0; byId.clear(); total = 0; },
    size() { return strokes.length; },
  };
  return store;
}

export function newStrokeId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.slice(0, 24);
}
